// Reads the schema of a Microsoft SQL Server database for "Import from SQL Server".
//
// Only the catalog views (sys.tables, sys.columns, sys.indexes,
// sys.foreign_keys, sys.extended_properties) are queried, inside one
// connection that is closed afterwards. The result has the shape that
// src/renderer/lib/mssqlimport.js reads, the same one its T-SQL script parser
// produces:
//   { tables: [{ schema, name, description, columns: [{ name, type, length,
//     precision, scale, nullable, identity, computed, default, description }],
//     primaryKey: [col], uniques: [[col]], foreignKeys: [{ columns, refSchema,
//     refTable, refColumns }] }] }
// `type` is the SQL Server base type ("nvarchar", "decimal", "geography"…),
// `length` the declared length in characters (-1 for max), and `default` the
// definition of the default constraint as SQL Server stores it ("((0))").

const TABLES = `
SELECT t.object_id AS id, s.name AS schema_name, t.name,
       CAST(ep.value AS nvarchar(max)) AS description
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN sys.extended_properties ep
  ON ep.class = 1 AND ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
WHERE t.is_ms_shipped = 0 AND t.name <> 'sysdiagrams'
ORDER BY s.name, t.name`;

const COLUMNS = `
SELECT c.object_id AS id, c.name,
       CASE WHEN ty.is_assembly_type = 1 THEN ty.name ELSE TYPE_NAME(c.system_type_id) END AS type_name,
       c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed,
       dc.definition AS default_definition,
       CAST(ep.value AS nvarchar(max)) AS description
FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN sys.extended_properties ep
  ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
WHERE t.is_ms_shipped = 0
ORDER BY c.object_id, c.column_id`;

const KEYS = `
SELECT i.object_id AS id, i.index_id, i.is_primary_key, i.has_filter, col.name AS column_name
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
WHERE t.is_ms_shipped = 0 AND (i.is_primary_key = 1 OR i.is_unique = 1)
ORDER BY i.object_id, i.index_id, ic.key_ordinal`;

const FOREIGN_KEYS = `
SELECT fk.parent_object_id AS id, fk.object_id AS fk_id, rs.name AS ref_schema, rt.name AS ref_table,
       pc.name AS column_name, rc.name AS ref_column
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
ORDER BY fk.object_id, fkc.constraint_column_id`;

const UNICODE = new Set(['nchar', 'nvarchar']);
const SIZED = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary']);

/** The catalog of the result sets of the four queries above. */
function catalogFromRows({ tables, columns, keys, foreignKeys }) {
  const byId = new Map();
  const out = tables.map((t) => {
    const table = { schema: t.schema_name, name: t.name, description: t.description ?? '', columns: [], primaryKey: [], uniques: [], foreignKeys: [] };
    byId.set(t.id, table);
    return table;
  });
  for (const c of columns) {
    const t = byId.get(c.id);
    if (!t) continue;
    const type = String(c.type_name).toLowerCase();
    let length = null;
    if (SIZED.has(type)) length = c.max_length === -1 ? -1 : UNICODE.has(type) ? c.max_length / 2 : c.max_length;
    t.columns.push({
      name: c.name,
      type,
      length,
      precision: c.precision ?? null,
      scale: c.scale ?? null,
      nullable: !!c.is_nullable,
      identity: !!c.is_identity,
      computed: !!c.is_computed,
      default: c.default_definition ?? '',
      description: c.description ?? '',
    });
  }
  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r.id}:${r[key]}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m.values()];
  };
  for (const rows of group(keys, 'index_id')) {
    const t = byId.get(rows[0].id);
    if (!t) continue;
    const cols = rows.map((r) => r.column_name);
    if (rows[0].is_primary_key) t.primaryKey = cols;
    else if (!rows[0].has_filter) t.uniques.push(cols);
  }
  for (const rows of group(foreignKeys, 'fk_id')) {
    const t = byId.get(rows[0].id);
    if (!t) continue;
    t.foreignKeys.push({
      columns: rows.map((r) => r.column_name),
      refSchema: rows[0].ref_schema,
      refTable: rows[0].ref_table,
      refColumns: rows.map((r) => r.ref_column),
    });
  }
  return { tables: out };
}

/**
 * Connection settings of the import dialog as an mssql configuration:
 * { server ("host" or "host\\instance"), port, database, user, password,
 *   auth ('sql' | 'ntlm'), domain, encrypt, trustServerCertificate }.
 */
function mssqlConfig(conn = {}) {
  const [server, instanceName] = String(conn.server || 'localhost').trim().split('\\');
  const port = parseInt(conn.port, 10);
  const config = {
    server: server || 'localhost',
    database: String(conn.database || '').trim() || undefined,
    connectionTimeout: 15000,
    requestTimeout: 60000,
    pool: { max: 1, min: 0 },
    options: {
      encrypt: conn.encrypt !== false,
      trustServerCertificate: !!conn.trustServerCertificate,
      appName: 'pgsql-erd',
      ...(instanceName && !Number.isFinite(port) ? { instanceName } : {}),
    },
  };
  // A named instance is found through the SQL Browser service unless a port is given.
  if (Number.isFinite(port)) config.port = port;
  else if (!instanceName) config.port = 1433;
  if (conn.auth === 'ntlm') {
    config.authentication = { type: 'ntlm', options: { userName: conn.user || '', password: conn.password || '', domain: conn.domain || '' } };
  } else {
    config.user = conn.user || '';
    config.password = conn.password || '';
  }
  return config;
}

/** { server, database, version, catalog } for the database of `conn`. */
async function readMssqlCatalog(conn) {
  const sql = require('mssql');
  const pool = new sql.ConnectionPool(mssqlConfig(conn));
  await pool.connect();
  try {
    const q = async (text) => (await pool.request().query(text)).recordset;
    const [info] = await q("SELECT DB_NAME() AS database_name, @@SERVERNAME AS server_name, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version");
    const catalog = catalogFromRows({ tables: await q(TABLES), columns: await q(COLUMNS), keys: await q(KEYS), foreignKeys: await q(FOREIGN_KEYS) });
    return { server: info.server_name, database: info.database_name, version: info.version, catalog };
  } finally {
    await pool.close();
  }
}

module.exports = { readMssqlCatalog, catalogFromRows, mssqlConfig };
