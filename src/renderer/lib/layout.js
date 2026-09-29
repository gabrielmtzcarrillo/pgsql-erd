// Table geometry, relationship routing and auto layout. No DOM access here;
// text measurement is injected so this module can run under Node.

import { formatType } from './sql.js';

export const HEADER_H = 30;
export const ROW_H = 22;
export const PAD_X = 10;
export const BADGE_W = 26;
export const MIN_W = 180;

export function tableSize(table, measure) {
  const header = measure(table.name, true) + PAD_X * 2 + 20;
  let widest = 0;
  for (const c of table.columns) {
    widest = Math.max(widest, measure(c.name) + measure(formatType(c)) + 24);
  }
  const width = Math.ceil(Math.max(MIN_W, header, widest + BADGE_W + PAD_X * 2));
  const height = HEADER_H + Math.max(1, table.columns.length) * ROW_H + 6;
  return { width, height };
}

export function columnY(table, attnum) {
  const idx = table.columns.findIndex((c) => c.attnum === attnum);
  return table.y + HEADER_H + (Math.max(0, idx) + 0.5) * ROW_H;
}

// Returns the endpoints of a relationship and an SVG path between them.
// `sizes` maps table id -> {width, height}.
export function routeLink(link, local, ref, sizes) {
  const ls = sizes.get(local.id);
  const rs = sizes.get(ref.id);
  const ly = columnY(local, link.localCol);
  const ry = columnY(ref, link.refCol);
  const lcx = local.x + ls.width / 2;
  const rcx = ref.x + rs.width / 2;
  const STUB = 18;

  let lx, rx, ldir, rdir;
  if (local === ref) {
    lx = local.x + ls.width;
    rx = lx;
    ldir = rdir = 1;
  } else if (local.x + ls.width + 2 * STUB < ref.x) {
    lx = local.x + ls.width; ldir = 1;
    rx = ref.x; rdir = -1;
  } else if (ref.x + rs.width + 2 * STUB < local.x) {
    lx = local.x; ldir = -1;
    rx = ref.x + rs.width; rdir = 1;
  } else {
    // Tables overlap horizontally: loop around on the same side.
    const right = lcx >= rcx;
    ldir = rdir = right ? 1 : -1;
    lx = right ? local.x + ls.width : local.x;
    rx = right ? ref.x + rs.width : ref.x;
  }

  const a = { x: lx + ldir * STUB, y: ly };
  const b = { x: rx + rdir * STUB, y: ry };
  let path;
  if (ldir === rdir) {
    const edge = ldir > 0 ? Math.max(a.x, b.x) + 30 : Math.min(a.x, b.x) - 30;
    path = `M${lx},${ly} L${a.x},${a.y} C${edge},${a.y} ${edge},${b.y} ${b.x},${b.y} L${rx},${ry}`;
  } else {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    path = `M${lx},${ly} L${a.x},${a.y} C${a.x + ldir * dx},${a.y} ${b.x + rdir * dx},${b.y} ${b.x},${b.y} L${rx},${ry}`;
  }
  return { path, local: { x: lx, y: ly, dir: ldir }, ref: { x: rx, y: ry, dir: rdir } };
}

// Crow's foot ("many") marker at an endpoint on a table edge.
export function crowFoot({ x, y, dir }) {
  const d = 12 * dir;
  return `M${x + d},${y} L${x},${y - 7} M${x + d},${y} L${x},${y} M${x + d},${y} L${x},${y + 7} M${x + d + 3 * dir},${y - 6} L${x + d + 3 * dir},${y + 6}`;
}

// Double bar ("exactly one") marker.
export function oneMarker({ x, y, dir }) {
  const d1 = 8 * dir;
  const d2 = 12 * dir;
  return `M${x + d1},${y - 6} L${x + d1},${y + 6} M${x + d2},${y - 6} L${x + d2},${y + 6}`;
}

// Layered layout: referenced tables to the left of the tables referencing them.
export function autoLayout(model, sizes, { gapX = 120, gapY = 50 } = {}) {
  const rank = new Map();
  const refsOf = new Map(model.tables.map((t) => [t.id, new Set()]));
  for (const l of model.links) {
    if (l.localTable !== l.refTable && refsOf.has(l.localTable)) {
      refsOf.get(l.localTable).add(l.refTable);
    }
  }
  const visiting = new Set();
  const rankOf = (id) => {
    if (rank.has(id)) return rank.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let r = 0;
    for (const ref of refsOf.get(id) ?? []) {
      if (refsOf.has(ref)) r = Math.max(r, rankOf(ref) + 1);
    }
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  model.tables.forEach((t) => rankOf(t.id));

  const columns = [];
  for (const t of model.tables) {
    const r = rank.get(t.id);
    (columns[r] ??= []).push(t);
  }
  // Order each column by the average position of the tables it references
  // (barycenter heuristic) to reduce crossing lines.
  const pos = new Map();
  const incoming = new Map(model.tables.map((t) => [t.id, 0]));
  for (const refs of refsOf.values()) for (const r of refs) incoming.set(r, (incoming.get(r) ?? 0) + 1);
  const key = (t) => {
    const p = [...(refsOf.get(t.id) ?? [])].filter((r) => pos.has(r)).map((r) => pos.get(r));
    return p.length ? p.reduce((a, b) => a + b, 0) / p.length : Infinity;
  };
  let x = 40;
  for (const col of columns) {
    if (!col) continue;
    col.sort((a, b) =>
      key(a) - key(b) || (incoming.get(b.id) - incoming.get(a.id)) || a.name.localeCompare(b.name)
    );
    col.forEach((t, i) => pos.set(t.id, i));
    let y = 40;
    let w = 0;
    for (const t of col) {
      const s = sizes.get(t.id);
      t.x = x;
      t.y = y;
      y += s.height + gapY;
      w = Math.max(w, s.width);
    }
    x += w + gapX;
  }
}

export function contentBounds(model, sizes, margin = 40) {
  if (!model.tables.length) return { x: 0, y: 0, width: 400, height: 300 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of model.tables) {
    const s = sizes.get(t.id);
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + s.width);
    maxY = Math.max(maxY, t.y + s.height);
  }
  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  };
}
