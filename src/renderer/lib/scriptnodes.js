// Scripts shown as entities in the diagram: which tables a script is linked
// to, what its box says, where new boxes go and how links are drawn.
// Pure functions, so they can be tested without a page.

import { tablesMentioned } from '../../shared/scripts.js';
import { tr, trn, formatNumber } from '../../shared/i18n.js';

export const SCRIPT_W = 220;
export const SCRIPT_HEADER = 30;
export const SCRIPT_ROW = 20;
const PAD_BOTTOM = 8;

// How a script relates to the tables it uses, by script type.
export const RELATION = {
  validator: tr('validates'),
  generator: tr('generates'),
  seeder: tr('seeds'),
  migration: tr('migrates'),
  import: tr('imports into'),
  export: tr('exports from'),
  query: tr('queries'),
  maintenance: tr('maintains'),
};

export const SCRIPT_TYPE_LABEL = {
  validator: tr('Validator'),
  generator: tr('Generator'),
  seeder: tr('Seeder'),
  migration: tr('Migration'),
  import: tr('Import'),
  export: tr('Export'),
  query: tr('Query'),
  maintenance: tr('Maintenance'),
};

// Diagram tables a script is linked to: the tables in its metadata plus the
// tables its source names. tables: [{ key: 'schema.name', schema, name }].
export function linkedTables(script, tables) {
  const keys = new Set();
  const byKey = new Map(tables.map((t) => [t.key, t]));
  for (const k of script.tables ?? []) {
    const hit = byKey.get(k) ?? byKey.get(`public.${k}`) ?? tables.find((t) => t.name === k);
    if (hit) keys.add(hit.key);
  }
  const mentioned = tablesMentioned(script.source ?? '', tables.map((t) => ({ id: t.key, name: t.name })));
  for (const k of mentioned) keys.add(k);
  return [...keys];
}

// run: { status: 'passed' | 'failed' | 'error' | 'ok', validations, passed, errors, rowsRead, inserts, updates, deletes, mode }
export function scriptLines(script, run) {
  const lines = [{ text: `${SCRIPT_TYPE_LABEL[script.type] ?? script.type} · TypeScript`, cls: 's-line' }];
  if (!run) {
    lines.push({ text: tr('Not run yet'), cls: 's-line muted' });
    return lines;
  }
  if (run.status === 'error') lines.push({ text: tr('Last run: ERROR'), cls: 's-status fail' });
  else if (run.validations) {
    const pass = run.passed === run.validations;
    lines.push({
      text: `${pass ? tr('Last run: PASS') : tr('Last run: FAIL')} (${run.passed}/${run.validations})`,
      cls: `s-status ${pass ? 'pass' : 'fail'}`,
    });
    if (run.errors) lines.push({ text: trn(run.errors, '{n} error', '{n} errors', { n: formatNumber(run.errors) }), cls: 's-line fail' });
  } else {
    const changes = (run.inserts ?? 0) + (run.updates ?? 0) + (run.deletes ?? 0);
    lines.push({ text: run.mode === 'dry-run' ? tr('Last run: OK (dry run)') : tr('Last run: OK'), cls: 's-status pass' });
    if (changes) lines.push({ text: tr('+{inserts} ~{updates} −{deletes} rows', { inserts: run.inserts, updates: run.updates, deletes: run.deletes }), cls: 's-line' });
  }
  if (run.rowsRead)
    lines.push({
      text: script.type === 'validator'
        ? trn(run.rowsRead, '{n} row checked', '{n} rows checked', { n: formatNumber(run.rowsRead) })
        : trn(run.rowsRead, '{n} row read', '{n} rows read', { n: formatNumber(run.rowsRead) }),
      cls: 's-line muted',
    });
  return lines;
}

// titleWidth: measured width of the script name, so it isn't clipped (up to 360px).
export const scriptSize = (lines, titleWidth = 0) => ({
  width: Math.min(360, Math.max(SCRIPT_W, Math.ceil(titleWidth) + 44)),
  height: SCRIPT_HEADER + lines.length * SCRIPT_ROW + PAD_BOTTOM,
});

