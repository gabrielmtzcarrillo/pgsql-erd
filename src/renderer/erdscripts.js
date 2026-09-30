// Scripts as entities in the diagram (optional): each saved script that
// uses diagram tables is drawn as a box with its type and last run, linked
// to those tables with a dashed line labelled by the relationship
// ("validates", "generates", …). Boxes can be moved; their positions are
// kept in the project settings (pgsql-erd.json), never in the .pgerd file,
// which stays compatible with pgAdmin.

import { tableKey } from './lib/catalog.js';
import {
  RELATION, SCRIPT_HEADER, SCRIPT_ROW, SCRIPT_TYPE_LABEL, route, linkedTables, placeScripts, scriptLines, scriptSize,
} from './lib/scriptnodes.js';
import { iconElement } from './icons.js';

const $ = (sel) => document.querySelector(sel);
const SHOW_KEY = 'pgsql-erd.show-scripts';

export function setupErdScripts(ctx) {
  const { host, state, el, h, events, workbench, status } = ctx;
  let show = false;
  try {
    show = localStorage.getItem(SHOW_KEY) === 'true';
  } catch {
    // hidden by default
  }
  let projectDir = null;
  let positions = new Map(); // path -> { x, y }
  let nodes = []; // [{ script, run, links, lines, size, x, y }]

  // ------------------------------------------------------------ model

  function diagramTables() {
    return state.model.tables.map((t) => ({ key: tableKey(t), schema: t.schema || 'public', name: t.name, t }));
  }

  function tableBoxes() {
    const out = new Map();
    for (const t of state.model.tables) {
      const s = state.sizes.get(t.id);
      if (s) out.set(tableKey(t), { x: t.x, y: t.y, width: s.width, height: s.height });
    }
    return out;
  }

  // Rebuild the node list from the project's scripts and the diagram.
  function layout() {
    const tables = diagramTables();
    const runs = workbench.runs();
    const list = workbench
      .scripts()
      .map((script) => {
        const links = linkedTables(script, tables);
        const run = runs[script.path] ?? null;
        const lines = scriptLines(script, run);
        return { script, run, links, lines, size: scriptSize(lines, ctx.measure(script.name, true)) };
      })
      .filter((n) => n.links.length);
    const placed = placeScripts(
      list.map((n) => ({ path: n.script.path, links: n.links, size: n.size })),
      tableBoxes(),
      positions
    );
    let added = false;
    for (const n of list) {
      const p = placed.get(n.script.path);
      if (!positions.has(n.script.path)) {
        positions.set(n.script.path, p);
        added = true;
      }
      n.x = p.x;
      n.y = p.y;
    }
    nodes = list;
    if (added && projectDir) savePositions();
    return nodes;
  }

  const box = (n) => ({ x: n.x, y: n.y, width: n.size.width, height: n.size.height });

  // ------------------------------------------------------------ rendering

  function renderNode(n) {
    const sel = state.selection?.type === 'script' && state.selection.id === n.script.path;
    const { width, height } = n.size;
    const g = el('g', {
      class: `erd-script type-${n.script.type}${sel ? ' selected' : ''}`,
      'data-path': n.script.path,
      transform: `translate(${n.x},${n.y})`,
    });
    g.append(el('rect', { class: 's-body', width, height, rx: 6 }));
    g.append(el('path', { class: 's-header', d: `M0,6 a6,6 0 0 1 6,-6 h${width - 12} a6,6 0 0 1 6,6 v${SCRIPT_HEADER - 6} h${-width} z` }));
    const icon = iconElement(n.script.type === 'validator' ? 'validator' : 'toggle-workbench', 's-icon');
    icon.setAttribute('x', 10);
    icon.setAttribute('y', 8);
    icon.setAttribute('width', 14);
    icon.setAttribute('height', 14);
    g.append(icon);
    g.append(el('text', { class: 's-title', x: 30, y: 20 }, clip(n.script.name, 48)));
    n.lines.forEach((line, i) => g.append(el('text', { class: line.cls, x: 10, y: SCRIPT_HEADER + 15 + i * SCRIPT_ROW }, line.text)));
    const when = n.run?.at ? `\nLast run ${new Date(n.run.at).toLocaleString()}` : '';
    g.append(el('title', {}, `${n.script.path}${n.script.description ? `\n${n.script.description}` : ''}${when}\nDouble-click to open`));
    return g;
  }

  // placed: label boxes already drawn, so labels of crossing links don't overlap.
  function renderLinks(n, placed) {
    const out = [];
    const boxes = tableBoxes();
    const selected = state.selection;
    for (const key of n.links) {
      const t = boxes.get(key);
      if (!t) continue;
      const others = [...boxes].filter(([k]) => k !== key).map(([, b]) => b);
      for (const m of nodes) if (m !== n) others.push(box(m));
      const c = route(box(n), t, others);
      const table = state.model.tables.find((x) => tableKey(x) === key);
      const related =
        (selected?.type === 'script' && selected.id === n.script.path) || (selected?.type === 'table' && selected.id === table?.id);
      const label = RELATION[n.script.type] ?? 'uses';
      const w = label.length * 6.2 + 10;
      const lb = { x: c.mid.x - w / 2, y: c.mid.y - 8, width: w, height: 16 };
      for (let i = 0; i < 6 && placed.some((p) => lb.x < p.x + p.width && p.x < lb.x + lb.width && lb.y < p.y + p.height + 2 && p.y < lb.y + lb.height + 2); i++)
        lb.y += i % 2 ? -(i + 1) * 18 : (i + 1) * 18;
      placed.push(lb);
      const g = el('g', { class: `erd-script-link${related ? ' related' : ''}`, 'data-path': n.script.path });
      g.append(el('path', { class: 'sl-line', d: c.path }));
      g.append(el('circle', { class: 'sl-end', cx: c.end.x, cy: c.end.y, r: 3 }));
      g.append(el('rect', { class: 'sl-label-bg', x: lb.x, y: lb.y, width: w, height: 16, rx: 8 }));
      g.append(el('text', { class: 'sl-label', x: c.mid.x, y: lb.y + 12, 'text-anchor': 'middle' }, label));
      g.append(el('title', {}, `${n.script.name} ${label} ${key}`));
      out.push(g);
    }
    return out;
  }

  function clip(s, n) {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  // Fills the two layers; called from the diagram's render().
  function render(linksLayer, nodesLayer) {
    const list = show && projectDir ? layout() : [];
    const placed = [];
    linksLayer.replaceChildren(...list.flatMap((n) => renderLinks(n, placed)));
    nodesLayer.replaceChildren(...list.map(renderNode));
    renderToggle();
  }

  // Script boxes, for fitting the view and exporting.
  const boxes = () => (show ? nodes.map(box) : []);

  // ------------------------------------------------------------ toggle

  const toggle = $('#erd-scripts-toggle');
  function renderToggle() {
    const count = projectDir ? workbench.scripts().filter((s) => linkedTables(s, diagramTables()).length).length : 0;
    toggle.hidden = count === 0;
    toggle.classList.toggle('active', show);
    toggle.querySelector('.label').textContent = show ? `Hide scripts (${count})` : `Show scripts (${count})`;
    toggle.title = show ? 'Hide the scripts from the diagram' : 'Show the project\'s scripts as entities linked to the tables they use';
  }
  toggle.addEventListener('click', () => setShown(!show));

  function setShown(v) {
    show = v;
    try {
      localStorage.setItem(SHOW_KEY, String(v));
    } catch {
      // not remembered
    }
    if (!v && state.selection?.type === 'script') ctx.select(null);
    ctx.render();
    if (v && !projectDir) status('Save the diagram and add scripts to show them here.');
  }

  // ------------------------------------------------------------ positions

  let saveTimer = null;
  function savePositions() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const erd = { ...(workbench.project().settings?.erd ?? {}) };
      erd.scripts = Object.fromEntries([...positions].map(([k, v]) => [k, { x: Math.round(v.x), y: Math.round(v.y) }]));
      try {
        const res = await host.project.saveSettings({ erd });
        if (res.ok) workbench.project().settings = res.result;
      } catch {
        // positions are a convenience
      }
    }, 600);
  }

  function loadPositions() {
    const saved = workbench.project().settings?.erd?.scripts ?? {};
    positions = new Map(Object.entries(saved).filter(([, p]) => Number.isFinite(p?.x) && Number.isFinite(p?.y)));
  }

  events.addEventListener('scripts', () => {
    const dir = workbench.project().dir;
    if (dir !== projectDir) {
      projectDir = dir;
      loadPositions();
    }
    ctx.render();
  });

  // ------------------------------------------------------------ interaction

  const nodeAt = (target) => target.closest?.('.erd-script');

  function startDrag(target, e) {
    const g = nodeAt(target);
    if (!g) return null;
    const path = g.dataset.path;
    const p = positions.get(path);
    if (!p) return null;
    return { kind: 'script', path, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
  }

  function moveDrag(drag, x, y) {
    positions.set(drag.path, { x, y });
  }

  function endDrag(drag) {
    if (drag.moved) savePositions();
  }

  // Sidebar for a selected script.
  function panel(path) {
    const n = nodes.find((x) => x.script.path === path);
    if (!n) return null;
    const s = n.script;
    const run = n.run;
    const facts = [
      ['Type', SCRIPT_TYPE_LABEL[s.type] ?? s.type],
      ['File', s.path],
      ['Permissions', s.profile],
    ];
    if (run) {
      facts.push(['Last run', `${new Date(run.at).toLocaleString()}${run.mode === 'dry-run' ? ' (dry run)' : ''}`]);
      if (run.validations) facts.push(['Validations', `${run.passed} of ${run.validations} passed`]);
      facts.push(['Rows read', run.rowsRead.toLocaleString()]);
      if (run.inserts + run.updates + run.deletes) facts.push(['Changes', `+${run.inserts} ~${run.updates} −${run.deletes}`]);
    }
    return [
      h('div', { class: 'sb-pad' }, [
        s.description ? h('p', { class: 'muted small' }, s.description) : null,
        h('dl', { class: 'sb-facts' }, facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        h('div', { class: 'sb-sub' }, `${RELATION[s.type] ?? 'uses'} ${n.links.length} table${n.links.length === 1 ? '' : 's'}`),
        h(
          'ul',
          { class: 'list' },
          n.links.map((k) => h('li', { class: 'clickable', onclick: () => ctx.focusTable(k) }, [h('code', {}, k)]))
        ),
        h('div', { class: 'actions' }, [
          h('button', { icon: 'toggle-workbench', onclick: () => workbench.openScript(s.path) }, 'Open script'),
          h('button', { icon: 'script-dry-run', onclick: () => workbench.runScript(s.path, 'dry-run') }, s.type === 'validator' ? 'Run validator' : 'Dry run'),
        ]),
      ]),
    ];
  }

  // Scripts linked to a table, for the table's sidebar.
  function forTable(t) {
    if (!projectDir) return [];
    const key = tableKey(t);
    const tables = diagramTables();
    const runs = workbench.runs();
    return workbench
      .scripts()
      .filter((s) => linkedTables(s, tables).includes(key))
      .map((s) => ({ script: s, run: runs[s.path] ?? null, relation: RELATION[s.type] ?? 'uses' }));
  }

  return {
    render,
    boxes,
    startDrag,
    moveDrag,
    endDrag,
    panel,
    forTable,
    shown: () => show,
    setShown,
    title: (path) => nodes.find((n) => n.script.path === path)?.script.name ?? path,
    exists: (path) => nodes.some((n) => n.script.path === path),
    open: (path) => workbench.openScript(path),
  };
}
