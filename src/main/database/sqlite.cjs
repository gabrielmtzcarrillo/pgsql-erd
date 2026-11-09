// Reads the schema of a SQLite database file for "Import from SQLite Database".
//
// The file is opened read-only with Node's built-in SQLite and only its
// catalog is queried; src/renderer/lib/sqliteimport.js turns the result into
// table specs for the import dialog.

const SQLITE_EXTENSIONS = ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'];

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * { tables: [{ name, sql, columns, foreignKeys, indexes }] } for the ordinary
 * tables of the database: `columns` are PRAGMA table_xinfo rows, `foreignKeys`
 * PRAGMA foreign_key_list rows and `indexes` PRAGMA index_list rows with the
 * names of their `columns` (null for an expression).
 */
function readSqliteCatalog(filePath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const all = (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
    const tables = all("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid");
    // Virtual tables and their shadow tables hold no schema worth drawing.
    const kinds = new Map(all('PRAGMA table_list').filter((t) => t.schema === 'main').map((t) => [t.name, t.type]));
    return {
      tables: tables
        .filter((t) => (kinds.get(t.name) ?? 'table') === 'table')
        .map((t) => ({
          name: t.name,
          sql: t.sql ?? '',
          columns: all(`PRAGMA table_xinfo(${quote(t.name)})`),
          foreignKeys: all(`PRAGMA foreign_key_list(${quote(t.name)})`),
          indexes: all(`PRAGMA index_list(${quote(t.name)})`).map((ix) => ({
            ...ix,
            columns: all(`PRAGMA index_info(${quote(ix.name)})`).map((c) => c.name),
          })),
        })),
    };
  } finally {
    db.close();
  }
}

module.exports = { readSqliteCatalog, SQLITE_EXTENSIONS };
