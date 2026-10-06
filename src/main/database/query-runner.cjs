// The query tab: runs SQL typed by the user, and EXPLAIN plans.
//
// - Read statements run in a read-only transaction.
// - Statements that change data or the schema run only when the user ticked
//   "Allow changes" (and confirmed), and only when the connection's policy
//   allows writes / DDL. They run in one transaction, committed at the end,
//   and are recorded in the audit log. A script wrapped in BEGIN … COMMIT
//   runs the same way (its BEGIN options are kept); one that ends with
//   ROLLBACK runs and is rolled back.
// - EXPLAIN ANALYZE executes the statement, so it always runs in a
//   transaction that is rolled back.

const MAX_ROWS = 5000;

function display(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function resultSet(r) {
  const fields = (r.fields ?? []).map((f) => f.name);
  return {
    command: r.command,
    rowCount: r.rowCount,
    columns: fields,
    rows: (r.rows ?? []).slice(0, MAX_ROWS).map((row) => fields.map((f) => display(row[f]))),
    truncated: (r.rows?.length ?? 0) > MAX_ROWS,
  };
}

// openClient() → connected pg Client; policy: the connection's policy;
// audit(event, details); shared: modules from src/shared (classifySql).
async function runQuery({ openClient, policy, audit, shared }, { sql, allowChanges = false, explain = null, statementTimeoutMs = 60000 }) {
  const { sql: text, modes, end } = shared.unwrapTransaction(String(sql ?? '').trim());
  if (!text.trim()) throw new Error('Type a query first.');
  // Savepoints are the only transaction statements left after unwrapping.
  const { kinds, statements } = shared.classifySql(text);
  // Unknown statements (DO, CALL, SET, typos…) run read-only unless changes
  // are allowed; the read-only transaction makes PostgreSQL refuse writes.
  const changes = kinds.includes('write') || kinds.includes('ddl') || (allowChanges && kinds.includes('other'));
  if (explain && (end || kinds.includes('transaction'))) throw new Error('EXPLAIN works on a single statement; remove BEGIN / COMMIT / ROLLBACK.');
  if (explain) {
    if (statements !== 1) throw new Error('EXPLAIN works on a single statement.');
    if (kinds.includes('ddl')) throw new Error('DDL statements have no query plan.');
    if (explain === 'analyze' && changes && !allowChanges)
      throw new Error('EXPLAIN ANALYZE runs the statement, which changes data. Tick "Allow changes" to analyze it (it is rolled back afterwards).');
  } else if (changes) {
    if (!allowChanges) throw new Error('This statement changes data or the schema. Tick "Allow changes" to run it.');
    if (!policy.allowWrites) throw new Error('This connection is read-only (see its policy in Database → Connect).');
    if (kinds.includes('ddl') && !policy.allowDDL) throw new Error("This connection doesn't allow schema changes.");
  }

  const client = await openClient();
  const started = Date.now();
  const readOnly = !changes;
  try {
    await client.query(readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
    if (modes) {
      await client.query(`SET TRANSACTION ${modes}`);
      if (readOnly) await client.query('SET TRANSACTION READ ONLY');
    }
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, statementTimeoutMs | 0)}`);
    if (explain) {
      const opts = explain === 'analyze' ? 'FORMAT JSON, ANALYZE, BUFFERS, VERBOSE' : 'FORMAT JSON, VERBOSE';
      const r = await client.query(`EXPLAIN (${opts}) ${text.replace(/;\s*$/, '')}`);
      await client.query('ROLLBACK');
      const plan = r.rows[0]['QUERY PLAN'];
      return { kind: 'plan', analyze: explain === 'analyze', plan: Array.isArray(plan) ? plan[0] : plan, durationMs: Date.now() - started };
    }
    const res = await client.query(text);
    const results = (Array.isArray(res) ? res : [res]).map(resultSet);
    const commit = changes && end !== 'rollback';
    if (commit) {
      await client.query('COMMIT');
      audit?.('query-write', { sql: text.trim().slice(0, 2000), statements, commands: results.map((r) => `${r.command} ${r.rowCount ?? ''}`.trim()) });
    } else await client.query('ROLLBACK');
    return { kind: 'results', results, committed: commit, rolledBack: changes && !commit, durationMs: Date.now() - started };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const where = err.position ? ` (at character ${err.position})` : '';
    const e = new Error(`${err.message}${where}`);
    e.position = err.position;
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { runQuery, display };
