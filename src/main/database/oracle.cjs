// Reads the schema of an Oracle Database user (schema) for "Import from
// Oracle", and opens the connections "Copy rows" reads from.
//
// node-oracledb runs in Thin mode: pure JavaScript, no Oracle Client
// libraries, Oracle Database 12.1 or later. Only the ALL_* dictionary views
// are queried. The catalog:
//   { tables: [{ schema, name, description, columns: [{ name, type, length,
//     precision, scale, nullable, identity, virtual, default, description }],
//     primaryKey: [col], uniques: [[col]], foreignKeys: [{ columns, refSchema,
//     refTable, refColumns }] }] }
// `type` is the Oracle data type as the dictionary names it ("NUMBER",
// "VARCHAR2", "TIMESTAMP(6) WITH TIME ZONE"…), `length` the length in
// characters for character types and in bytes for RAW, `default` the
// DATA_DEFAULT text. Tables of the imported schema have schema null.

/**
 * Connection settings of the import dialog as node-oracledb options:
 * { host, port, service, user, password, schema }.
 */
function oracleConfig(conn = {}) {
  const port = parseInt(conn.port, 10);
  const host = String(conn.host || 'localhost').trim();
  const service = String(conn.service || '').trim();
  return {
    user: conn.user || '',
    password: conn.password || '',
    connectString: `${host}:${Number.isFinite(port) ? port : 1521}${service ? `/${service}` : ''}`,
    connectTimeout: 15,
  };
}

// A UTC session. Dates and timestamps are read with TO_CHAR (see data-copy.cjs):
// Thin mode does not use the session's NLS formats.
const SESSION = ["ALTER SESSION SET TIME_ZONE = '+00:00'"];

/** An open connection in UTC; see fetchTypeHandler for how values come back. */
async function oracleConnection(conn) {
  const oracledb = require('oracledb');
  const connection = await oracledb.getConnection(oracleConfig(conn));
  for (const sql of SESSION) await connection.execute(sql);
  return connection;
}

// Numbers as text (every digit kept), CLOBs as strings, BLOBs as Buffers.
function fetchTypeHandler(meta) {
  const oracledb = require('oracledb');
  const t = meta.dbType;
  if (t === oracledb.DB_TYPE_NUMBER || t === oracledb.DB_TYPE_CLOB || t === oracledb.DB_TYPE_NCLOB || t === oracledb.DB_TYPE_LONG) {
    return { type: oracledb.STRING };
  }
  if (t === oracledb.DB_TYPE_BLOB || t === oracledb.DB_TYPE_LONG_RAW) return { type: oracledb.BUFFER };
  return undefined;
}

const TABLES = `
SELECT t.table_name AS name, c.comments AS description
FROM all_tables t
LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
WHERE t.owner = :owner AND t.temporary = 'N' AND t.secondary = 'N' AND t.nested = 'NO' AND t.dropped = 'NO'
  AND NVL(t.iot_type, '-') <> 'IOT_OVERFLOW'
  AND t.table_name NOT LIKE 'BIN$%' AND t.table_name NOT LIKE 'MLOG$\\_%' ESCAPE '\\' AND t.table_name NOT LIKE 'RUPD$\\_%' ESCAPE '\\'
  AND NOT EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = t.owner AND m.mview_name = t.table_name)
ORDER BY t.table_name`;

const COLUMNS = `
SELECT c.table_name, c.column_name AS name, c.data_type, c.data_length, c.char_length, c.data_precision, c.data_scale,
       c.nullable, c.data_default, c.identity_column, c.virtual_column, m.comments AS description
FROM all_tab_cols c
JOIN all_tables t ON t.owner = c.owner AND t.table_name = c.table_name
LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
WHERE c.owner = :owner AND c.hidden_column = 'NO'
ORDER BY c.table_name, c.column_id`;

const CONSTRAINTS = `
SELECT c.table_name, c.constraint_name, c.constraint_type, cc.column_name, cc.position,
       r.owner AS ref_owner, r.table_name AS ref_table, rc.column_name AS ref_column
FROM all_constraints c
JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name AND cc.table_name = c.table_name
LEFT JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
LEFT JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
WHERE c.owner = :owner AND c.constraint_type IN ('P', 'U', 'R') AND c.table_name NOT LIKE 'BIN$%'
ORDER BY c.table_name, c.constraint_name, cc.position`;

