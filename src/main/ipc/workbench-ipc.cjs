// IPC for the database connection, scripts, the assistant and the audit
// log. Every handler returns { ok, result } or { ok: false, error } so the
// renderer can show the real message. Windows are identified by their
// webContents id; the renderer never names another window's resources.

const path = require('node:path');
const { loadShared } = require('../shared.cjs');
const db = require('../db.cjs');
const { ConnectionManager } = require('../database/connection-manager.cjs');
const { SavedInstances } = require('../database/saved-instances.cjs');
const { ProjectManager } = require('../projects/project-manager.cjs');
const { ExecutionManager } = require('../scripting/execution-manager.cjs');
const { ProviderManager } = require('../ai/provider-manager.cjs');
const { Assistant } = require('../ai/assistant.cjs');
const { AuditLog } = require('../audit.cjs');
const dataBrowser = require('../database/data-browser.cjs');
const { runQuery } = require('../database/query-runner.cjs');
const { AgeService } = require('../database/age.cjs');

function registerWorkbench({ ipcMain, app, safeStorage, shell }) {
  const userData = app.getPath('userData');
  const audit = new AuditLog(path.join(userData, 'audit.log'));
  const crypto = {
    // On Linux without a keyring Electron falls back to a hard-coded key;
    // treat that as "no secure storage" and keep keys in memory only.
    available: () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text',
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf),
  };
  const providers = new ProviderManager({ dir: userData, crypto });
  const instances = new SavedInstances({ dir: userData, crypto });

  // Services need the shared ES modules, which load asynchronously.
  const ready = loadShared().then((shared) => {
    const connections = new ConnectionManager({ shared, audit });
    const projects = new ProjectManager({ shared });
    const executions = new ExecutionManager({ shared, connections, projects, audit });
    const readOnly = async (windowId, fn) => {
      const client = await connections.client(windowId);
      try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query('SET LOCAL statement_timeout = 15000');
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        await client.end().catch(() => {});
      }
    };
    const schemaFor = async (windowId, diagramSchema) => {
      if (connections.get(windowId)) return connections.schema(windowId);
      if (diagramSchema && Array.isArray(diagramSchema.schemas)) return { enums: [], ...diagramSchema, source: 'diagram' };
      return { source: 'diagram', schemas: [], enums: [] };
    };
    const assistant = new Assistant({
      shared,
      providers,
      audit,
      services: {
        schemaFor,
        connected: (windowId) => !!connections.get(windowId),
        readOnly,
        checkScript: (schema, source) => executions.check(schema, source),
        listScripts: (windowId) => projects.listScripts(windowId),
        runSaved: (windowId, rel, opts) => executions.runSaved(windowId, rel, opts),
      },
    });
    executions.assistant = assistant;
    const age = new AgeService({ connections, audit, shared });
    return { shared, connections, projects, executions, assistant, readOnly, schemaFor, age };
  });

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (e, ...args) => {
      try {
        return { ok: true, result: await fn(await ready, e.sender.id, e.sender, ...args) };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });
  const send = (sender, channel, payload) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };

  // ------------------------------------------------------------ database

  // A saved password is only used for the server and user it was saved for,
  // so editing the host of a saved instance can't send it somewhere else.
  const withSavedPassword = (conn, instanceId) => {
    const saved = instanceId && instances.get(instanceId);
    if (conn.password || !saved) return conn;
    const same = ['host', 'port', 'user'].every((k) => String(conn[k] ?? '').trim() === saved[k]);
    return same ? { ...conn, password: instances.getPassword(instanceId) ?? '' } : conn;
  };
  handle('db-test', (_s, _id, _sender, conn, instanceId) => db.testConnection(withSavedPassword(conn, instanceId)));
  // opts: { instanceId, save, rememberPassword }. The instance is saved (or
  // updated) only after the connection works.
  handle('db-connect', async ({ connections }, id, _sender, conn, profile, opts = {}) => {
    const c = withSavedPassword(conn, opts.instanceId);
    const info = await connections.connect(id, c, profile);
    let instanceId = null;
    if (opts.save) {
      const { password, ...settings } = c;
      instanceId = instances.upsert(
        { ...settings, id: opts.instanceId, name: profile?.name, environment: info.profile.environment, policy: info.profile.policy },
        opts.rememberPassword ? password : null
      );
      instances.touch(instanceId);
      audit.log('instance-saved', { windowId: id, instance: instanceId, target: info.description, passwordSaved: !!(opts.rememberPassword && password) });
    }
    return { ...info, instanceId, saved: instances.list() };
  });
  // Reconnects to a saved instance with its saved password.
  handle('db-connect-instance', async ({ connections }, id, _sender, instanceId) => {
    const { conn, profile } = instances.resolve(instanceId);
    if (!conn.password) throw new Error('No password is saved for this instance.');
    const info = await connections.connect(id, conn, profile);
    instances.touch(instanceId);
    return { ...info, instanceId, saved: instances.list() };
  });
  handle('db-instances', () => instances.list());
  handle('db-instance-delete', (_s, id, _sender, instanceId) => {
    instances.remove(instanceId);
    audit.log('instance-deleted', { windowId: id, instance: instanceId });
    return instances.list();
  });
  handle('db-instance-forget-password', (_s, id, _sender, instanceId) => {
    instances.setPassword(instanceId, null);
    audit.log('instance-password-forgotten', { windowId: id, instance: instanceId });
    return instances.list();
  });
  handle('db-instances-reconnect', (_s, _id, _sender, on) => {
    instances.setReconnect(on);
    return instances.list();
  });
  handle('db-startup-instance', () => instances.startup());
  handle('db-disconnect', async ({ connections, executions }, id) => {
    await executions.closeWindow(id);
    connections.disconnect(id);
    return null;
  });
  handle('db-info', ({ connections }, id) => connections.publicInfo(id));
  handle('db-introspect', async ({ connections, projects, shared }, id) => {
    const r = await connections.refresh(id);
    await projects.writeTypes(id, shared.generateDatabaseDts(r.schema)).catch(() => {});
    return r;
  });
  handle('db-schema', ({ connections }, id) => (connections.get(id) ? connections.schema(id) : null));
  handle('db-execute', ({ connections }, id, _sender, sql) => connections.execute(id, sql));
  // One row by primary key, for the validation results' row viewer.
  handle('db-row', async ({ connections, readOnly, shared }, id, _sender, { table, key }) => {
    const t = shared.findTable(await connections.schema(id), table);
    if (!t) throw new Error(`Unknown table: ${table}`);
    const pk = t.primaryKey?.columns ?? [];
    if (pk.length !== 1) throw new Error(`${t.id} has no single-column primary key.`);
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    return readOnly(id, (c) =>
      c.query(`SELECT * FROM ${q(t.schema)}.${q(t.name)} WHERE ${q(pk[0])} = $1 LIMIT 1`, [key]).then((r) => ({ table: t.id, key: pk[0], row: r.rows[0] ?? null }))
    );
  });

  // Data browser tabs.
  const browseTable = async ({ connections, shared }, id, name) => {
    const t = shared.findTable(await connections.schema(id), name);
    if (!t) throw new Error(`Unknown table: ${name}`);
    return t;
  };
  handle('data-browse', async (s, id, _sender, req) =>
    dataBrowser.browse((fn) => s.readOnly(id, fn), await browseTable(s, id, req.table), req)
  );
  handle('data-distinct', async (s, id, _sender, req) =>
    dataBrowser.distinct((fn) => s.readOnly(id, fn), await browseTable(s, id, req.table), req.column, req)
  );
  // Rows added, edited or deleted in a data tab, saved in one transaction,
  // only on connections whose policy allows writes.
  handle('data-save', async (s, id, _sender, req) => {
    const session = s.connections.require(id);
    if (!session.profile.policy.allowWrites) throw new Error('This connection is read-only (see its policy in Database → Connect).');
    const t = await browseTable(s, id, req.table);
    const write = async (fn) => {
      const client = await s.connections.client(id);
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 60000');
        const r = await fn(client);
        await client.query('COMMIT');
        return r;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        await client.end().catch(() => {});
      }
    };
    const r = await dataBrowser.save(write, t, req.changes);
    audit.log('data-edit', {
      windowId: id,
      target: s.connections.describe(session.conn),
      environment: session.profile.environment,
      table: t.id,
      inserted: r.inserted,
      updated: r.updated,
      deleted: r.deleted,
    });
    return r;
  });
  handle('data-tables', async ({ connections, shared }, id) => shared.allTables(await connections.schema(id)).map((t) => t.id));

  // Query tab.
  handle('query-run', ({ connections, shared }, id, _sender, req) => {
    const session = connections.require(id);
    return runQuery(
      {
        openClient: () => connections.client(id),
        policy: session.profile.policy,
        audit: (event, details) => audit.log(event, { windowId: id, target: connections.describe(session.conn), environment: session.profile.environment, ...details }),
        shared,
      },
      req
    );
  });

  // Graph tab (Apache AGE).
  handle('age-status', ({ age }, id) => age.status(id));
  handle('age-edges', ({ age }, id, _sender, req) => age.edges(id, req));
  handle('age-vertices', ({ age }, id, _sender, req) => age.vertices(id, req));
  handle('age-cypher', ({ age }, id, _sender, req) => age.cypher(id, req));
  handle('age-change', ({ age }, id, _sender, op, args) => age.change(id, op, args));

  // ------------------------------------------------------------ projects & scripts

  handle('project-set', async ({ projects }, id, _sender, diagramPath) => {
    const dir = projects.set(id, diagramPath);
    return { dir, settings: await projects.settings(id), scripts: await projects.listScripts(id) };
  });
  handle('project-settings-save', async ({ projects }, id, _sender, settings) => {
    const next = await projects.saveSettings(id, settings);
    audit.log('project-settings', { windowId: id, dir: projects.dir(id), keys: Object.keys(settings ?? {}) });
    return next;
  });
  handle('scripts-list', ({ projects }, id) => projects.listScripts(id));
  handle('script-read', ({ projects }, id, _sender, rel) => projects.readScript(id, rel));
  handle('script-write', async ({ projects, connections, shared }, id, _sender, script) => {
    const rel = await projects.writeScript(id, script);
    if (connections.get(id)) await projects.writeTypes(id, shared.generateDatabaseDts(await connections.schema(id))).catch(() => {});
    if (script.origin === 'assistant') audit.log('ai-generated-script', { windowId: id, path: rel, type: script.type });
    return rel;
  });
  handle('script-move', ({ projects }, id, _sender, rel, type, name) => projects.moveScript(id, rel, type, name));
  handle('script-delete', ({ projects }, id, _sender, rel) => projects.deleteScript(id, rel));
  handle('script-check', async ({ executions, schemaFor }, id, _sender, { source, diagramSchema }) =>
    executions.check(await schemaFor(id, diagramSchema), String(source ?? ''))
  );
  handle('script-run', ({ executions }, id, sender, req) =>
    executions.run(id, req, (event) => send(sender, 'script-event', { runId: req.runId, ...event }))
  );
  handle('script-stop', ({ executions }, id) => executions.stop(id));
  handle('script-commit', ({ executions }, id, _sender, runId) => executions.commit(id, runId));
  handle('script-discard', ({ executions }, id, _sender, runId) => executions.discard(id, runId));

  // ------------------------------------------------------------ assistant

  handle('ai-providers', () => providers.list());
  handle('ai-provider-save', (_s, id, _sender, config, key) => {
    const pid = providers.upsert(config, key);
    audit.log('ai-provider-saved', { windowId: id, provider: pid, type: config.type, baseUrl: config.baseUrl, keyChanged: key !== undefined });
    return { id: pid, ...providers.list() };
  });
  handle('ai-provider-delete', (_s, id, _sender, pid) => {
    providers.remove(pid);
    audit.log('ai-provider-deleted', { windowId: id, provider: pid });
    return providers.list();
  });
  handle('ai-models', ({ assistant }, _id, _sender, pid) => assistant.listModels(pid));
  handle('ai-chat', ({ assistant }, id, sender, req) =>
    assistant.chat(id, req, (event) => send(sender, 'ai-event', { requestId: req.requestId, ...event }))
  );
  handle('ai-cancel', ({ assistant }, id) => assistant.cancel(id));

  // ------------------------------------------------------------ audit

  handle('audit-recent', (_s, _id, _sender, limit) => audit.recent(limit));
  const openAuditLog = () => shell.openPath(audit.file);

  return {
    openAuditLog,
    // Release a closed window's connection and roll back its open runs.
    async windowClosed(id) {
      const s = await ready;
      s.assistant.cancel(id);
      await s.executions.closeWindow(id);
      s.connections.disconnect(id);
      s.projects.set(id, null);
    },
  };
}

module.exports = { registerWorkbench };
