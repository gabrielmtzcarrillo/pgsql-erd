// Visual query builder: tables placed on a canvas, the columns ticked in
// each, and the joins between them, turned into a SELECT statement. Pure
// module so it can be tested without a page.
//
// Builder state:
//   tables: [{ id, schema, name, alias, x, y, columns: [selected column names] }]
//   joins:  [{ id, a, b, pairs: [[column of a, column of b]], type, fk }]
//           a and b are table ids; type is 'inner' | 'left' | 'right' | 'full'
//           as in "a LEFT JOIN b" (left keeps every row of a); fk names the
//           foreign key the join came from, if any.
//   distinct, limit

import { quoteIdent, qualifiedName } from './sql.js';
import { tableKey } from './catalog.js';

export const JOIN_TYPES = ['inner', 'left', 'right', 'full'];
const JOIN_SQL = { inner: 'INNER JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', full: 'FULL JOIN' };
const FLIP = { inner: 'inner', left: 'right', right: 'left', full: 'full' };

// A short alias from the initials of the table name: order_items -> oi.
// Aliases already taken, or that would need quoting, get a number.
export function aliasFor(name, taken) {
  const words = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let base = words.map((w) => w[0]).join('') || 't';
  if (!/^[a-z_]/.test(base)) base = `t${base}`;
  const ok = (a) => !taken.has(a) && quoteIdent(a) === a;
  if (ok(base)) return base;
  for (let i = 2; ; i++) if (ok(`${base}${i}`)) return `${base}${i}`;
}

// Foreign keys of a catalog model (catalog.js), one entry per constraint:
// { id, name, from, to, pairs: [[referencing column, referenced column]] }
// with from/to as table keys.
export function foreignKeys(dbModel) {
  const byId = new Map(dbModel.tables.map((t) => [t.id, t]));
  const groups = new Map();
  for (const l of dbModel.links) {
    const from = byId.get(l.localTable);
    const to = byId.get(l.refTable);
    if (!from || !to) continue;
    const g = l.group ?? l.id;
    if (!groups.has(g)) {
      const name = l.fkName ?? '';
      groups.set(g, { id: `${tableKey(from)}:${name || g}`, name, from: tableKey(from), to: tableKey(to), pairs: [] });
    }
    const a = from.columns.find((c) => c.attnum === l.localCol)?.name;
    const b = to.columns.find((c) => c.attnum === l.refCol)?.name;
    if (a && b) groups.get(g).pairs.push([a, b]);
  }
  return [...groups.values()].filter((fk) => fk.pairs.length);
}

// Joins for a table just added to the builder, from the foreign keys between
// it and the tables already there. One join per table pair; each foreign key
// is used once for the new table, preferring the most recently added tables,
// and a foreign key already joining another copy of the new table is left for
// that copy (orders joined to a billing address picks the shipping address
// for a second addresses table).
export function autoJoins(fks, tables, joins, added) {
  const key = tableKey(added);
  const byId = new Map(tables.map((t) => [t.id, t]));
  const out = [];
  const taken = new Set();
  for (const other of [...tables].reverse()) {
    if (other.id === added.id) continue;
    const okey = tableKey(other);
    const used = new Set(
      joins
        .filter((j) => (j.a === other.id && tableKey(byId.get(j.b) ?? {}) === key) || (j.b === other.id && tableKey(byId.get(j.a) ?? {}) === key))
        .map((j) => j.fk)
    );
    for (const fk of fks) {
      if (taken.has(fk.id) || used.has(fk.id)) continue;
      let join = null;
      // For a self-reference the table already there is the referencing one:
      // employees e INNER JOIN employees e2 ON e2.id = e.manager_id.
      if (fk.from === okey && fk.to === key) join = { a: other.id, b: added.id };
      else if (fk.from === key && fk.to === okey) join = { a: added.id, b: other.id };
      if (!join) continue;
      out.push({ ...join, pairs: fk.pairs.map((p) => [...p]), type: 'inner', fk: fk.id });
      taken.add(fk.id);
      break;
    }
  }
  return out;
}

// The SELECT statement for the builder state; '' with no tables.
export function buildSQL({ tables, joins = [], distinct = false, limit = null }) {
  if (!tables.length) return '';
  const byId = new Map(tables.map((t) => [t.id, t]));
  const ref = (t) => `${qualifiedName(t)} ${quoteIdent(t.alias)}`;
  const col = (t, c) => `${quoteIdent(t.alias)}.${quoteIdent(c)}`;

  // Columns picked from more than one table are named alias_column.
  const counts = new Map();
  for (const t of tables) for (const c of t.columns) counts.set(c, (counts.get(c) ?? 0) + 1);
  const select = tables.flatMap((t) =>
    t.columns.map((c) => (counts.get(c) > 1 ? `${col(t, c)} AS ${quoteIdent(`${t.alias}_${c}`)}` : col(t, c)))
  );

  // FROM the first table, then each table joined to one already placed, in
  // canvas order; tables with no join to the rest are cross joined.
  const valid = joins.filter((j) => byId.has(j.a) && byId.has(j.b) && j.a !== j.b && j.pairs.length);
  const placed = new Set();
  const from = [];
  for (const start of tables) {
    if (placed.has(start.id)) continue;
    from.push(placed.size ? `  CROSS JOIN ${ref(start)}` : `FROM ${ref(start)}`);
    placed.add(start.id);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of tables) {
        if (placed.has(t.id)) continue;
        const links = valid.filter((j) => (j.a === t.id && placed.has(j.b)) || (j.b === t.id && placed.has(j.a)));
        if (!links.length) continue;
        const first = links[0];
        const type = first.b === t.id ? first.type : FLIP[first.type];
        const cond = links.flatMap((j) =>
          j.pairs.map(([x, y]) => {
            const a = col(byId.get(j.a), x);
            const b = col(byId.get(j.b), y);
            return j.a === t.id ? `${a} = ${b}` : `${b} = ${a}`;
          })
        );
        from.push(`  ${JOIN_SQL[type] ?? 'INNER JOIN'} ${ref(t)} ON ${cond.join(' AND ')}`);
        placed.add(t.id);
        grew = true;
        break;
      }
    }
  }

  const lines = [
    select.length ? `SELECT${distinct ? ' DISTINCT' : ''}\n  ${select.join(',\n  ')}` : `SELECT${distinct ? ' DISTINCT' : ''} *`,
    ...from,
  ];
  const n = Number(limit);
  if (limit !== null && limit !== '' && Number.isInteger(n) && n >= 0) lines.push(`LIMIT ${n}`);
  return `${lines.join('\n')};`;
}

// Fits the builder state to the database as read now: tables and columns
// that no longer exist are dropped, with the joins that used them.
export function reconcile(state, dbModel) {
  const byKey = new Map(dbModel.tables.map((t) => [tableKey(t), t]));
  const names = new Map();
  const tables = [];
  for (const t of state.tables) {
    const db = byKey.get(tableKey(t));
    if (!db) continue;
    const cols = new Set(db.columns.map((c) => c.name));
    names.set(t.id, cols);
    tables.push({ ...t, columns: t.columns.filter((c) => cols.has(c)) });
  }
  const joins = state.joins
    .filter((j) => names.has(j.a) && names.has(j.b))
    .map((j) => ({ ...j, pairs: j.pairs.filter(([x, y]) => names.get(j.a).has(x) && names.get(j.b).has(y)) }))
    .filter((j) => j.pairs.length);
  return { ...state, tables, joins };
}
