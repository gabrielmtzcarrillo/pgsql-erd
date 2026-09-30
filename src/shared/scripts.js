// Project scripts: types, the metadata header stored in each file, and the
// built-in templates.
//
// Scripts are plain TypeScript files under <project>/scripts/<folder>/. The
// first line holds their metadata so the files stay readable and diffable:
//
//   // @pgsql-erd {"type":"validator","profile":"validator"}

import { resolveScriptPermissions, SCRIPT_PERMISSION_KEYS } from './permissions.js';

export const SCRIPT_TYPES = {
  query: { label: 'Query', folder: 'queries', profile: 'read-only' },
  validator: { label: 'Validator', folder: 'validators', profile: 'validator' },
  seeder: { label: 'Seeder', folder: 'seeders', profile: 'seeder' },
  generator: { label: 'Generator', folder: 'generators', profile: 'generator' },
  migration: { label: 'Migration', folder: 'migrations', profile: 'migration' },
  maintenance: { label: 'Maintenance', folder: 'maintenance', profile: 'read-only' },
  import: { label: 'Import', folder: 'imports', profile: 'seeder' },
  export: { label: 'Export', folder: 'exports', profile: 'read-only' },
};

export const typeForFolder = (folder) =>
  Object.entries(SCRIPT_TYPES).find(([, v]) => v.folder === folder)?.[0] ?? 'query';

const HEADER = /^\/\/\s*@pgsql-erd\s+(\{.*\})\s*$/;

// Split a script file into metadata and body.
export function parseScriptFile(text, fallbackType = 'query') {
  const src = String(text ?? '').replace(/^﻿/, '');
  const nl = src.indexOf('\n');
  const first = (nl === -1 ? src : src.slice(0, nl)).replace(/\r$/, '');
  let meta = {};
  let body = src;
  const m = first.match(HEADER);
  if (m) {
    try {
      meta = JSON.parse(m[1]) ?? {};
    } catch {
      meta = {};
    }
    body = nl === -1 ? '' : src.slice(nl + 1);
  }
  const type = SCRIPT_TYPES[meta.type] ? meta.type : fallbackType;
  const profile = meta.profile ?? SCRIPT_TYPES[type].profile;
  const overrides = {};
  for (const k of SCRIPT_PERMISSION_KEYS) if (typeof meta.permissions?.[k] === 'boolean') overrides[k] = meta.permissions[k];
  return {
    type,
    profile,
    overrides,
    permissions: resolveScriptPermissions(profile, overrides),
    description: typeof meta.description === 'string' ? meta.description : '',
    tables: Array.isArray(meta.tables) ? meta.tables.map(String) : [],
    source: body,
  };
}

export function serializeScriptFile({ type, profile, overrides, description, tables, source }) {
  const meta = { type };
  if (profile && profile !== SCRIPT_TYPES[type]?.profile) meta.profile = profile;
  if (overrides && Object.keys(overrides).length) meta.permissions = overrides;
  if (description) meta.description = description;
  if (tables?.length) meta.tables = tables;
  const body = String(source ?? '');
  return `// @pgsql-erd ${JSON.stringify(meta)}\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

export function slugify(name) {
  return (
    String(name ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'script'
  );
}

export const scriptPath = (type, name) => `scripts/${SCRIPT_TYPES[type]?.folder ?? 'queries'}/${slugify(name)}.ts`;

// Tables a script mentions, by qualified or unqualified name. Used to link
// scripts to diagram tables.
export function tablesMentioned(source, tables) {
  const text = String(source ?? '');
  return tables
    .filter((t) => {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^A-Za-z0-9_$])${esc(t.name)}(?![A-Za-z0-9_$])`).test(text);
    })
    .map((t) => t.id);
}

// ------------------------------------------------------------ templates

export function template(type, { table } = {}) {
  const t = table ?? 'public.my_table';
  switch (type) {
    case 'validator':
      return `// Validators declare checks with validate(); each one passes when it reports no errors.
validate("Rows in ${t} have the required values", async () => {
    const rows = await db.table("${t}").select();
    for (const row of rows) {
        // if (!row.some_column) {
        //     report.error({ table: "${t}", row: row.id, column: "some_column", message: "Missing value." });
        // }
    }
    log(\`Checked \${rows.length} rows\`);
});

// Checks that need judgement can ask the AI (set up a provider in the Assistant tab):
// validate("AI review of ${t}", async () => {
//     const sample = await db.table("${t}").limit(50).select();
//     const review = await ai.structured<{ problems: { row: number; column: string; message: string }[] }>({
//         prompt: "List values that look wrong, inconsistent or fake in these rows:\\n" + JSON.stringify(sample),
//         schema: { type: "object", properties: { problems: { type: "array", items: { type: "object", properties: { row: { type: "integer" }, column: { type: "string" }, message: { type: "string" } }, required: ["row", "column", "message"] } } }, required: ["problems"] },
//     });
//     for (const p of review.problems) report.warning({ table: "${t}", row: p.row, column: p.column, message: p.message });
// });
`;
    case 'generator':
      return `// Generates test data. Use "Dry run" to preview the inserts; nothing is saved until you commit.
faker.seed(42);
const rows = await seed.fill("${t}", 10);
log(\`Inserted \${rows.length} rows into ${t}\`);

// For realistic text, ask the AI for a row (validated against the table) and insert it:
// const row = await ai.structured({ table: "${t}", prompt: "A realistic example row." });
// await db.table("${t}").insert(row);
`;
    case 'seeder':
      return `// Inserts fixed reference data.
const rows = [
    // { name: "Example" },
];
for (const row of rows) {
    await db.table("${t}").insert(row);
}
log(\`Seeded \${rows.length} rows\`);
`;
    case 'migration':
      return `// Data or schema migration. Runs in one transaction; use "Dry run" first.
await db.query(\`
    -- ALTER TABLE ${t} ADD COLUMN example text;
    SELECT 1
\`);
`;
    case 'export':
      return `// Reads rows and prints them as JSON.
const rows = await db.table("${t}").limit(100).select();
log(JSON.stringify(rows, null, 2));
`;
    case 'import':
      return `// Imports rows from a JSON array passed as params.rows.
const table = db.table("${t}");
const rows = (params.rows ?? []) as Parameters<typeof table.insert>[0][];
await table.insertMany(rows);
log(\`Imported \${rows.length} rows\`);
`;
    case 'maintenance':
      return `// Read-only health checks.
for (const name of db.describe.tables()) {
    log(name, await db.table(name).count());
}
`;
    default:
      return `// Reads from the database. Results appear in the output panel.
const rows = await db.table("${t}").limit(20).select();
log(rows);
`;
  }
}
