// Table data for the data browser tabs: pages of rows with Excel-style
// filters and sorting, and the distinct values of a column for its filter
// list. Values are returned as PostgreSQL's text output so the grid, the
// filter list and the filters themselves all compare the same strings.
// Everything runs in read-only transactions.
//
// filters: { [column]: { values?: string[], blanks?: boolean, cond?: { op, value, value2 } } }
//   values/blanks: the ticked entries of the value list (absent = all)
//   cond: contains, notContains, equals, notEquals, beginsWith, endsWith,
//         gt, gte, lt, lte, between, empty, notEmpty
// sort: [{ column, direction: 'asc' | 'desc' }]

const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Types whose values sort and group naturally; others are grouped as text.
const ORDERABLE = /^(smallint|integer|bigint|int[248]?|numeric|decimal|real|double precision|float[48]|money|serial|bigserial|smallserial|boolean|bool|date|time.*|timestamp.*|interval|text|character.*|varchar|char|bpchar|citext|name|uuid|inet|cidr|oid)$/;

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

function columnOf(table, name) {
  const c = table.columns.find((x) => x.name === name);
  if (!c) throw new Error(`Unknown column ${name} in ${table.id}`);
  return c;
}

// WHERE clause for the filters, skipping `except` (the column whose own
// value list is being built, as Excel does).
function whereClause(table, filters = {}, params = [], except = null) {
  const parts = [];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  for (const [name, f] of Object.entries(filters ?? {})) {
    if (!f || name === except) continue;
    const c = quote(columnOf(table, name).name);
    const text = `${c}::text`;
    if (Array.isArray(f.values)) {
      const alts = [];
      if (f.values.length) alts.push(`${text} = ANY(${p(f.values.map(String))}::text[])`);
      if (f.blanks) alts.push(`${c} IS NULL`, `${text} = ''`);
      parts.push(alts.length ? `(${alts.join(' OR ')})` : 'FALSE');
    }
    const cond = f.cond;
    if (cond?.op) {
      const v = cond.value ?? '';
      switch (cond.op) {
        case 'contains':
          parts.push(`${text} ILIKE ${p(`%${likeEscape(v)}%`)}`);
          break;
        case 'notContains':
          parts.push(`(${c} IS NULL OR ${text} NOT ILIKE ${p(`%${likeEscape(v)}%`)})`);
          break;
        case 'beginsWith':
          parts.push(`${text} ILIKE ${p(`${likeEscape(v)}%`)}`);
          break;
        case 'endsWith':
          parts.push(`${text} ILIKE ${p(`%${likeEscape(v)}`)}`);
          break;
        case 'equals':
          parts.push(`${text} = ${p(String(v))}`);
          break;
        case 'notEquals':
          parts.push(`${text} IS DISTINCT FROM ${p(String(v))}`);
          break;
        // Comparisons use the column's own type (PostgreSQL casts the parameter).
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte':
          parts.push(`${c} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[cond.op]} ${p(String(v))}`);
          break;
        case 'between':
          parts.push(`${c} BETWEEN ${p(String(v))} AND ${p(String(cond.value2 ?? ''))}`);
          break;
        case 'empty':
          parts.push(`(${c} IS NULL OR ${text} = '')`);
          break;
        case 'notEmpty':
          parts.push(`(${c} IS NOT NULL AND ${text} <> '')`);
          break;
        default:
          throw new Error(`Unknown filter: ${cond.op}`);
      }
    }
  }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

function browseQuery(table, { filters, sort, limit = 100, offset = 0 } = {}) {
  const params = [];
  // Columns are selected as text under their own names, so ORDER BY must
  // name the table's columns (t."col") to sort by their real types.
  const from = `${quote(table.schema)}.${quote(table.name)} AS t`;
  const where = whereClause(table, filters, params);
  const cols = table.columns.map((c) => `t.${quote(c.name)}::text AS ${quote(c.name)}`).join(', ');
  let order = (sort ?? [])
    .filter((s) => s?.column)
    .map((s) => {
      const c = columnOf(table, s.column);
      const expr = ORDERABLE.test(c.baseType) && !c.isArray ? `t.${quote(c.name)}` : `t.${quote(c.name)}::text`;
      return `${expr} ${s.direction === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`;
    });
  // A stable order for paging: the primary key.
  for (const k of table.primaryKey?.columns ?? []) if (!(sort ?? []).some((s) => s.column === k)) order.push(`t.${quote(k)}`);
  const lim = Math.min(5000, Math.max(1, Math.floor(Number(limit) || 100)));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  return {
    sql: `SELECT ${cols} FROM ${from}${where}${order.length ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT ${lim} OFFSET ${off}`,
    countSql: `SELECT count(*)::bigint AS n FROM ${from}${where}`,
    params,
  };
}

function distinctQuery(table, column, { filters, search, limit = 500 } = {}) {
  const c = columnOf(table, column);
  const params = [];
  const from = `${quote(table.schema)}.${quote(table.name)}`;
  let where = whereClause(table, filters, params, column);
  if (search) {
    params.push(`%${likeEscape(search)}%`);
    where += `${where ? ' AND' : ' WHERE'} ${quote(c.name)}::text ILIKE $${params.length}`;
  }
  const lim = Math.min(5000, Math.max(1, Math.floor(Number(limit) || 500)));
  const typed = ORDERABLE.test(c.baseType) && !c.isArray;
  const key = typed ? quote(c.name) : `${quote(c.name)}::text`;
  return {
    sql: `SELECT ${key}::text AS value, count(*)::bigint AS n FROM ${from}${where} GROUP BY ${key} ORDER BY ${key} NULLS FIRST LIMIT ${lim + 1}`,
    params,
    limit: lim,
  };
}

// readOnly(fn) runs fn(client) in a read-only transaction.
async function browse(readOnly, table, opts) {
  const q = browseQuery(table, opts);
  return readOnly(async (client) => {
    const [rows, count] = [await client.query(q.sql, q.params), await client.query(q.countSql, q.params)];
    return {
      table: table.id,
      columns: table.columns.map((c) => ({ name: c.name, type: c.databaseType, baseType: c.baseType, nullable: c.nullable })),
      primaryKey: table.primaryKey?.columns ?? [],
      rows: rows.rows,
      total: Number(count.rows[0].n),
    };
  });
}

async function distinct(readOnly, table, column, opts) {
  const q = distinctQuery(table, column, opts);
  return readOnly(async (client) => {
    const r = await client.query(q.sql, q.params);
    const values = r.rows.slice(0, q.limit).map((x) => ({ value: x.value, count: Number(x.n) }));
    return { values, truncated: r.rows.length > q.limit };
  });
}

module.exports = { browse, distinct, browseQuery, distinctQuery, whereClause };
