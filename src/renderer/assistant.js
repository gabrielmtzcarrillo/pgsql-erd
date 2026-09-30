// The Assistant tab and the AI provider settings dialog. Requests go to
// the main process, which builds the context the user allowed, talks to the
// provider and runs tools; API keys never reach this page. Scripts the
// assistant writes open in the editor unsaved, for review — nothing it
// produces runs on its own.

import { schemaFromErd } from '../shared/schema-model.js';
import { codeBlocks, DEFAULT_CONTEXT_OPTIONS } from '../shared/context-builder.js';
import { AI_PERMISSION_LABELS, DEFAULT_AI_PERMISSIONS, normalizeAiPermissions } from '../shared/permissions.js';
import { SCRIPT_TYPES } from '../shared/scripts.js';
import { decorateButton, decorateButtons } from './icons.js';
import { tr, trn } from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);
const PREFS_KEY = 'pgsql-erd.ai';

const CONTEXT_LABELS = {
  selectedTables: tr('Selected / mentioned tables'),
  relatedTables: tr('Related tables'),
  relationships: tr('Relationships'),
  constraints: tr('Constraints & indexes'),
  entireSchema: tr('Entire schema'),
  currentScript: tr('Current script'),
  validationErrors: tr('Validation errors'),
  rowSamples: tr('Row samples (data)'),
};

const QUICK = [
  [tr('Explain'), tr('Explain what the selected tables store and how they relate.')],
  [tr('Validator'), tr('Create a validator that checks ')],
  [tr('Test data'), tr('Create a generator that inserts 50 realistic rows into ')],
  [tr('Review schema'), tr('Review the schema: find missing indexes on foreign keys, suspicious nullable columns and naming inconsistencies.')],
  [tr('Fix script'), tr('The current script has problems. Fix it and explain the changes.')],
];

