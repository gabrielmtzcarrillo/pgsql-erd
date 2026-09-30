// Runs scripts for a window: type-check, transpile, open a transaction, run
// the script in the isolated worker, and then
//   - dry run: roll back and report what would have changed;
//   - run: if the script changed data, keep the transaction open and ask the
//     user to commit or discard (rolled back automatically after 10 minutes);
//     otherwise roll back.
// Only one run per window at a time; a run waiting for commit blocks new runs.

const { runInWorker } = require('./script-runner.cjs');
const { ScriptSession } = require('./script-db.cjs');
const ts = require('./ts-service.cjs');

const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

class ExecutionManager {
  // assistant: for ai.* calls from scripts.
  constructor({ shared, connections, projects, audit, assistant = null, limits = {} }) {
    this.shared = shared;
    this.connections = connections;
    this.projects = projects;
    this.audit = audit;
    this.assistant = assistant;
    this.limits = { timeoutMs: 120000, memoryMb: 256, maxRows: 50000, statementTimeoutMs: 60000, maxMessages: 5000, ...limits };
    this.active = new Map(); // windowId -> { runId, controller }
    this.pending = new Map(); // runId -> { windowId, session, client, timer, record }
  }

  dts(schema) {
    return this.shared.generateDatabaseDts(schema);
  }

  // Type errors plus unknown table names in string literals.
  check(schema, source) {
    const diags = ts.check(source, this.dts(schema));
    return [...diags, ...this.lintTables(schema, source)];
  }

