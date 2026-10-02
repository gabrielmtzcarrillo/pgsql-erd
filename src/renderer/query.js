// The Query tab: a SQL editor with completions from the schema, a results
// grid, and EXPLAIN / EXPLAIN ANALYZE plans shown as a tree with the time
// spent in each node and hints (missing indexes, bad estimates, spills).
// Statements that change data only run with "Allow changes" ticked, after a
// confirmation, and only on connections whose policy allows it.

import { createEditor, setSqlSchema } from './lib/monaco.js';
import { flattenPlan, analyzePlan, describeNode } from '../shared/plan-analyzer.js';
import { classifySql } from '../shared/permissions.js';
import { decorateButtons } from './icons.js';
import { tr, trn, formatNumber } from '../shared/i18n.js';
import { envName } from './dbui.js';

const $ = (sel) => document.querySelector(sel);
const TEXT_KEY = 'pgsql-erd.query';
const HISTORY_KEY = 'pgsql-erd.query-history';
const SPLIT_KEY = 'pgsql-erd.query-split';

export function setupQuery(ctx) {
  const { host, h, status, db, tabs } = ctx;
  const page = $('#query-page');
  let editor = null;
  let editorReady = null;
  let running = false;
  let lastPlan = null; // { sql, flat, hints, analyze }
  let history = load(HISTORY_KEY, []);

  function load(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
    } catch {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // not remembered
    }
  }
  const call = async (fn, ...args) => {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };

  function ensureEditor() {
    editorReady ??= createEditor($('#q-editor'), {
      value: load(TEXT_KEY, `-- ${tr('Ctrl+Enter runs the selection (or everything).')}\n-- ${tr('Explain shows the plan; Explain analyze runs the query and measures it.')}\nSELECT 1;\n`),
      language: 'sql',
      onChange: () => {
        clearTimeout(ensureEditor.t);
        ensureEditor.t = setTimeout(() => save(TEXT_KEY, editor.getValue()), 500);
      },
      onRun: () => run(),
      bindings: [
        { keys: ['CtrlCmd', 'Enter'], run: () => run() },
        { keys: ['CtrlCmd', 'Shift', 'Enter'], run: () => run('analyze') },
        { keys: ['Shift', 'F5'], run: () => run('plan') },
      ],
    }).then((ed) => {
      editor = ed;
      refreshSchema();
      return ed;
    });
    return editorReady;
  }

  async function refreshSchema() {
    try {
      if (db.connected()) setSqlSchema(await call(host.db.schema));
    } catch {
      // completions are optional
    }
  }
  ctx.events.addEventListener('schema', refreshSchema);
  ctx.events.addEventListener('connection', refreshSchema);
  // Another database: results and plans of the old one are cleared; the SQL stays.
  ctx.events.addEventListener('database-switch', () => {
    lastPlan = null;
    for (const id of ['#q-results', '#q-plan', '#q-messages']) $(id).replaceChildren();
    setStatus('');
  });
  tabs.onShow((name) => {
    if (name === 'query') ensureEditor().then(() => {
      editor.layout();
      editor.focus();
    });
  });

  // ------------------------------------------------------------ output tabs

  function showOut(name) {
    for (const b of page.querySelectorAll('[data-qtab]')) b.classList.toggle('active', b.dataset.qtab === name);
    for (const p of page.querySelectorAll('[data-qpane]')) p.hidden = p.dataset.qpane !== name;
  }
  page.querySelector('.q-output .wb-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-qtab]');
    if (b) showOut(b.dataset.qtab);
  });

  (function setupResize() {
    const handle = $('#q-resize');
    const ed = $('#q-editor');
    const saved = load(SPLIT_KEY, null);
    if (saved) ed.style.height = `${saved}px`;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = ed.getBoundingClientRect().height;
      const move = (ev) => (ed.style.height = `${Math.max(80, Math.min(window.innerHeight - 260, startH + ev.clientY - startY))}px`);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        save(SPLIT_KEY, Math.round(ed.getBoundingClientRect().height));
        editor?.layout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  })();

  // ------------------------------------------------------------ running

  function setStatus(text, cls = '') {
    const el = $('#q-status');
    el.textContent = text;
    el.className = `small ${cls || 'muted'}`;
  }

  async function run(explain = null) {
    if (running) return;
    await ensureEditor();
    tabs.show('query');
    if (!db.connected()) return db.openConnect(() => run(explain));
    const sql = editor.getSelectedOrAll().trim();
    if (!sql) return;
    const allowChanges = $('#q-allow').checked;
    const { kinds, statements } = classifySql(sql);
    const writes = kinds.includes('write') || kinds.includes('ddl') || (allowChanges && kinds.includes('other'));
    if (writes && allowChanges && explain !== 'plan') {
      const info = db.info();
      const choice = await host.confirm({
        message: explain === 'analyze'
          ? tr('Run EXPLAIN ANALYZE on a statement that changes data?')
          : trn(statements, 'Run {n} statement that changes the database?', 'Run {n} statements that change the database?'),
        detail: `${info.description} (${envName(info.profile.environment)})\n\n${sql.slice(0, 600)}${sql.length > 600 ? '…' : ''}\n\n${explain === 'analyze' ? tr('The statement runs and is rolled back.') : tr('The changes are committed when all statements succeed.')}`,
        buttons: [explain === 'analyze' ? tr('Analyze') : tr('Run and Commit'), tr('Cancel')],
      });
      if (choice !== 0) return;
    }
    running = true;
    editor.clearMarkers();
    setStatus(explain ? tr('Explaining…') : tr('Running…'));
    for (const b of page.querySelectorAll('#q-run, #q-explain, #q-analyze')) b.disabled = true;
    const started = Date.now();
    try {
      const r = await call(host.query.run, { sql, allowChanges, explain });
      remember(sql);
      if (r.kind === 'plan') renderPlan(sql, r);
      else renderResults(r);
      if (r.committed) {
        status(tr('Changes committed'));
        if (kinds.includes('ddl')) ctx.refreshSchema?.();
      }
    } catch (err) {
      const pos = Number(err.message.match(/at character (\d+)\)?$/)?.[1]);
      if (pos) editor.markError(pos + (editor.getValue().indexOf(sql) > 0 ? editor.getValue().indexOf(sql) : 0), err.message);
      $('#q-messages').replaceChildren(h('pre', { class: 'wb-error' }, err.message));
      showOut('messages');
      setStatus(tr('Error after {s} s', { s: ((Date.now() - started) / 1000).toFixed(2) }), 'error');
    } finally {
      running = false;
      for (const b of page.querySelectorAll('#q-run, #q-explain, #q-analyze')) b.disabled = false;
    }
  }

  function remember(sql) {
    history = [sql, ...history.filter((x) => x !== sql)].slice(0, 30);
    save(HISTORY_KEY, history);
    renderHistory();
  }
  function renderHistory() {
    const sel = $('#q-history');
    sel.replaceChildren(h('option', { value: '' }, tr('History…')), ...history.map((q, i) => h('option', { value: String(i), title: q }, q.replace(/\s+/g, ' ').slice(0, 70))));
  }
  $('#q-history').addEventListener('change', async (e) => {
    const q = history[Number(e.target.value)];
    e.target.value = '';
    if (q === undefined) return;
    await ensureEditor();
    editor.setValue(q, { keepUndo: true });
  });

  function renderResults(r) {
    const nodes = [];
    const msgs = [];
    r.results.forEach((res, i) => {
      msgs.push(`${res.command ?? 'OK'}${res.rowCount !== null && res.rowCount !== undefined ? ` ${res.rowCount}` : ''}${res.truncated ? ` ${tr('(showing {n})', { n: res.rows.length })}` : ''}`);
      if (!res.columns.length) return;
      if (r.results.length > 1) nodes.push(h('div', { class: 'wb-section-title' }, `${tr('Result {i}', { i: i + 1 })} — ${trn(res.rowCount ?? res.rows.length, '{n} row', '{n} rows')}`));
      nodes.push(
        h('table', { class: 'dt-grid' }, [
          h('thead', {}, h('tr', {}, [h('th', { class: 'dt-rownum' }, '#'), ...res.columns.map((c) => h('th', {}, c))])),
          h(
            'tbody',
            {},
            res.rows.map((row, n) =>
              h('tr', {}, [
                h('td', { class: 'dt-rownum' }, String(n + 1)),
                ...row.map((v) => (v === null ? h('td', { class: 'null' }, 'NULL') : h('td', { title: v.length > 60 ? v.slice(0, 2000) : '' }, v.length > 300 ? `${v.slice(0, 300)}…` : v))),
              ])
            )
          ),
        ])
      );
      if (res.truncated) nodes.push(h('p', { class: 'wb-note' }, tr('Only the first {n} rows are shown.', { n: res.rows.length })));
    });
    $('#q-results').replaceChildren(...(nodes.length ? nodes : [h('div', { class: 'db-empty' }, msgs.join('\n'))]));
    $('#q-messages').replaceChildren(h('pre', { class: 'wb-output' }, `${msgs.join('\n')}\n${r.committed ? tr('Committed.') : ''}`));
    const rows = r.results.at(-1)?.rowCount ?? 0;
    setStatus(`${r.results.length > 1 ? `${trn(r.results.length, '{n} statement', '{n} statements')} · ` : ''}${trn(rows, '{n} row', '{n} rows')} · ${(r.durationMs / 1000).toFixed(3)} s${r.committed ? ` · ${tr('committed')}` : ''}`);
    showOut(nodes.length ? 'results' : 'messages');
  }

  async function renderPlan(sql, r) {
    const flat = flattenPlan(r.plan);
    let schema = null;
    try {
      schema = await call(host.db.schema);
    } catch {
      // hints without schema knowledge
    }
    const hints = analyzePlan(flat, schema);
    lastPlan = { sql, flat, hints, analyze: r.analyze, raw: r.plan };
    const byNode = new Map();
    for (const hnt of hints) if (hnt.node !== null) byNode.set(hnt.node, [...(byNode.get(hnt.node) ?? []), hnt]);
    const maxPct = Math.max(1, ...flat.nodes.map((n) => n.percent ?? 0));
    const fmt = (v, d = 2) => (v === null || v === undefined ? '' : formatNumber(v, { maximumFractionDigits: d }));

    const head = h('div', { class: 'qp-summary' }, [
      h('strong', {}, r.analyze ? tr('Actual plan') : tr('Estimated plan')),
      flat.planningTime !== null ? h('span', {}, tr('planning {ms} ms', { ms: fmt(flat.planningTime) })) : null,
      flat.executionTime !== null ? h('span', {}, tr('execution {ms} ms', { ms: fmt(flat.executionTime) })) : null,
      h('span', {}, tr('cost {cost}', { cost: fmt(flat.nodes[0]?.cost) })),
    ]);
    const table = h('table', { class: 'qp-tree' }, [
      h('thead', {}, h('tr', {}, [h('th', {}, tr('Node')), h('th', {}, tr('Est. rows')), h('th', {}, r.analyze ? tr('Rows') : ''), h('th', {}, r.analyze ? tr('Self time') : tr('Cost')), h('th', {}, '')])),
      h(
        'tbody',
        {},
        flat.nodes.map((n) => {
          const warn = byNode.get(n.id);
          const pct = n.percent ?? 0;
          return h('tr', { class: warn ? 'warn' : '', title: detailText(n) }, [
            h('td', { style: `padding-left:${8 + n.depth * 16}px` }, [
              n.depth ? h('span', { class: 'qp-arrow' }, '↳ ') : null,
              h('span', { class: 'qp-node' }, describeNode(n)),
              n.filter ? h('div', { class: 'qp-filter' }, n.filter) : null,
              ...(warn ?? []).map((w) => h('div', { class: `qp-hint ${w.severity}` }, `⚠ ${w.message}`)),
            ]),
            h('td', { class: 'num' }, fmt(n.planRows, 0)),
            h('td', { class: 'num' }, r.analyze ? fmt(n.actualRows, 0) : ''),
            h('td', { class: 'num' }, r.analyze ? `${fmt(n.selfTime)} ms` : fmt(n.cost)),
            h('td', { class: 'qp-bar-cell' }, r.analyze ? h('div', { class: 'qp-bar', style: `width:${(100 * pct) / maxPct}%` }) : ''),
          ]);
        })
      ),
    ]);
    const general = hints.filter((x) => x.node === null || !byNode.has(x.node) || x.sql);
    const hintList = hints.length
      ? h('div', { class: 'qp-hints' }, [
          h('div', { class: 'wb-section-title' }, tr('Suggestions ({n})', { n: hints.length })),
          ...general.map((x) =>
            h('div', { class: `qp-hint-row ${x.severity}` }, [
              h('span', { class: 'grow' }, x.message),
              x.sql ? h('button', { type: 'button', title: tr('Put this statement in the editor'), onclick: () => editor.insertText(`\n${x.sql}\n`) }, tr('Insert SQL')) : null,
            ])
          ),
        ])
      : h('p', { class: 'muted small' }, tr('No problems spotted in this plan.'));
    const raw = h('details', { class: 'qp-raw' }, [h('summary', {}, tr('Raw plan (JSON)')), h('pre', { class: 'wb-output' }, JSON.stringify(r.plan, null, 2))]);
    $('#q-plan').replaceChildren(head, table, hintList, raw);
    setStatus(`${r.analyze ? tr('Analyzed') : tr('Explained')} · ${(r.durationMs / 1000).toFixed(3)} s · ${trn(hints.length, '{n} suggestion', '{n} suggestions')}`);
    showOut('plan');
  }

  function detailText(n) {
    const r = n.raw;
    const keys = ['Output', 'Filter', 'Index Cond', 'Hash Cond', 'Join Filter', 'Sort Key', 'Rows Removed by Filter', 'Shared Hit Blocks', 'Shared Read Blocks', 'Sort Method', 'Actual Loops'];
    return keys.filter((k) => r[k] !== undefined).map((k) => `${k}: ${Array.isArray(r[k]) ? r[k].join(', ') : r[k]}`).join('\n');
  }

  // ------------------------------------------------------------ assistant

  $('#q-ask').addEventListener('click', async () => {
    await ensureEditor();
    const sql = editor.getSelectedOrAll().trim();
    let prompt = `${tr('Explain this query and suggest how to improve it:')}\n\n\`\`\`sql\n${sql}\n\`\`\``;
    if (lastPlan && lastPlan.sql === sql) {
      const lines = lastPlan.flat.nodes.map(
        (n) => `${'  '.repeat(n.depth)}${describeNode(n)} (est ${n.planRows} rows${n.actualRows !== null ? `, actual ${n.actualRows}, ${n.selfTime?.toFixed(2)} ms self` : ''})${n.filter ? ` filter: ${n.filter}` : ''}`
      );
      prompt += `\n\n${lastPlan.analyze ? tr('Actual plan:') : tr('Estimated plan:')}\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
      if (lastPlan.hints.length) prompt += `\n\n${tr('The app flagged:')}\n${lastPlan.hints.map((x) => `- ${x.message}`).join('\n')}`;
    }
    ctx.askAssistant(prompt);
  });

  $('#q-run').addEventListener('click', () => run());
  $('#q-explain').addEventListener('click', () => run('plan'));
  $('#q-analyze').addEventListener('click', () => run('analyze'));
  decorateButtons(page);
  renderHistory();

  return {
    commands: {
      'query-tab': () => tabs.show('query'),
      'query-run': () => run(),
    },
    // Put SQL in the editor (e.g. from the assistant).
    async setSql(sql) {
      tabs.show('query');
      await ensureEditor();
      editor.setValue(sql, { keepUndo: true });
    },
  };
}