const overlaps = (a, b, gap = 16) =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

// Positions for scripts that have none yet: to the right of the tables they
// are linked to, moved down until they don't overlap anything.
// scripts: [{ path, links: [tableKey], size }]; tableBoxes: Map key -> box;
// positions: Map path -> { x, y } (existing, kept).
export function placeScripts(scripts, tableBoxes, positions) {
  const out = new Map(positions);
  const taken = [...tableBoxes.values()];
  for (const s of scripts) if (out.has(s.path)) taken.push({ ...out.get(s.path), ...s.size });
  const all = [...tableBoxes.values()];
  const right = all.length ? Math.max(...all.map((b) => b.x + b.width)) : 0;
  const top = all.length ? Math.min(...all.map((b) => b.y)) : 0;
  for (const s of scripts) {
    if (out.has(s.path)) continue;
    const linked = s.links.map((k) => tableBoxes.get(k)).filter(Boolean);
    let x = linked.length ? Math.max(...linked.map((b) => b.x + b.width)) + 80 : right + 80;
    let y = linked.length ? Math.min(...linked.map((b) => b.y)) : top;
    const box = { x, y, ...s.size };
    for (let i = 0; i < 400 && taken.some((t) => overlaps(box, t)); i++) {
      box.y += 20;
      // Far below everything: start a new column further right.
      if (i % 60 === 59) {
        box.x += SCRIPT_W + 60;
        box.y = y;
      }
    }
    x = Math.round(box.x);
    y = Math.round(box.y);
    out.set(s.path, { x, y });
    taken.push({ x, y, ...s.size });
  }
  return out;
}

// A curved link between two boxes. mode 'horizontal' leaves and enters on
// the left/right sides, 'vertical' on the top/bottom, 'auto' picks the
// facing sides. Returns { path, mid, end, points } (points: samples along
// the curve).
export function connect(a, b, mode = 'auto') {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  let p1, p2, c1, c2;
  const horizontal = mode === 'horizontal' || (mode === 'auto' && (b.x > a.x + a.width || a.x > b.x + b.width));
  if (horizontal) {
    const dir = bc.x > ac.x ? 1 : -1;
    p1 = { x: dir > 0 ? a.x + a.width : a.x, y: ac.y };
    p2 = { x: dir > 0 ? b.x : b.x + b.width, y: bc.y };
    const d = Math.max(40, Math.abs(p2.x - p1.x) / 2);
    c1 = { x: p1.x + dir * d, y: p1.y };
    c2 = { x: p2.x - dir * d, y: p2.y };
  } else {
    const dir = bc.y > ac.y ? 1 : -1;
    p1 = { x: ac.x, y: dir > 0 ? a.y + a.height : a.y };
    p2 = { x: bc.x, y: dir > 0 ? b.y : b.y + b.height };
    const d = Math.max(30, Math.abs(p2.y - p1.y) / 2);
    c1 = { x: p1.x, y: p1.y + dir * d };
    c2 = { x: p2.x, y: p2.y - dir * d };
  }
  const r = (v) => Math.round(v * 10) / 10;
  const at = (t) => {
    const u = 1 - t;
    return {
      x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
      y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
    };
  };
  const m = at(0.5);
  return {
    path: `M${r(p1.x)},${r(p1.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p2.x)},${r(p2.y)}`,
    mid: { x: r(m.x), y: r(m.y) },
    end: p2,
    points: Array.from({ length: 19 }, (_, i) => at((i + 1) / 20)),
  };
}

const inside = (p, b) => p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height;

// The link between a script box and a table that passes through the fewest
// other boxes (obstacles), preferring the facing sides.
export function route(a, b, obstacles = []) {
  let best = null;
  for (const mode of ['auto', 'vertical', 'horizontal']) {
    const c = connect(a, b, mode);
    const hits = c.points.filter((p) => obstacles.some((o) => inside(p, o)) || inside(p, a) || inside(p, b)).length;
    if (!best || hits < best.hits) best = { ...c, hits };
    if (!hits) break;
  }
  return best;
}