  lintTables(schema, source) {
    const out = [];
    const re = /\b(?:table|fill|row|check|jsonSchema|relationships|insertOrder)\(\s*(["'`])([^"'`$]+)\1/g;
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      let m;
      while ((m = re.exec(line))) {
        if (!this.shared.findTable(schema, m[2])) {
          const col = m.index + m[0].indexOf(m[2]) + 1;
          out.push({ line: i + 1, column: col, endLine: i + 1, endColumn: col + m[2].length, message: `Unknown table "${m[2]}" in the ${schema.source} schema.`, code: 'pgsql-erd', severity: 'warning' });
        }
      }
    });
    return out;
  }

  hasPending(windowId) {
    return [...this.pending.values()].some((p) => p.windowId === windowId);
  }

  // req: { runId, source, name, path, type, profile, overrides, mode, params, seed, ignoreTypeErrors, ai: { providerId, model, shareData } }
  async run(windowId, req, emit = () => {}) {
    if (this.active.has(windowId)) throw new Error('A script is already running in this window.');
    if (this.hasPending(windowId)) throw new Error('Commit or discard the previous run first.');
    const controller = new AbortController();
    this.active.set(windowId, { runId: req.runId, controller });
    try {
      return await this.execute(windowId, req, emit, controller.signal);
    } finally {
      this.active.delete(windowId);
    }
  }

  stop(windowId) {
    this.active.get(windowId)?.controller.abort();
  }

  async execute(windowId, req, emit, signal) {
    const { shared } = this;
    const conn = this.connections.require(windowId);
    const schema = await this.connections.schema(windowId);
    const mode = req.mode === 'run' ? 'run' : 'dry-run';
    const requested = shared.resolveScriptPermissions(req.profile ?? shared.SCRIPT_TYPES[req.type]?.profile, req.overrides);
    const permissions = shared.effectivePermissions(requested, conn.profile.policy);
    const base = {
      runId: req.runId,
      script: req.path ?? req.name ?? 'untitled',
      mode,
      environment: conn.profile.environment,
      permissions,
      restricted: Object.keys(requested).filter((k) => requested[k] && !permissions[k]),
    };

    const source = String(req.source ?? '');
    const diagnostics = this.check(schema, source);
    const typeErrors = diagnostics.filter((d) => d.severity === 'error');
    if (typeErrors.length && !req.ignoreTypeErrors) return { ...base, ok: false, stage: 'typecheck', diagnostics };

    let code;
    try {
      code = ts.transpile(source);
    } catch (err) {
      return { ...base, ok: false, stage: 'transpile', error: err.message, diagnostics };
    }

    const client = await this.connections.client(windowId);
    const session = new ScriptSession({ client, schema, permissions, shared, limits: this.limits });
    const messages = [];
    const output = [];
    let keepOpen = false;
    const started = Date.now();
    try {
      await session.begin();
      const ai = permissions.useAI && this.assistant
        ? (msg) => this.assistant.scriptCall({ providerId: req.ai?.providerId, model: req.ai?.model, shareData: req.ai?.shareData === true, schema, signal }, msg)
        : null;
      const res = await runInWorker({
        code,
        schema,
        params: req.params ?? {},
        seedValue: req.seed ?? Date.now() % 2147483647,
        limits: this.limits,
        signal,
        handlers: {
          db: (op, args) => session.handle(op, args),
          ai: ai ?? (() => {
            throw new Error(permissions.useAI ? 'AI is not configured.' : 'Permission denied: ai.* needs the "useAI" permission.');
          }),
          message: (level, entry) => {
            if (messages.length < this.limits.maxMessages) messages.push({ level, ...entry });
            emit({ type: 'message', message: { level, ...entry } });
          },
          output: (text) => {
            output.push(text);
            emit({ type: 'output', text });
          },
        },
      });
      const summary = session.summary();
      const changed = summary.inserts + summary.updates + summary.deletes > 0 || session.ranDDL;
      let status;
      if (res.error) {
        await session.rollback();
        status = 'failed';
      } else if (mode === 'dry-run') {
        await session.rollback();
        status = 'rolled back';
      } else if (changed) {
        status = 'pending';
        keepOpen = true;
      } else {
        await session.rollback();
        status = 'completed';
      }
      const result = {
        ...base,
        ok: !res.error,
        success: !res.error && !(res.validations ?? []).some((v) => v.status !== 'passed'),
        status,
        error: res.error ?? null,
        durationMs: Date.now() - started,
        rowsRead: summary.rowsRead,
        inserts: summary.inserts,
        updates: summary.updates,
        deletes: summary.deletes,
        affectedTables: Object.entries(summary.tables).map(([table, c]) => ({ table, ...c })),
        schemaChanged: !!session.ranDDL,
        validations: res.validations ?? [],
        messages,
        messagesDropped: res.messagesDropped ?? 0,
        output,
        diagnostics,
      };
      if (keepOpen) {
        const timer = setTimeout(() => this.discard(windowId, req.runId, 'timed out'), PENDING_TIMEOUT_MS);
        this.pending.set(req.runId, { windowId, session, client, timer, result });
        result.pendingUntil = Date.now() + PENDING_TIMEOUT_MS;
      }
      this.audit?.log(mode === 'dry-run' ? 'script-dry-run' : 'script-run', {
        windowId,
        script: base.script,
        environment: conn.profile.environment,
        target: this.connections.describe(conn.conn),
        status,
        inserts: result.inserts,
        updates: result.updates,
        deletes: result.deletes,
        error: result.error,
      });
      return result;
    } catch (err) {
      await session.rollback();
      throw err;
    } finally {
      if (!keepOpen) await client.end().catch(() => {});
    }
  }

  async commit(windowId, runId) {
    const p = this.pending.get(runId);
    if (!p || p.windowId !== windowId) throw new Error('This run is no longer waiting for a commit.');
    this.pending.delete(runId);
    clearTimeout(p.timer);
    try {
      await p.session.commit();
    } finally {
      await p.client.end().catch(() => {});
    }
    const r = p.result;
    this.audit?.log('database-write', { windowId, script: r.script, environment: r.environment, inserts: r.inserts, updates: r.updates, deletes: r.deletes, tables: r.affectedTables, status: 'committed' });
    return { status: 'committed', schemaChanged: r.schemaChanged };
  }

  async discard(windowId, runId, reason = 'discarded') {
    const p = this.pending.get(runId);
    if (!p || p.windowId !== windowId) return { status: 'rolled back' };
    this.pending.delete(runId);
    clearTimeout(p.timer);
    await p.session.rollback();
    await p.client.end().catch(() => {});
    this.audit?.log('script-discarded', { windowId, script: p.result.script, reason });
    this.onDiscard?.(windowId, runId, reason);
    return { status: 'rolled back', reason };
  }

  // Close everything a window left behind.
  async closeWindow(windowId) {
    this.stop(windowId);
    for (const [runId, p] of this.pending) if (p.windowId === windowId) await this.discard(windowId, runId, 'window closed');
  }

  // For the assistant's run_validator / run_script_dry tools: always a dry run.
  async runSaved(windowId, rel, { validatorOnly = false, ai } = {}) {
    const script = await this.projects.readScript(windowId, rel);
    if (validatorOnly && script.type !== 'validator') throw new Error(`${rel} is a ${script.type}, not a validator.`);
    return this.run(windowId, {
      runId: `assistant-${Date.now()}`,
      source: script.source,
      name: script.name,
      path: rel,
      type: script.type,
      profile: script.profile,
      overrides: script.overrides,
      mode: 'dry-run',
      ai,
    });
  }
}

module.exports = { ExecutionManager };
