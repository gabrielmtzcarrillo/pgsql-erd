// Tools the assistant can call. Each one is gated by the assistant's
// permissions; none of them writes to the database. Scripts the model
// creates or edits are proposed to the user, who reviews, saves and runs them.

const MAX_RESULT = 12000;

const TOOLS = [
  { name: 'get_schema', permission: 'readSchema', description: 'List the tables in the database with their column counts and comments.', parameters: { type: 'object', properties: {} } },
  { name: 'get_table', permission: 'readSchema', description: 'Columns, types, keys, constraints and indexes of one table.', parameters: obj({ name: str('Table name, e.g. public.orders') }, ['name']) },
  { name: 'get_columns', permission: 'readSchema', description: 'Columns of a table as JSON.', parameters: obj({ table: str('Table name') }, ['table']) },
  { name: 'get_relationships', permission: 'readSchema', description: 'Foreign keys from and to a table.', parameters: obj({ table: str('Table name') }, ['table']) },
  { name: 'get_indexes', permission: 'readSchema', description: 'Indexes of a table.', parameters: obj({ table: str('Table name') }, ['table']) },
  { name: 'get_constraints', permission: 'readSchema', description: 'Primary key, unique and check constraints of a table.', parameters: obj({ table: str('Table name') }, ['table']) },
  { name: 'get_sample_rows', permission: 'readData', rows: true, db: true, description: 'A few rows of a table (at most 20).', parameters: obj({ table: str('Table name'), limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['table']) },
  { name: 'validate_sql', permission: 'readSchema', db: true, description: 'Check that a SQL statement parses and plans against the database, without running it.', parameters: obj({ sql: str('SQL statement') }, ['sql']) },
  { name: 'run_readonly_query', permission: 'executeSelect', rows: true, db: true, description: 'Run a read-only SELECT in a read-only transaction and return up to 50 rows.', parameters: obj({ sql: str('SELECT statement') }, ['sql']) },
  { name: 'check_script', permission: 'readSchema', description: 'Type-check a TypeScript script against the database typings. Returns the errors, if any.', parameters: obj({ source: str('Script source') }, ['source']) },
  { name: 'create_script', permission: 'createScripts', description: 'Propose a new script to the user. It opens unsaved in the editor for review; it is not run.', parameters: obj({ name: str('Short name'), type: { type: 'string', enum: ['query', 'validator', 'generator', 'seeder', 'migration', 'maintenance', 'import', 'export'] }, description: str('One sentence'), source: str('TypeScript source') }, ['name', 'type', 'source']) },
  { name: 'update_script', permission: 'modifyScripts', description: 'Propose a new version of the script open in the editor. The user reviews and applies it.', parameters: obj({ source: str('Complete new TypeScript source'), summary: str('What changed') }, ['source']) },
  { name: 'list_scripts', permission: 'readSchema', description: 'Scripts saved in the project.', parameters: { type: 'object', properties: {} } },
  { name: 'run_validator', permission: 'executeScripts', rows: true, db: true, description: 'Run a saved validator (read-only) and return its results.', parameters: obj({ path: str('Script path from list_scripts') }, ['path']) },
  { name: 'run_script_dry', permission: 'executeScripts', rows: true, db: true, description: 'Dry-run a saved script: it runs in a transaction that is rolled back. Returns the counts of rows it would change.', parameters: obj({ path: str('Script path from list_scripts') }, ['path']) },
];

function obj(properties, required) {
  return { type: 'object', properties, required };
}
function str(description) {
  return { type: 'string', description };
}

// ctx: { windowId, shared, schema, permissions, connected, rowsAllowed, services, emit }
function availableTools(ctx) {
  return TOOLS.filter((t) => ctx.permissions[t.permission] && (!t.db || ctx.connected) && (!t.rows || ctx.rowsAllowed)).map(
    ({ name, description, parameters }) => ({ name, description, parameters })
  );
}

const clip = (text) => (text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… (truncated)` : text);
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1);

async function executeTool(ctx, name, args = {}) {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`Unknown tool: ${name}`);
  if (!ctx.permissions[def.permission]) throw new Error(`The assistant is not allowed to use ${name}.`);
  if (def.db && !ctx.connected) throw new Error('Not connected to a database.');
  if (def.rows && !ctx.rowsAllowed) throw new Error('Sharing row data with this provider is not enabled.');
  const { shared, schema, services, windowId } = ctx;
  const table = (n) => {
    const t = shared.findTable(schema, n);
    if (!t) throw new Error(`Unknown table: ${n}. Use get_schema to list tables.`);
    return t;
  };

  switch (name) {
    case 'get_schema':
      return clip(shared.allTables(schema).map((t) => `${t.id} (${t.columns.length} columns)${t.comment ? ` -- ${t.comment}` : ''}`).join('\n') || 'No tables.');
    case 'get_table':
      return clip(shared.describeTable(table(args.name)));
    case 'get_columns':
      return clip(json(table(args.table).columns));
    case 'get_relationships':
      return clip(json(shared.relationshipsOf(schema, table(args.table).id)));
    case 'get_indexes':
      return clip(json(table(args.table).indexes));
    case 'get_constraints': {
      const t = table(args.table);
      return clip(json({ primaryKey: t.primaryKey, uniques: t.uniques, checks: t.checks }));
    }
    case 'get_sample_rows': {
      const t = table(args.table);
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
      const rows = await services.readOnly(windowId, (c) =>
        c.query(`SELECT * FROM ${quote(t.schema)}.${quote(t.name)} LIMIT ${limit}`).then((r) => r.rows)
      );
      ctx.sharedRows = true;
      return clip(json(rows));
    }
    case 'validate_sql': {
      const sql = String(args.sql ?? '').trim().replace(/;\s*$/, '');
      const { kinds } = shared.classifySql(sql);
      if (kinds.includes('ddl')) return 'DDL statements cannot be checked without running them. Review them carefully.';
      try {
        await services.readOnly(windowId, (c) => c.query(`EXPLAIN ${sql}`));
        return 'OK: the statement parses and plans.';
      } catch (err) {
        return `Error: ${err.message}${err.position ? ` (at character ${err.position})` : ''}`;
      }
    }
    case 'run_readonly_query': {
      const sql = String(args.sql ?? '').trim().replace(/;\s*$/, '');
      const { kinds, statements } = shared.classifySql(sql);
      if (statements !== 1 || kinds.some((k) => k !== 'read')) return 'Refused: only a single read-only SELECT is allowed.';
      const wrapped = /^\s*(select|with|values|table)\b/i.test(sql) ? `SELECT * FROM (\n${sql}\n) AS q LIMIT 51` : sql;
      const rows = await services.readOnly(windowId, (c) => c.query(wrapped).then((r) => r.rows));
      ctx.sharedRows = true;
      const more = rows.length > 50;
      return clip(`${json(rows.slice(0, 50))}${more ? '\n(more rows not shown)' : ''}`);
    }
    case 'check_script': {
      const diags = services.checkScript(schema, String(args.source ?? ''));
      return diags.length ? diags.map((d) => `line ${d.line}:${d.column} ${d.severity}: ${d.message}`).join('\n') : 'No errors.';
    }
    case 'create_script': {
      const type = shared.SCRIPT_TYPES[args.type] ? args.type : 'query';
      const proposal = { action: 'create', name: String(args.name || 'assistant script'), type, description: String(args.description ?? ''), source: String(args.source ?? '') };
      proposal.diagnostics = services.checkScript(schema, proposal.source);
      ctx.emit({ type: 'proposal', proposal });
      return `Proposed to the user as a new unsaved ${type} script "${proposal.name}". ${proposal.diagnostics.length ? `It has ${proposal.diagnostics.length} type errors:\n${proposal.diagnostics.slice(0, 10).map((d) => `line ${d.line}: ${d.message}`).join('\n')}` : 'It type-checks.'}`;
    }
    case 'update_script': {
      const proposal = { action: 'update', source: String(args.source ?? ''), summary: String(args.summary ?? '') };
      proposal.diagnostics = services.checkScript(schema, proposal.source);
      ctx.emit({ type: 'proposal', proposal });
      return `Proposed to the user as a change to the current script. ${proposal.diagnostics.length ? `It has ${proposal.diagnostics.length} type errors.` : 'It type-checks.'}`;
    }
    case 'list_scripts': {
      const list = await services.listScripts(windowId);
      return list.length ? list.map((s) => `${s.path} (${s.type})${s.description ? ` -- ${s.description}` : ''}`).join('\n') : 'No saved scripts.';
    }
    case 'run_validator':
    case 'run_script_dry': {
      const result = await services.runSaved(windowId, String(args.path), { validatorOnly: name === 'run_validator' });
      ctx.sharedRows = true;
      return clip(summarizeRun(result));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function summarizeRun(r) {
  if (r.stage === 'typecheck') return `The script has type errors:\n${r.diagnostics.map((d) => `line ${d.line}: ${d.message}`).join('\n')}`;
  const lines = [`Status: ${r.status}${r.error ? ` — ${r.error}` : ''}`, `Rows read: ${r.rowsRead}; would insert ${r.inserts}, update ${r.updates}, delete ${r.deletes}`];
  for (const v of r.validations ?? []) lines.push(`${v.status === 'passed' ? 'PASS' : 'FAIL'} ${v.name} (${v.errors} errors)`);
  for (const m of (r.messages ?? []).slice(0, 30)) lines.push(`${m.level}: ${m.table ?? ''}${m.row !== undefined ? ` #${m.row}` : ''} ${m.message}`);
  return lines.join('\n');
}

const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

module.exports = { TOOLS, availableTools, executeTool };