export function setupAssistant(ctx, workbench) {
  const { host, h, status, db } = ctx;
  let providers = [];
  let secureStorage = false;
  let types = {};
  const prefs = loadPrefs();
  let conversation = []; // { role, content }
  let pending = null; // { requestId, el, text }
  let shareRowsConfirmed = null; // provider id the user agreed to share rows with

  function loadPrefs() {
    let p = {};
    try {
      p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    } catch {
      p = {};
    }
    return {
      provider: p.provider ?? 'local-ollama',
      model: p.model ?? '',
      context: { ...DEFAULT_CONTEXT_OPTIONS, ...(p.context ?? {}) },
      permissions: normalizeAiPermissions(p.permissions ?? DEFAULT_AI_PERMISSIONS),
      useTools: p.useTools ?? true,
    };
  }

  let saveTimer = null;
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // not remembered
    }
    // Projects keep their assistant settings in pgsql-erd.json (no secrets).
    clearTimeout(saveTimer);
    if (workbench.project().dir)
      saveTimer = setTimeout(
        () => host.project.saveSettings({ ai: { provider: prefs.provider, model: prefs.model, permissions: prefs.permissions } }).catch(() => {}),
        800
      );
  }

  const call = async (fn, ...args) => {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };

  const provider = () => providers.find((p) => p.id === prefs.provider) ?? null;

  // ------------------------------------------------------------ config bar

  const providerSelect = $('#ai-provider');
  const modelInput = $('#ai-model');

  async function loadProviders() {
    try {
      const list = await call(host.ai.providers);
      providers = list.providers;
      secureStorage = list.secureStorage;
      types = list.types;
    } catch (err) {
      providers = [];
      status(err.message);
    }
    if (!provider() && providers.length) prefs.provider = providers[0].id;
    providerSelect.replaceChildren(...providers.map((p) => h('option', { value: p.id }, `${p.name}${p.local ? '' : ` ${tr('(remote)')}`}`)));
    providerSelect.value = prefs.provider;
    modelInput.value = prefs.model;
    renderSharing();
  }

  async function loadModels({ quiet = false } = {}) {
    const list = $('#ai-model-list');
    if (!provider()) return;
    try {
      const models = await call(host.ai.models, prefs.provider);
      list.replaceChildren(...models.map((m) => h('option', { value: m.id })));
      if (!prefs.model && models[0]) {
        prefs.model = models[0].id;
        modelInput.value = prefs.model;
        savePrefs();
      }
      if (!quiet) status(trn(models.length, '{n} model on {provider}', '{n} models on {provider}', { provider: provider().name }));
    } catch (err) {
      list.replaceChildren();
      if (!quiet) status(`${provider().name}: ${err.message}`);
    }
  }

  providerSelect.addEventListener('change', () => {
    prefs.provider = providerSelect.value;
    prefs.model = '';
    modelInput.value = '';
    shareRowsConfirmed = null;
    savePrefs();
    renderSharing();
    loadModels();
  });
  modelInput.addEventListener('change', () => {
    prefs.model = modelInput.value.trim();
    savePrefs();
  });
  $('#ai-models-refresh').addEventListener('click', () => loadModels());

  // ------------------------------------------------------------ options

  function renderOptions() {
    $('#ai-context').replaceChildren(
      ...Object.entries(CONTEXT_LABELS).map(([k, label]) => {
        const cb = h('input', { type: 'checkbox', checked: !!prefs.context[k] });
        cb.addEventListener('change', () => {
          prefs.context[k] = cb.checked;
          if (k === 'rowSamples' && cb.checked && !prefs.permissions.readData) {
            prefs.permissions.readData = true;
            renderOptions();
          }
          savePrefs();
          renderSharing();
        });
        return h('label', { class: `check${k === 'rowSamples' ? ' data' : ''}` }, [cb, label]);
      })
    );
    const perms = Object.entries(AI_PERMISSION_LABELS).map(([k, label]) => {
      const locked = k === 'executeWrites' || k === 'executeDDL';
      const cb = h('input', { type: 'checkbox', checked: !!prefs.permissions[k], disabled: locked });
      cb.addEventListener('change', () => {
        prefs.permissions[k] = cb.checked;
        savePrefs();
        renderSharing();
      });
      return h('label', { class: 'check', title: locked ? tr('Not available to the assistant: it writes scripts, you run them.') : '' }, [cb, tr(label)]);
    });
    const tools = h('input', { type: 'checkbox', checked: prefs.useTools });
    tools.addEventListener('change', () => {
      prefs.useTools = tools.checked;
      savePrefs();
    });
    $('#ai-perms').replaceChildren(...perms, h('label', { class: 'check', title: tr('Lets the model look up tables, check scripts and propose them') }, [tools, tr('Use tools')]));
  }

  // Row data may reach the model through samples, queries or validator results.
  const mayShareRows = () =>
    db.connected() && prefs.permissions.readData && (prefs.context.rowSamples || prefs.permissions.executeSelect || prefs.permissions.executeScripts);

  function renderSharing() {
    const p = provider();
    const el = $('#ai-sharing');
    const rows = mayShareRows();
    const where = p ? (p.local ? tr('local') : tr('remote')) : tr('no provider');
    el.textContent = `${where} · ${rows ? tr('schema + row data') : tr('schema only')}`;
    el.className = `ai-sharing ${rows ? (p?.local ? 'data' : 'data remote') : ''}`;
    el.title = rows
      ? p?.local
        ? tr('Row data may be sent to this local model.')
        : tr('Row data may be sent to {url}. You will be asked to confirm.', { url: p?.baseUrl })
      : tr('Only the schema (table and column definitions) is sent.');
  }

  $('#ai-quick').replaceChildren(
    ...QUICK.map(([label, text]) =>
      h('button', { type: 'button', class: 'chip', onclick: () => {
        const ta = $('#ai-prompt');
        ta.value = text;
        ta.focus();
        ta.setSelectionRange(text.length, text.length);
      } }, label)
    )
  );

  // ------------------------------------------------------------ conversation

  const log = $('#ai-log');

  function renderEmpty() {
    if (conversation.length) return;
    log.replaceChildren(
      h('div', { class: 'ai-empty' }, [
        h('strong', {}, tr('Ask about your database or describe a script.')),
        h('p', {}, tr('The assistant sees the tables you select in the diagram or name in your question, and writes TypeScript scripts you review, dry-run and commit yourself.')),
      ])
    );
  }

  function addMessage(role, content) {
    if (!conversation.length) log.replaceChildren();
    const el = h('div', { class: `ai-msg ${role}` });
    if (role === 'user') el.append(h('div', { class: 'ai-text' }, content));
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  // Markdown-lite: fenced code blocks with actions, `code`, **bold**, paragraphs.
  function renderReply(el, text, meta = {}) {
    el.replaceChildren();
    const parts = String(text).split(/(```[^\n]*\n[\s\S]*?```)/g);
    for (const part of parts) {
      if (!part) continue;
      const block = codeBlocks(part)[0];
      if (block && part.startsWith('```')) el.append(codeCard(block, meta));
      else if (part.trim()) el.append(prose(part));
    }
    if (meta.rowData) el.append(h('div', { class: 'ai-meta data' }, tr('This answer used row data.')));
  }

  function prose(text) {
    const div = h('div', { class: 'ai-text' });
    for (const para of text.trim().split(/\n{2,}/)) {
      const p = h('p');
      for (const seg of para.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
        if (!seg) continue;
        if (seg.startsWith('`')) p.append(h('code', {}, seg.slice(1, -1)));
        else if (seg.startsWith('**')) p.append(h('strong', {}, seg.slice(2, -2)));
        else p.append(seg);
      }
      div.append(p);
    }
    return div;
  }

  function guessType(prompt, code) {
    const t = `${prompt} ${code}`;
    if (/validate\(/.test(code) || /validat|validador/i.test(prompt)) return 'validator';
    if (/seed\.fill|faker\.|insert/i.test(code) && /(generat|generador|test data|fake|synthetic|datos de prueba|ficticios)/i.test(t)) return 'generator';
    if (/\.insert(Many)?\(/.test(code)) return 'seeder';
    if (/ALTER|CREATE|DROP/i.test(code) && /db\.query/.test(code)) return 'migration';
    return 'query';
  }

  function codeCard(block, meta) {
    const isScript = ['ts', 'typescript', 'js', 'javascript', ''].includes(block.lang);
    const pre = h('pre', { class: 'ai-code' }, block.code);
    const btn = (label, icon, fn, cls = '') => decorateButton(h('button', { type: 'button', class: cls, onclick: fn }, label), icon);
    const actions = [];
    if (isScript) {
      actions.push(
        btn(tr('New script'), 'script-new', () => {
          const type = guessType(meta.prompt ?? '', block.code);
          workbench.newFromCode({ name: suggestName(meta.prompt, type), type, source: block.code });
        }, 'primary'),
        btn(tr('Replace current'), 'reset', () => workbench.replaceCode(block.code)),
        btn(tr('Insert'), 'insert', () => workbench.insertCode(block.code))
      );
    }
    if (block.lang === 'sql' || block.lang === 'postgresql' || block.lang === 'pgsql')
      actions.push(btn(tr('Open in Query tab'), 'toggle-sql', () => ctx.openSql(block.code), 'primary'));
    actions.push(btn(tr('Copy'), 'copy', async () => {
      await navigator.clipboard.writeText(block.code);
      status(tr('Copied'));
    }));
    return h('div', { class: 'ai-code-card' }, [h('div', { class: 'ai-code-head' }, [h('span', { class: 'muted' }, block.lang || tr('code')), h('span', { class: 'grow' }), ...actions]), pre]);
  }

  function suggestName(prompt, type) {
    const words = String(prompt ?? '')
      .replace(/^(please\s+|por favor,?\s+)?(create|write|make|generate|build|crea|escribe|haz|genera|construye)\s+(a|an|un|una)?\s*/i, '')
      .split(/\s+/)
      .slice(0, 6)
      .join(' ');
    return words || `assistant ${type}`;
  }

  function proposalCard(p) {
    const errs = (p.diagnostics ?? []).filter((d) => d.severity === 'error').length;
    const check = errs ? h('span', { class: 'tag error' }, trn(errs, '{n} type error', '{n} type errors')) : h('span', { class: 'tag ok' }, tr('type-checks'));
    const open = p.action === 'create'
      ? decorateButton(h('button', { type: 'button', class: 'primary', onclick: () => workbench.newFromCode(p) }, tr('Open in editor')), 'script-new')
      : decorateButton(h('button', { type: 'button', class: 'primary', onclick: () => workbench.replaceCode(p.source) }, tr('Apply to current script')), 'ok');
    return h('div', { class: 'ai-proposal' }, [
      h('div', { class: 'ai-proposal-head' }, [
        h('strong', {}, p.action === 'create' ? `${tr('New script ({type}):', { type: tr(SCRIPT_TYPES[p.type]?.label ?? p.type).toLowerCase() })} ${p.name}` : tr('Change to the current script')),
        check,
      ]),
      p.description || p.summary ? h('div', { class: 'muted small' }, p.description || p.summary) : null,
      h('details', {}, [h('summary', {}, tr('Show code')), h('pre', { class: 'ai-code' }, p.source)]),
      h('div', { class: 'ai-proposal-actions' }, [open]),
    ]);
  }

  host.ai.onEvent((e) => {
    if (!pending || e.requestId !== pending.requestId) return;
    const el = pending.el;
    switch (e.type) {
      case 'context':
        pending.meta.rowData = e.rowData;
        $('#ai-context-info').textContent = `${e.tables.length ? `${tr('Context:')} ${e.tables.join(', ')}` : tr('No tables in context')}${e.rowData ? ` · ${tr('with row data')}` : ''}`;
        break;
      case 'token':
        pending.text += e.text;
        pending.stream.textContent = pending.text;
        log.scrollTop = log.scrollHeight;
        break;
      case 'tool':
        // Keep what the model said before calling the tool.
        if (pending.text.trim()) el.insertBefore(prose(pending.text), pending.stream);
        pending.text = '';
        pending.stream.textContent = '';
        el.insertBefore(h('div', { class: 'ai-tool' }, `⚙ ${e.name}(${formatArgs(e.args)})`), pending.stream);
        break;
      case 'tool-result':
        if (!e.ok) el.insertBefore(h('div', { class: 'ai-tool error' }, e.preview), pending.stream);
        break;
      case 'proposal':
        pending.proposals.push(e.proposal);
        el.insertBefore(proposalCard(e.proposal), pending.stream);
        break;
      case 'notice':
        el.insertBefore(h('div', { class: 'ai-tool' }, e.text), pending.stream);
        break;
    }
  });

  function formatArgs(args) {
    const s = Object.entries(args ?? {})
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v)}`)
      .join(', ');
    return s;
  }

  async function send() {
    const ta = $('#ai-prompt');
    const prompt = ta.value.trim();
    if (!prompt || pending) return;
    const p = provider();
    if (!p) return openSettings();
    if (!prefs.model) {
      await loadModels({ quiet: true });
      if (!prefs.model) return status(tr('Choose a model first (type its name, or set up the provider).'));
    }
    let shareRows = shareRowsConfirmed === p.id;
    if (mayShareRows() && !p.local && !shareRows) {
      const choice = await host.confirm({
        message: tr('Share row data with {provider}?', { provider: p.name }),
        detail: tr('{url} is a remote service. With the current settings the assistant may send rows from {db} to it (samples, query results, validator output).', { url: p.baseUrl, db: db.info()?.description ?? tr('the database') }) +
          `\n\n${tr('Choose "Schema Only" to send table definitions only.')}`,
        buttons: [tr('Share Row Data'), tr('Schema Only'), tr('Cancel')],
      });
      if (choice === 2) return;
      shareRows = choice === 0;
      if (shareRows) shareRowsConfirmed = p.id;
    }
    const context = { ...prefs.context };
    if (!shareRows && !p.local) context.rowSamples = false;

    ta.value = '';
    addMessage('user', prompt);
    const el = addMessage('assistant');
    const stream = h('div', { class: 'ai-stream' }, '…');
    el.append(stream);
    const requestId = `ai-${Date.now()}`;
    pending = { requestId, el, stream, text: '', proposals: [], meta: { prompt } };
    setBusy(true);
    const current = workbench.current();
    try {
      const res = await call(host.ai.chat, {
        requestId,
        providerId: p.id,
        model: prefs.model,
        prompt,
        history: conversation,
        selection: ctx.selectedTableIds(),
        contextOptions: context,
        permissions: prefs.permissions,
        shareRows,
        useTools: prefs.useTools,
        script: current.source.trim() ? current : null,
        validationErrors: workbench.validationErrors(),
        diagramSchema: db.connected() ? null : schemaFromErd(ctx.state.model),
      });
      pending.stream.remove();
      const reply = h('div');
      renderReply(reply, res.content || (pending.proposals.length ? '' : tr('(no answer)')), { ...pending.meta, rowData: res.rowData });
      el.append(reply);
      conversation.push({ role: 'user', content: prompt }, { role: 'assistant', content: res.content });
    } catch (err) {
      pending.stream.remove();
      el.append(h('div', { class: 'ai-error' }, err.message));
      el.classList.add('error');
    } finally {
      pending = null;
      setBusy(false);
      log.scrollTop = log.scrollHeight;
    }
  }

  function setBusy(busy) {
    $('#ai-send').disabled = busy;
    $('#ai-stop').disabled = !busy;
  }

  $('#ai-send').addEventListener('click', send);
  $('#ai-stop').addEventListener('click', () => host.ai.cancel());
  $('#ai-clear').addEventListener('click', () => {
    if (pending) return;
    conversation = [];
    renderEmpty();
    $('#ai-context-info').textContent = '';
  });
  $('#ai-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  // ------------------------------------------------------------ settings dialog

  const dialog = $('#ai-settings-dialog');
  const form = $('#ai-settings-form');
  let editing = null; // provider id or null for a new one

  function renderProviderList() {
    $('#ai-provider-list').replaceChildren(
      ...providers.map((p) =>
        h('label', { class: `item${p.id === editing ? ' active' : ''}`, onclick: () => editProvider(p.id) }, [
          h('span', { class: 'grow' }, p.name),
          h('span', { class: 'tag' }, `${p.type}${p.hasKey ? ` · ${tr('key')}` : ''}${p.local ? '' : ` · ${tr('remote')}`}`),
        ])
      )
    );
  }

  function editProvider(id) {
    editing = id;
    const p = providers.find((x) => x.id === id);
    const f = form.elements;
    f.type.replaceChildren(...Object.entries(types).map(([k, v]) => h('option', { value: k }, v.label)));
    f.name.value = p?.name ?? '';
    f.type.value = p?.type ?? 'openai-compatible';
    f.baseUrl.value = p?.baseUrl ?? types[f.type.value]?.defaultUrl ?? '';
    f.apiKey.value = '';
    f.apiKey.placeholder = p?.hasKey ? `•••••••• ${tr('(stored — leave empty to keep)')}` : tr('(none)');
    f.clearKey.checked = false;
    f.clearKey.parentElement.hidden = !p?.hasKey;
    $('#ai-provider-delete').disabled = !p;
    $('#ai-provider-where').textContent = secureStorage
      ? tr('Keys are encrypted with the system credential store.')
      : tr('No system credential store is available: keys are kept in memory until the app quits.');
    setDialogStatus('');
    renderProviderList();
  }

  function setDialogStatus(text, kind = '') {
    const el = $('#ai-provider-status');
    el.textContent = text;
    el.className = `db-status ${kind}`;
  }

  form.elements.type.addEventListener('change', () => {
    const f = form.elements;
    const defaults = Object.values(types).map((t) => t.defaultUrl);
    if (!f.baseUrl.value || defaults.includes(f.baseUrl.value)) f.baseUrl.value = types[f.type.value].defaultUrl;
  });

  async function saveProvider() {
    const f = form.elements;
    const config = { id: editing ?? undefined, name: f.name.value.trim() || types[f.type.value].label, type: f.type.value, baseUrl: f.baseUrl.value.trim() };
    const key = f.clearKey.checked ? '' : f.apiKey.value ? f.apiKey.value : undefined;
    const res = await call(host.ai.saveProvider, config, key);
    f.apiKey.value = '';
    providers = res.providers;
    editing = res.id;
    await loadProviders();
    editProvider(res.id);
    return res.id;
  }

  $('#ai-provider-save').addEventListener('click', async () => {
    try {
      await saveProvider();
      setDialogStatus(tr('Saved'), 'ok');
    } catch (err) {
      setDialogStatus(err.message, 'error');
    }
  });
  $('#ai-provider-test').addEventListener('click', async () => {
    try {
      setDialogStatus(tr('Connecting…'));
      const id = await saveProvider();
      const models = await call(host.ai.models, id);
      setDialogStatus(`${tr('OK')} — ${trn(models.length, '{n} model', '{n} models')}: ${models.slice(0, 12).map((m) => m.id).join(', ')}${models.length > 12 ? ', …' : ''}`, 'ok');
    } catch (err) {
      setDialogStatus(err.message, 'error');
    }
  });
  $('#ai-provider-delete').addEventListener('click', async () => {
    const p = providers.find((x) => x.id === editing);
    if (!p) return;
    const choice = await host.confirm({
      message: tr('Delete the provider "{name}"?', { name: p.name }),
      detail: tr('Its stored API key is removed too.'),
      buttons: [tr('Delete'), tr('Cancel')],
    });
    if (choice !== 0) return;
    await call(host.ai.deleteProvider, p.id);
    await loadProviders();
    editProvider(providers[0]?.id ?? null);
  });
  $('#ai-provider-add').addEventListener('click', () => editProvider(null));

  async function openSettings() {
    await loadProviders();
    editProvider(prefs.provider);
    dialog.showModal();
  }
  dialog.addEventListener('close', () => {
    loadProviders();
    loadModels({ quiet: true });
  });

  // ------------------------------------------------------------ project settings

  workbench.onChange(async (what, value) => {
    if (what === 'project' && value.settings?.ai) {
      const ai = value.settings.ai;
      if (ai.provider) prefs.provider = ai.provider;
      if (ai.model) prefs.model = ai.model;
      if (ai.permissions) prefs.permissions = normalizeAiPermissions(ai.permissions);
      providerSelect.value = prefs.provider;
      modelInput.value = prefs.model;
      renderOptions();
      renderSharing();
    }
  });
  ctx.tabs.onShow(async (name) => {
    if (name !== 'assistant') return;
    if (!providers.length) await loadProviders();
    loadModels({ quiet: true });
    setTimeout(() => $('#ai-prompt').focus(), 0);
  });
  ctx.events.addEventListener('connection', renderSharing);

  decorateButtons($('#assistant-page'));
  renderOptions();
  renderEmpty();
  loadProviders();

  return {
    // Open the Assistant tab with a prompt ready to send (e.g. from the Query tab).
    ask(prompt) {
      ctx.tabs.show('assistant');
      const ta = $('#ai-prompt');
      ta.value = prompt;
      ta.focus();
    },
    // AI settings for a script run, or null when none is set up. A script
    // that calls ai.* may send rows to the provider, so a remote one needs
    // the user's agreement (once per provider, shared with the chat).
    // Resolves to false when the user cancels.
    async aiConfig({ usesAI = false } = {}) {
      const p = provider();
      if (!p || !prefs.model) return null;
      let shareData = p.local || shareRowsConfirmed === p.id;
      if (usesAI && !shareData) {
        const choice = await host.confirm({
          message: tr('Let this script send data to {provider}?', { provider: p.name }),
          detail: tr('{url} is a remote service. The script calls ai.chat / ai.structured and may send rows from {db} in its prompts.', { url: p.baseUrl, db: db.info()?.description ?? tr('the database') }),
          buttons: [tr('Allow'), tr('Cancel')],
        });
        if (choice !== 0) return false;
        shareRowsConfirmed = p.id;
        shareData = true;
      }
      return { providerId: p.id, model: prefs.model, shareData };
    },
    commands: {
      'ai-assistant': () => ctx.tabs.show('assistant'),
      'ai-settings': openSettings,
    },
  };
}
