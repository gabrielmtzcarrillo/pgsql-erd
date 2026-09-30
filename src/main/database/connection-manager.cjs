// Database connections per window. The renderer sends the connection
// settings (with the password) once, when connecting; after that it refers
// to the window's connection and never receives the password back. The
// connection profile carries the environment and its policy (read-only
// production, DDL allowed, …), and the last schema read is cached here as the
// canonical schema model used by scripts, typings and the assistant.

const db = require('../db.cjs');

class ConnectionManager {
  constructor({ shared, audit }) {
    this.shared = shared;
    this.audit = audit;
    this.sessions = new Map(); // windowId -> session
  }

  describe(conn) {
    return `${conn.user || 'postgres'}@${conn.host || 'localhost'}:${conn.port || 5432}/${conn.database || 'postgres'}`;
  }

  // profile: { name, environment, policy }
  async connect(windowId, conn, profile = {}) {
    const info = await db.testConnection(conn);
    const environment = this.shared.ENVIRONMENTS.includes(profile.environment) ? profile.environment : 'development';
    const session = {
      conn: { ...conn },
      profile: {
        name: String(profile.name || '').trim() || this.describe(conn),
        environment,
        policy: this.shared.normalizePolicy(environment, profile.policy),
      },
      info,
      schema: null,
      catalog: null,
      loadedAt: null,
    };
    this.sessions.set(windowId, session);
    this.audit?.log('connect', { windowId, target: this.describe(conn), environment, policy: session.profile.policy });
    return this.publicInfo(windowId);
  }

  disconnect(windowId) {
    this.sessions.delete(windowId);
  }

  get(windowId) {
    return this.sessions.get(windowId) ?? null;
  }

  require(windowId) {
    const s = this.sessions.get(windowId);
    if (!s) throw new Error('Not connected to a database. Use Database → Connect first.');
    return s;
  }

  // Everything about the connection except the password.
  publicInfo(windowId) {
    const s = this.sessions.get(windowId);
    if (!s) return null;
    const { password, ...conn } = s.conn;
    return {
      conn,
      description: this.describe(s.conn),
      profile: s.profile,
      server: s.info,
      schemaLoadedAt: s.loadedAt,
    };
  }

  // Read the catalog, rebuild the schema model and report what changed.
  async refresh(windowId) {
    const s = this.require(windowId);
    const catalog = await db.introspect(s.conn);
    const schema = this.shared.schemaFromCatalog(catalog);
    const changes = s.schema ? this.shared.summarizeSchemaChanges(s.schema, schema) : [];
    s.catalog = catalog;
    s.schema = schema;
    s.loadedAt = Date.now();
    this.audit?.log('schema-refresh', { windowId, target: this.describe(s.conn), tables: this.shared.allTables(schema).length, changes: changes.length });
    return { catalog, schema, changes };
  }

  async schema(windowId) {
    const s = this.require(windowId);
    if (!s.schema) await this.refresh(windowId);
    return s.schema;
  }

  // A dedicated client for a script run or an assistant query.
  async client(windowId) {
    const { Client } = require('pg');
    const s = this.require(windowId);
    const client = new Client(db.clientConfig(s.conn));
    await client.connect();
    return client;
  }

  // Migration SQL from the compare dialog, subject to the connection policy.
  async execute(windowId, sql) {
    const s = this.require(windowId);
    if (!s.profile.policy.allowWrites || !s.profile.policy.allowDDL)
      throw new Error(`The "${s.profile.name}" connection (${s.profile.environment}) doesn't allow schema changes. Edit the connection to change its policy.`);
    this.audit?.log('schema-migration', { windowId, target: this.describe(s.conn), sql });
    return db.execute(s.conn, sql);
  }
}

module.exports = { ConnectionManager };
