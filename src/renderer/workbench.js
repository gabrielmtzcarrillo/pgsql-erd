// The Scripts tab: the project's scripts,
// the TypeScript editor with database typings, dry runs and runs with a
// review step before commit, and validation results linked to the diagram.
// Scripts run in the main process's isolated runner, never in this page.

import { schemaFromErd, allTables } from '../shared/schema-model.js';
import { generateDatabaseDts } from '../shared/typegen.js';
import { SCRIPT_TYPES, template } from '../shared/scripts.js';
import {
  SCRIPT_PROFILES, SCRIPT_PERMISSION_KEYS, SCRIPT_PERMISSION_LABELS, resolveScriptPermissions, effectivePermissions,
} from '../shared/permissions.js';
import { createEditor } from './lib/monaco.js';
import { decorateButtons } from './icons.js';
import { tr, trn, formatDate } from '../shared/i18n.js';
import { envName } from './dbui.js';

const $ = (sel) => document.querySelector(sel);

export function setupWorkbench(ctx) {
  const { host, h, status, db, tabs } = ctx;
  const panel = $('#scripts-page');
  let editor = null;
  let editorReady = null;
  let schema = { source: 'diagram', schemas: [], enums: [] };
  let project = { dir: null, settings: null };
  let scripts = [];
  let current = blankScript();
  let running = null; // { runId, mode }
  let lastResult = null;
  let problems = { errors: 0, warnings: 0, first: null };
  let lint = [];
  const listeners = new Set();

  function blankScript(props = {}) {
    return { path: null, name: 'untitled', type: 'query', profile: SCRIPT_TYPES.query.profile, overrides: {}, description: '', tables: [], source: '', saved: '', metaDirty: false, origin: null, ...props };
  }

  const isDirty = () => current.source !== current.saved || current.metaDirty || (!current.path && current.source.trim() !== '');
  const call = async (fn, ...args) => {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };

  // ------------------------------------------------------------ tab

  function setOpen() {
    tabs.show('scripts');
  }
  tabs.onShow((name) => {
    if (name === 'scripts') ensureEditor().then(() => editor.layout());
  });

  // Side panel: Results / Activity. 'assistant' is its own main tab.
  function showTab(name) {
    if (name === 'assistant') return tabs.show('assistant');
    for (const b of panel.querySelectorAll('.wb-tabs button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const p of panel.querySelectorAll('.wb-pane')) p.hidden = p.dataset.pane !== name;
    if (name === 'audit') renderAudit();
  }
  panel.querySelector('.wb-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // ------------------------------------------------------------ editor

  function ensureEditor() {
    editorReady ??= createEditor($('#wb-editor'), {
      value: current.source,
      onChange: () => {
        current.source = editor.getValue();
        updateState();
        scheduleCheck();
      },
      onSave: () => save(),
      onRun: () => run('run'),
      onDryRun: () => run('dry-run'),
    }).then((ed) => {
      editor = ed;
      editor.onMarkers((markers) => {
        const errs = markers.filter((m) => m.severity >= 8);
        const warns = markers.filter((m) => m.severity === 4);
        problems = { errors: errs.length, warnings: warns.length, first: errs[0] ?? warns[0] ?? null };
        renderProblems();
      });
      refreshTypes();
      return ed;
    });
    return editorReady;
  }

  async function refreshTypes() {
    try {
      const dbSchema = db.connected() ? await call(host.db.schema) : null;
      schema = dbSchema ?? schemaFromErd(ctx.state.model);
    } catch {
      schema = schemaFromErd(ctx.state.model);
    }
    editor?.setTypes(generateDatabaseDts(schema));
    renderProject();
    scheduleCheck();
  }

  // Lint (unknown tables) and, without Monaco, type errors, from the main process.
  let checkTimer = null;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(check, 700);
  }
  async function check() {
    if (!editor) return;
    const source = current.source;
    try {
      const diags = await call(host.scripts.check, { source, diagramSchema: schema.source === 'diagram' ? schema : null });
      if (source !== current.source) return;
      lint = editor.isMonaco ? diags.filter((d) => d.code === 'pgsql-erd') : diags;
      editor.setMarkers(lint);
      if (!editor.isMonaco) {
        const errs = diags.filter((d) => d.severity === 'error');
        problems = { errors: errs.length, warnings: diags.length - errs.length, first: diags[0] ? { message: diags[0].message, startLineNumber: diags[0].line } : null };
      }
      renderProblems();
    } catch {
      // checking is best-effort
    }
  }

  function renderProblems() {
    const el = $('#wb-problems');
    const warnings = problems.warnings + (editor?.isMonaco ? lint.length : 0);
    if (!problems.errors && !warnings) {
      el.textContent = current.source.trim()
        ? `✓ ${schema.source === 'database' ? tr('No problems · typings from the database schema') : tr('No problems · typings from the diagram schema')}`
        : '';
      el.className = 'wb-problems ok';
      return;
    }
    const first = problems.first ?? (lint[0] && { message: lint[0].message, startLineNumber: lint[0].line });
    el.replaceChildren(
      h('span', {}, `${trn(problems.errors, '{n} error', '{n} errors')}, ${trn(warnings, '{n} warning', '{n} warnings')}`),
      first ? h('a', { href: '#', onclick: (e) => (e.preventDefault(), editor.revealLine(first.startLineNumber, first.startColumn)) }, ` — ${tr('line {n}', { n: first.startLineNumber })}: ${first.message}`) : ''
    );
    el.className = `wb-problems ${problems.errors ? 'error' : 'warn'}`;
  }

  // ------------------------------------------------------------ script list

  function renderProject() {
    const el = $('#wb-project');
    el.textContent = project.dir
      ? `${project.dir}/scripts`
      : tr('Save the diagram to keep scripts in a scripts/ folder next to it.');
    el.title = el.textContent;
  }

  // The last run of each saved script, kept per project on this machine
  // (not in the project folder, so runs don't show up as file changes).
  let runs = {};
  const runsKey = () => `pgsql-erd.script-runs:${project.dir}`;
  function loadRuns() {
    try {
      runs = project.dir ? JSON.parse(localStorage.getItem(runsKey()) || '{}') : {};
    } catch {
      runs = {};
    }
    for (const s of scripts) if (runs[s.path]) s.lastStatus = statusOf(runs[s.path]);
  }
  const statusOf = (run) => (run.status === 'error' ? 'failed' : run.validations && run.passed < run.validations ? 'warn' : 'passed');
  function recordRun(path, r) {
    if (!path || !project.dir) return;
    const passed = r.validations.filter((v) => v.status === 'passed').length;
    runs[path] = {
      status: r.error ? 'error' : 'ok',
      mode: r.mode,
      validations: r.validations.length,
      passed,
      errors: r.validations.reduce((n, v) => n + v.errors, 0),
      rowsRead: r.rowsRead,
      inserts: r.inserts,
      updates: r.updates,
      deletes: r.deletes,
      at: Date.now(),
    };
    try {
      localStorage.setItem(runsKey(), JSON.stringify(runs));
    } catch {
      // not remembered
    }
    scriptsChanged();
  }
  // The diagram shows saved scripts; tell it when they or their runs change.
  const scriptsChanged = () => ctx.events.dispatchEvent(new Event('scripts'));

  async function reloadList() {
    try {
      scripts = await call(host.scripts.list);
    } catch {
      scripts = [];
    }
    loadRuns();
    renderList();
    scriptsChanged();
  }

  function renderList() {
    const q = $('#wb-filter').value.trim().toLowerCase();
    const items = [];
    const draft = !current.path;
    if (draft) items.push(h('div', { class: 'wb-item active draft' }, [h('span', { class: 'grow' }, `${current.name} ${tr('(unsaved)')}`)]));
    const byType = new Map();
    for (const s of scripts) {
      if (q && !`${s.name} ${s.type} ${s.description}`.toLowerCase().includes(q)) continue;
      if (!byType.has(s.type)) byType.set(s.type, []);
      byType.get(s.type).push(s);
    }
    for (const [type, list] of byType) {
      items.push(h('div', { class: 'wb-group' }, tr(SCRIPT_TYPES[type]?.label ?? type)));
      for (const s of list) {
        const active = s.path === current.path;
        items.push(
          h('div', { class: `wb-item${active ? ' active' : ''}`, title: `${s.path}${s.description ? `\n${s.description}` : ''}`, onclick: () => openScript(s.path) }, [
            h('span', { class: 'grow' }, `${s.name}${active && isDirty() ? ' •' : ''}`),
            s.lastStatus ? h('span', { class: `wb-dot ${s.lastStatus}` }) : null,
            h('button', { type: 'button', class: 'wb-del', title: tr('Delete script'), onclick: (e) => (e.stopPropagation(), removeScript(s)) }, '×'),
          ])
        );
      }
    }
    if (!items.length) items.push(h('div', { class: 'db-empty' }, project.dir ? tr('No scripts yet.') : tr('No project folder.')));
    $('#wb-list').replaceChildren(...items);
  }
  $('#wb-filter').addEventListener('input', renderList);

  async function confirmDiscardScript() {
    if (!isDirty()) return true;
    const choice = await host.confirm({
      message: tr('Save changes to {name}?', { name: current.name }),
      buttons: [tr('Save'), tr("Don't Save"), tr('Cancel')],
    });
    if (choice === 2) return false;
    if (choice === 0) return save();
    return true;
  }

  async function openScript(path) {
    if (path === current.path) return;
    if (!(await confirmDiscardScript())) return;
    try {
      const s = await call(host.scripts.read, path);
      load({ ...s, saved: s.source });
    } catch (err) {
      status(tr('Could not open {file}: {message}', { file: path, message: err.message }));
    }
  }

  function load(script) {
    current = blankScript(script);
    ensureEditor().then(() => {
      editor.setValue(current.source);
      editor.focus();
    });
    renderToolbar();
    renderList();
    updateState();
    scheduleCheck();
  }

  async function removeScript(s) {
    const choice = await host.confirm({
      message: tr('Delete {file}?', { file: s.path }),
      detail: tr('The file is removed from the project folder.'),
      buttons: [tr('Delete'), tr('Cancel')],
    });
    if (choice !== 0) return;
    try {
      await call(host.scripts.remove, s.path);
      if (current.path === s.path) load(blankScript());
      await reloadList();
    } catch (err) {
      status(err.message);
    }
  }

  // ------------------------------------------------------------ toolbar

  const typeSelect = $('#wb-type');
  const profileSelect = $('#wb-profile');
  const nameInput = $('#wb-name');
  typeSelect.replaceChildren(...Object.entries(SCRIPT_TYPES).map(([k, v]) => h('option', { value: k }, tr(v.label))));
  profileSelect.replaceChildren(...Object.entries(SCRIPT_PROFILES).map(([k, v]) => h('option', { value: k }, tr(v.label))));

  function renderToolbar() {
    nameInput.value = current.name;
    typeSelect.value = current.type;
    profileSelect.value = current.profile;
    const custom = Object.keys(current.overrides ?? {}).length > 0;
    $('#wb-perms').classList.toggle('active', custom);
    $('#wb-perms').title = `${tr('Permissions:')} ${describePermissions(resolveScriptPermissions(current.profile, current.overrides))}${custom ? ` ${tr('(customised)')}` : ''}`;
  }

  // Name, type or permission changes also need saving.
  const touch = () => {
    current.metaDirty = true;
    updateState();
  };
  nameInput.addEventListener('change', () => {
    current.name = nameInput.value.trim() || 'untitled';
    touch();
    renderList();
  });
  typeSelect.addEventListener('change', () => {
    current.type = typeSelect.value;
    current.profile = SCRIPT_TYPES[current.type].profile;
    current.overrides = {};
    renderToolbar();
    touch();
  });
  profileSelect.addEventListener('change', () => {
    current.profile = profileSelect.value;
    current.overrides = {};
    renderToolbar();
    touch();
  });

  function updateState() {
    const el = $('#wb-state');
    const dirty = isDirty();
    el.textContent = running ? (running.mode === 'run' ? tr('Running…') : tr('Dry run…')) : dirty ? tr('Unsaved') : current.path ? tr('Saved') : '';
    el.className = `wb-state${running ? ' running' : dirty ? ' dirty' : ''}`;
    for (const b of document.querySelectorAll('[data-cmd="script-run"], [data-cmd="script-dry-run"]')) b.disabled = !!running;
    for (const b of document.querySelectorAll('[data-cmd="script-stop"]')) b.disabled = !running;
  }

  function describePermissions(p) {
    const on = SCRIPT_PERMISSION_KEYS.filter((k) => p[k]).map((k) => tr(SCRIPT_PERMISSION_LABELS[k]));
    return on.join(', ') || tr('none');
  }

  // Permissions dialog
  const permsDialog = $('#script-perms-dialog');
  let permsDraft = null;
  function renderPerms() {
    const p = resolveScriptPermissions(current.profile, permsDraft);
    const policy = db.info()?.profile?.policy;
    const eff = policy ? effectivePermissions(p, policy) : p;
    $('#script-perms-list').replaceChildren(
      ...SCRIPT_PERMISSION_KEYS.map((k) => {
        const cb = h('input', { type: 'checkbox', checked: p[k] });
        cb.addEventListener('change', () => {
          permsDraft = { ...permsDraft, [k]: cb.checked };
          if (SCRIPT_PROFILES[current.profile].permissions[k] === cb.checked) delete permsDraft[k];
          renderPerms();
        });
        const blocked = p[k] && !eff[k];
        return h('label', { class: `check${blocked ? ' blocked' : ''}`, title: blocked ? tr('Not allowed by the connection policy') : '' }, [
          cb,
          h('span', {}, tr(SCRIPT_PERMISSION_LABELS[k])),
          blocked ? h('span', { class: 'tag' }, tr('blocked by connection')) : null,
        ]);
      })
    );
    $('#script-perms-policy').textContent = policy
      ? tr('Connection "{name}" ({env}): writes {writes}, DDL {ddl}.', {
          name: db.info().profile.name,
          env: envName(db.info().profile.environment),
          writes: policy.allowWrites ? tr('allowed') : tr('blocked'),
          ddl: policy.allowDDL ? tr('allowed') : tr('blocked'),
        })
      : tr('Not connected.');
  }
  $('#wb-perms').addEventListener('click', () => {
    permsDraft = { ...current.overrides };
    renderPerms();
    permsDialog.showModal();
  });
  $('#script-perms-reset').addEventListener('click', () => {
    permsDraft = {};
    renderPerms();
  });
  permsDialog.addEventListener('close', () => {
    if (permsDialog.returnValue !== 'ok') return;
    current.overrides = permsDraft ?? {};
    renderToolbar();
    touch();
  });

  // ------------------------------------------------------------ new / save

  const newDialog = $('#script-new-dialog');
  const newForm = $('#script-new-form');
  newForm.elements.type.replaceChildren(...Object.entries(SCRIPT_TYPES).map(([k, v]) => h('option', { value: k }, tr(v.label))));
  newForm.elements.profile.replaceChildren(...Object.entries(SCRIPT_PROFILES).map(([k, v]) => h('option', { value: k }, tr(v.label))));
  newForm.elements.type.addEventListener('change', () => (newForm.elements.profile.value = SCRIPT_TYPES[newForm.elements.type.value].profile));

  async function openNewDialog(type = 'validator') {
    setOpen();
    await refreshTypes();
    const f = newForm.elements;
    f.name.value = '';
    f.description.value = '';
    f.type.value = type;
    f.profile.value = SCRIPT_TYPES[type].profile;
    const tables = allTables(schema).map((t) => t.id);
    const selected = ctx.selectedTableIds()[0];
    f.table.replaceChildren(...(tables.length ? tables : ['public.my_table']).map((t) => h('option', { value: t }, t)));
    if (selected && tables.includes(selected)) f.table.value = selected;
    newDialog.returnValue = '';
    newDialog.showModal();
    f.name.focus();
  }

  newDialog.addEventListener('close', async () => {
    if (newDialog.returnValue !== 'ok') return;
    const f = newForm.elements;
    if (!(await confirmDiscardScript())) return;
    const type = f.type.value;
    const source = template(type, { table: f.table.value });
    load({ name: f.name.value.trim() || 'untitled', type, profile: f.profile.value, description: f.description.value.trim(), tables: [f.table.value], source, saved: '' });
  });

  async function ensureProject() {
    if (project.dir) return true;
    const choice = await host.confirm({
      message: tr('Save the diagram first?'),
      detail: tr('Scripts are saved in a scripts/ folder next to the diagram file.'),
      buttons: [tr('Save Diagram…'), tr('Cancel')],
    });
    if (choice !== 0) return false;
    return !!(await ctx.saveDiagram()) && !!project.dir;
  }

  async function save() {
    if (!(await ensureProject())) return false;
    try {
      if (current.path) {
        const expected = `scripts/${SCRIPT_TYPES[current.type].folder}/`;
        const baseName = current.path.split('/').pop().replace(/\.ts$/, '');
        if (!current.path.startsWith(expected) || baseName !== current.name) {
          current.path = await call(host.scripts.move, current.path, current.type, current.name);
        }
      }
      const { saved, metaDirty, ...script } = current;
      const path = await call(host.scripts.write, { ...script, isNew: !current.path });
      current.path = path;
      current.name = path.split('/').pop().replace(/\.ts$/, '');
      current.saved = current.source;
      current.metaDirty = false;
      current.origin = null;
      renderToolbar();
      updateState();
      await reloadList();
      status(tr('Saved {file}', { file: path }));
      return true;
    } catch (err) {
      status(tr('Could not save: {message}', { message: err.message }));
      return false;
    }
  }

  // ------------------------------------------------------------ runs

  const results = $('#wb-results');
  let live = null; // { output: el, messages: el }

  async function run(mode, { ignoreTypeErrors = false } = {}) {
    if (running) return;
    await ensureEditor();
    if (!current.source.trim()) return status(tr('The script is empty.'));
    if (!db.connected()) return db.openConnect(() => run(mode));
    const usesAI = resolveScriptPermissions(current.profile, current.overrides).useAI && /\bai\s*\.\s*(chat|structured)\b/.test(current.source);
    const ai = (await ctx.aiConfig?.({ usesAI })) ?? null;
    if (ai === false) return status(tr('Run cancelled.'));
    setOpen();
    showTab('results');
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    running = { runId, mode };
    updateState();
    startLive(mode);
    let r;
    try {
      r = await call(host.scripts.run, {
        runId,
        source: current.source,
        name: current.name,
        path: current.path,
        type: current.type,
        profile: current.profile,
        overrides: current.overrides,
        mode,
        ignoreTypeErrors,
        ai,
      });
    } catch (err) {
      running = null;
      updateState();
      renderError(err.message);
      return;
    }
    running = null;
    updateState();
    if (r.stage === 'typecheck') {
      renderTypeErrors(r);
      const errs = r.diagnostics.filter((d) => d.severity === 'error');
      const choice = await host.confirm({
        message: trn(errs.length, 'The script has {n} type error.', 'The script has {n} type errors.'),
        detail: `${errs.slice(0, 5).map((d) => `${tr('Line {n}', { n: d.line })}: ${d.message}`).join('\n')}\n\n${tr('Run it anyway?')}`,
        buttons: [tr('Run Anyway'), tr('Cancel')],
      });
      if (choice === 0) return run(mode, { ignoreTypeErrors: true });
      return;
    }
    if (r.stage === 'transpile') return renderError(r.error);
    lastResult = r;
    const entry = scripts.find((s) => s.path === current.path);
    if (entry) entry.lastStatus = r.error ? 'failed' : r.success ? 'passed' : 'warn';
    // Runs of the saved version only: an edited script isn't what the file says.
    if (current.path && !isDirty()) recordRun(current.path, r);
    renderResult(r);
    renderList();
    listeners.forEach((l) => l('result', r));
    if (r.status === 'pending') await review(r);
    if (r.schemaChanged && r.status !== 'pending') ctx.refreshSchema?.();
  }

  host.scripts.onEvent((e) => {
    if (!running || e.runId !== running.runId || !live) return;
    if (e.type === 'output') {
      live.output.hidden = false;
      live.output.textContent += `${e.text}\n`;
    } else if (e.type === 'message') {
      live.count++;
      live.status.textContent = `${running.mode === 'run' ? tr('Running…') : tr('Dry run…')} ${trn(live.count, '{n} message', '{n} messages')}`;
    }
  });

  function startLive(mode) {
    const output = h('pre', { class: 'wb-output', hidden: true });
    const st = h('div', { class: 'wb-result-head running' }, mode === 'run' ? tr('Running…') : tr('Dry run…'));
    live = { output, status: st, count: 0 };
    results.replaceChildren(st, output);
  }

  function renderError(message) {
    live = null;
    results.replaceChildren(h('div', { class: 'wb-result-head failed' }, tr('Could not run the script')), h('pre', { class: 'wb-error' }, message));
  }

  function renderTypeErrors(r) {
    live = null;
    results.replaceChildren(
      h('div', { class: 'wb-result-head failed' }, tr('Type errors — not run')),
      h(
        'div',
        { class: 'wb-list-plain' },
        r.diagnostics.map((d) =>
          h('div', { class: `wb-msg ${d.severity}`, onclick: () => editor.revealLine(d.line, d.column) }, [h('span', { class: 'wb-loc' }, tr('line {n}', { n: d.line })), h('span', {}, d.message)])
        )
      )
    );
  }

  const STATUS_TEXT = {
    'rolled back': tr('Dry run — rolled back'),
    completed: tr('Completed (read only)'),
    pending: tr('Waiting for commit'),
    committed: tr('Committed'),
    failed: tr('Failed — rolled back'),
  };

  function renderResult(r) {
    live = null;
    const statusClass = r.status === 'failed' ? 'failed' : r.success === false ? 'warn' : 'ok';
    const nodes = [
      h('div', { class: `wb-result-head ${statusClass}` }, [
        h('strong', {}, STATUS_TEXT[r.status] ?? r.status),
        h('span', { class: 'muted' }, ` · ${(r.durationMs / 1000).toFixed(2)} s · ${envName(r.environment)}`),
      ]),
    ];
    if (r.error) nodes.push(h('pre', { class: 'wb-error' }, r.error));
    nodes.push(
      h('div', { class: 'wb-counts' }, [
        count('INSERT', r.inserts, 'add'),
        count('UPDATE', r.updates, 'alter'),
        count('DELETE', r.deletes, 'drop'),
        count(tr('rows read'), r.rowsRead, ''),
      ])
    );
    if (r.affectedTables.length) nodes.push(changesTable(r.affectedTables));
    if (r.restricted?.length)
      nodes.push(h('p', { class: 'wb-note' }, tr('Not allowed on this connection: {list}.', { list: r.restricted.map((k) => tr(SCRIPT_PERMISSION_LABELS[k])).join(', ') })));
    if (r.validations.length) {
      const passed = r.validations.filter((v) => v.status === 'passed').length;
      nodes.push(h('div', { class: 'wb-section-title' }, tr('Validations — {passed}/{total} passed', { passed, total: r.validations.length })));
      for (const v of r.validations) {
        const msgs = r.messages.filter((m) => m.validation === v.name);
        const item = h('details', { class: `wb-validation ${v.status}`, open: v.status !== 'passed' && msgs.length <= 50 }, [
          h('summary', {}, [
            h('span', { class: 'wb-mark' }, v.status === 'passed' ? '✓' : '✗'),
            h('span', { class: 'grow' }, v.name),
            h('span', { class: 'muted' }, v.errors ? trn(v.errors, '{n} error', '{n} errors') : v.warnings ? trn(v.warnings, '{n} warning', '{n} warnings') : ''),
          ]),
          ...msgs.map(messageRow),
        ]);
        nodes.push(item);
      }
    }
    const loose = r.messages.filter((m) => !m.validation);
    if (loose.length) {
      nodes.push(h('div', { class: 'wb-section-title' }, tr('Messages')));
      nodes.push(...loose.map(messageRow));
    }
    if (r.messagesDropped) nodes.push(h('p', { class: 'wb-note' }, trn(r.messagesDropped, '{n} more message not shown.', '{n} more messages not shown.')));
    if (r.output.length) {
      nodes.push(h('div', { class: 'wb-section-title' }, tr('Output')));
      nodes.push(h('pre', { class: 'wb-output' }, r.output.join('\n')));
    }
    nodes.push(h('div', { id: 'wb-row-view' }));
    results.replaceChildren(...nodes);
  }

  function count(label, n, cls) {
    return h('div', { class: `wb-count ${n ? cls : ''}` }, [h('strong', {}, String(n)), h('span', {}, label)]);
  }

  function changesTable(tables) {
    return h(
      'table',
      { class: 'wb-changes' },
      tables.map((t) =>
        h('tr', { onclick: () => ctx.focusTable(t.table), title: tr('Show in the diagram') }, [
          h('td', {}, t.table),
          h('td', { class: 'add' }, t.insert ? `+${t.insert}` : ''),
          h('td', { class: 'alter' }, t.update ? `~${t.update}` : ''),
          h('td', { class: 'drop' }, t.delete ? `−${t.delete}` : ''),
        ])
      )
    );
  }

  function messageRow(m) {
    const where = [m.table, m.row !== undefined && m.row !== null ? `#${m.row}` : null, m.column].filter(Boolean).join(' ');
    return h(
      'div',
      {
        class: `wb-msg ${m.level}${m.table ? ' link' : ''}`,
        title: m.table ? tr('Show the table in the diagram and the row below') : '',
        onclick: () => m.table && openError(m),
      },
      [where ? h('span', { class: 'wb-loc' }, where) : null, h('span', {}, m.message)]
    );
  }

  // Clicking a validation error: focus the table in the diagram, show the
  // validation in the editor and the row below the results.
  async function openError(m) {
    const found = ctx.hasTable(m.table);
    if (m.validation && lastResult?.script === (current.path ?? current.name)) {
      const line = current.source.split('\n').findIndex((l) => l.includes('validate(') && l.includes(m.validation));
      if (line !== -1) editor?.revealLine(line + 1);
    }
    const view = $('#wb-row-view');
    if (!view) return;
    if (m.row === undefined || m.row === null) {
      view.replaceChildren(rowActions(m, found));
      return;
    }
    view.replaceChildren(h('p', { class: 'muted small' }, tr('Loading row…')));
    try {
      const r = await call(host.db.row, { table: m.table, key: m.row });
      if (!r.row) return view.replaceChildren(h('p', { class: 'wb-note' }, tr('{table} {key} = {row} no longer exists.', { table: r.table, key: r.key, row: m.row })));
      view.replaceChildren(
        h('div', { class: 'wb-section-title' }, `${r.table} · ${r.key} = ${m.row}`),
        rowActions(m, found, r.key),
        h(
          'table',
          { class: 'wb-row' },
          Object.entries(r.row).map(([k, v]) =>
            h('tr', { class: k === m.column ? 'hl' : '' }, [h('th', {}, k), h('td', {}, v === null ? 'NULL' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v))])
          )
        )
      );
    } catch (err) {
      view.replaceChildren(h('p', { class: 'wb-note' }, err.message));
    }
  }

  function rowActions(m, inDiagram, key) {
    return h('div', { class: 'wb-row-actions' }, [
      inDiagram
        ? h('button', { type: 'button', onclick: () => ctx.focusTable(m.table) }, tr('Show in diagram'))
        : h('span', { class: 'muted small' }, tr('Not in the diagram')),
      h('button', { type: 'button', onclick: () => ctx.openData(m.table, key ? { filters: { [key]: { values: [String(m.row)] } } } : {}) }, tr('Open in data tab')),
    ]);
  }

  // Pending commit: show the changes and ask.
  const previewDialog = $('#run-preview-dialog');
  function review(r) {
    $('#run-preview-title').textContent = tr('Commit changes from {script}?', { script: r.script });
    $('#run-preview-summary').textContent = tr('{inserts} inserted, {updates} updated, {deletes} deleted{schema} on {db} ({env}).', {
      inserts: r.inserts,
      updates: r.updates,
      deletes: r.deletes,
      schema: r.schemaChanged ? tr(', schema changed') : '',
      db: db.info()?.description ?? tr('the database'),
      env: envName(r.environment),
    });
    $('#run-preview-body').replaceChildren(changesTable(r.affectedTables));
    previewDialog.returnValue = '';
    previewDialog.showModal();
    return new Promise((resolve) => {
      previewDialog.addEventListener(
        'close',
        async () => {
          const commit = previewDialog.returnValue === 'commit';
          try {
            const res = await call(commit ? host.scripts.commit : host.scripts.discard, r.runId);
            r.status = res.status === 'committed' ? 'committed' : 'rolled back';
            status(commit ? trn(r.inserts + r.updates + r.deletes, 'Committed {n} row change', 'Committed {n} row changes') : tr('Changes discarded'));
            if (commit && (res.schemaChanged || r.schemaChanged)) ctx.refreshSchema?.();
          } catch (err) {
            r.status = 'failed';
            r.error = err.message;
          }
          renderResult(r);
          resolve();
        },
        { once: true }
      );
    });
  }

  // ------------------------------------------------------------ activity

  async function renderAudit() {
    const el = $('#wb-audit');
    try {
      const entries = await call(host.audit.recent, 100);
      el.replaceChildren(
        ...(entries.length
          ? entries.map((e) =>
              h('div', { class: `wb-audit ${/row-data/.test(e.event) ? 'data' : ''}` }, [
                h('span', { class: 'muted' }, formatDate(e.time)),
                h('strong', {}, e.event),
                h('span', {}, auditDetail(e)),
              ])
            )
          : [h('div', { class: 'db-empty' }, tr('No activity yet.'))])
      );
    } catch (err) {
      el.textContent = err.message;
    }
  }

  function auditDetail(e) {
    if (e.script) return `${e.script} · ${e.status ?? ''}${e.inserts !== undefined ? ` · +${e.inserts} ~${e.updates} −${e.deletes}` : ''}`;
    if (e.provider) return `${e.provider}${e.model ? ` / ${e.model}` : ''}${e.local === false ? ` ${tr('(remote)')}` : ''}${e.tables?.length ? ` · ${e.tables.join(', ')}` : ''}`;
    if (e.target) return `${e.target}${e.environment ? ` · ${e.environment}` : ''}`;
    return e.path ?? e.dir ?? '';
  }

  // ------------------------------------------------------------ wiring

  ctx.events.addEventListener('file', async () => {
    try {
      const p = await call(host.project.set, ctx.state.filePath);
      project = { dir: p.dir, settings: p.settings };
      scripts = p.scripts;
    } catch {
      project = { dir: null, settings: null };
      scripts = [];
    }
    loadRuns();
    renderProject();
    renderList();
    scriptsChanged();
    listeners.forEach((l) => l('project', project));
  });
  ctx.events.addEventListener('schema', () => refreshTypes());
  ctx.events.addEventListener('connection', () => refreshTypes());
  let modelTimer = null;
  ctx.events.addEventListener('model', () => {
    if (db.connected() || !editor) return;
    clearTimeout(modelTimer);
    modelTimer = setTimeout(refreshTypes, 800);
  });

  decorateButtons(panel);
  renderToolbar();
  updateState();
  renderProject();

  const api = {
    open: () => setOpen(),
    scripts: () => scripts,
    runs: () => runs,
    // Open a saved script in the Scripts tab.
    async openScript(path) {
      setOpen();
      await ensureEditor();
      await openScript(path);
    },
    async runScript(path, mode) {
      await api.openScript(path);
      if (current.path === path) await run(mode);
    },
    showTab,
    schema: () => schema,
    project: () => project,
    current: () => ({ name: current.name, type: current.type, path: current.path, source: current.source }),
    validationErrors: () => (lastResult?.messages ?? []).filter((m) => m.level === 'error').slice(0, 100),
    onChange: (fn) => listeners.add(fn),
    hasEditor: () => !!editor,
    async newFromCode({ name, type, description, source }, origin = 'assistant') {
      if (!(await confirmDiscardScript())) return;
      setOpen();
      load({ name: name || 'assistant script', type: SCRIPT_TYPES[type] ? type : 'query', profile: SCRIPT_TYPES[type]?.profile ?? 'read-only', description: description ?? '', source, saved: '', origin });
    },
    async replaceCode(source) {
      await ensureEditor();
      setOpen();
      editor.setValue(source, { keepUndo: true });
      current.source = editor.getValue();
      updateState();
    },
    async insertCode(source) {
      await ensureEditor();
      setOpen();
      editor.insertText(source);
    },
    refreshTypes,
    isDirty,
  };

  return {
    api,
    commands: {
      'toggle-workbench': () => setOpen(),
      'script-new': () => openNewDialog(),
      'script-save': () => save(),
      'script-run': () => run('run'),
      'script-dry-run': () => run('dry-run'),
      'script-stop': () => running && call(host.scripts.stop),
    },
  };
}
