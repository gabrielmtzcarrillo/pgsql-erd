// PostgreSQL access for the main process. Each call opens a short-lived
// connection; the renderer keeps the connection settings (password in
// memory only) and passes them with every request.

const { Client } = require('pg');

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;

function clientConfig(conn) {
  const ssl =
    conn.sslmode === 'require' ? { rejectUnauthorized: false }
    : conn.sslmode === 'verify-full' ? { rejectUnauthorized: true }
    : false;
  return {
    host: conn.host || 'localhost',
    port: Number(conn.port) || 5432,
    database: conn.database || 'postgres',
    user: conn.user || undefined,
    password: conn.password || undefined,
    ssl,
    connectionTimeoutMillis: 10000,
    application_name: 'pgsql-erd',
  };
}

async function withClient(conn, fn) {
  const client = new Client(clientConfig(conn));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function testConnection(conn) {
  return withClient(conn, async (c) => {
    const r = await c.query('SELECT version() AS version, current_database() AS database, current_user AS user');
    return r.rows[0];
  });
}

async function introspect(conn) {
  return withClient(conn, async (c) => {
    const version = Number((await c.query("SELECT current_setting('server_version_num') AS v")).rows[0].v);
    if (version < 100000) throw new Error('PostgreSQL 10 or newer is required.');
    const generated = version >= 120000 ? 'a.attgenerated' : "''";

    const schemas = await c.query(
      `SELECT n.nspname AS name FROM pg_namespace n WHERE ${SYSTEM_SCHEMAS} ORDER BY 1`
    );
    const tables = await c.query(`
      SELECT c.oid, n.nspname AS schema, c.relname AS name,
             obj_description(c.oid, 'pg_class') AS description
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${SYSTEM_SCHEMAS}
       ORDER BY 2, 3`);
    const columns = await c.query(`
      SELECT a.attrelid AS oid, a.attnum, a.attname AS name,
             format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS notnull,
             pg_get_expr(d.adbin, d.adrelid) AS default,
             NULLIF(a.attidentity, '') AS identity,
             NULLIF(${generated}, '') AS generated,
             col_description(a.attrelid, a.attnum) AS description,
             (pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'
               AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL) AS serial
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${SYSTEM_SCHEMAS}
       ORDER BY a.attrelid, a.attnum`);
    const constraints = await c.query(`
      SELECT con.conrelid AS oid, con.conname AS name, con.contype AS type,
             con.conkey AS cols, con.confrelid AS ref_oid, con.confkey AS ref_cols,
             con.confupdtype, con.confdeltype, con.confmatchtype
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE con.contype IN ('p', 'u', 'f') AND ${SYSTEM_SCHEMAS}
       ORDER BY con.conrelid, con.contype, con.conname`);

    return {
      version,
      schemas: schemas.rows.map((r) => r.name),
      tables: tables.rows,
      columns: columns.rows,
      constraints: constraints.rows,
    };
  });
}

// Run a migration script. The script manages its own transaction; if any
// statement fails we roll back so nothing is left half-applied.
async function execute(conn, sql) {
  return withClient(conn, async (c) => {
    try {
      await c.query(sql);
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      const where = err.position ? ` (at character ${err.position})` : '';
      throw new Error(`${err.message}${where}`);
    }
    return { ok: true };
  });
}

module.exports = { testConnection, introspect, execute, clientConfig };