const UNIQUE_INDEXES = `
SELECT i.table_name, i.index_name, ic.column_name, ic.column_position
FROM all_indexes i
JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
WHERE i.table_owner = :owner AND i.uniqueness = 'UNIQUE' AND i.index_type NOT LIKE 'FUNCTION%'
ORDER BY i.table_name, i.index_name, ic.column_position`;

/** The catalog of the result sets of the queries above (rows with lower-case keys). */
function catalogFromRows({ owner, tables, columns, constraints, uniqueIndexes }) {
  const byName = new Map();
  const out = tables.map((t) => {
    const table = { schema: null, name: t.name, description: t.description ?? '', columns: [], primaryKey: [], uniques: [], foreignKeys: [] };
    byName.set(t.name, table);
    return table;
  });
  for (const c of columns) {
    const t = byName.get(c.table_name);
    if (!t) continue;
    const type = String(c.data_type);
    const isChar = /CHAR/.test(type);
    t.columns.push({
      name: c.name,
      type,
      length: isChar ? Number(c.char_length) || null : /^RAW$/.test(type) ? Number(c.data_length) : null,
      precision: c.data_precision === null || c.data_precision === undefined ? null : Number(c.data_precision),
      scale: c.data_scale === null || c.data_scale === undefined ? null : Number(c.data_scale),
      nullable: c.nullable === 'Y',
      identity: c.identity_column === 'YES',
      virtual: c.virtual_column === 'YES',
      default: c.data_default === null || c.data_default === undefined ? '' : String(c.data_default).trim(),
      description: c.description ?? '',
    });
  }
  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r.table_name}\u0000${r[key]}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m.values()];
  };
  const keySets = new Map(); // table -> Set of column lists already unique
  for (const rows of group(constraints, 'constraint_name')) {
    const t = byName.get(rows[0].table_name);
    if (!t) continue;
    const cols = rows.map((r) => r.column_name);
    const kind = rows[0].constraint_type;
    if (kind === 'P') t.primaryKey = cols;
    else if (kind === 'U') t.uniques.push(cols);
    else if (kind === 'R' && rows[0].ref_table) {
      t.foreignKeys.push({
        columns: cols,
        refSchema: rows[0].ref_owner === owner ? null : rows[0].ref_owner,
        refTable: rows[0].ref_table,
        refColumns: rows.map((r) => r.ref_column),
      });
    }
    if (kind !== 'R') {
      if (!keySets.has(t)) keySets.set(t, new Set());
      keySets.get(t).add(cols.join('\u0000'));
    }
  }
  // Unique indexes that are not behind a constraint.
  for (const rows of group(uniqueIndexes, 'index_name')) {
    const t = byName.get(rows[0].table_name);
    if (!t) continue;
    const cols = rows.map((r) => r.column_name);
    const seen = keySets.get(t) ?? new Set();
    if (!seen.has(cols.join('\u0000'))) t.uniques.push(cols);
    seen.add(cols.join('\u0000'));
    keySets.set(t, seen);
  }
  return { tables: out };
}

const lower = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));

/** { server, database, version, catalog } for the schema of `conn` (its user unless `schema` is given). */
async function readOracleCatalog(conn) {
  const oracledb = require('oracledb');
  const connection = await oracleConnection(conn);
  try {
    const q = async (sql, binds = {}) =>
      lower((await connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler: (m) => (m.dbType === oracledb.DB_TYPE_LONG ? { type: oracledb.STRING } : undefined) })).rows);
    const [info] = await q("SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') AS session_user, SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS service FROM dual");
    // A schema name typed in lower case means the usual upper-case one, unless it was created quoted.
    let owner = String(conn.schema || '').trim() || info.session_user;
    const [exists] = await q('SELECT COUNT(*) AS n FROM all_users WHERE username = :owner', { owner });
    if (!Number(exists.n) && owner !== owner.toUpperCase()) owner = owner.toUpperCase();
    const catalog = catalogFromRows({
      owner,
      tables: await q(TABLES, { owner }),
      columns: await q(COLUMNS, { owner }),
      constraints: await q(CONSTRAINTS, { owner }),
      uniqueIndexes: await q(UNIQUE_INDEXES, { owner }),
    });
    catalog.owner = owner;
    return { server: `${conn.host || 'localhost'}`, database: owner, service: info.service, version: connection.oracleServerVersionString, owner, catalog };
  } finally {
    await connection.close();
  }
}

module.exports = { readOracleCatalog, oracleConfig, oracleConnection, fetchTypeHandler, catalogFromRows };
