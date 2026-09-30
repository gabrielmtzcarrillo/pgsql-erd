// Generate TypeScript declarations (database.d.ts) for scripts from the
// canonical schema model: one row interface and one insert interface per
// table, typed table access (db.public.orders) and the script runtime API.
// Monaco loads the output as an extra lib; the main process uses the same
// text to type-check scripts before they run.

import { allTables } from './schema-model.js';

const NUMBER = new Set(['smallint', 'integer', 'int', 'int2', 'int4', 'real', 'double precision', 'float4', 'float8', 'serial', 'smallserial', 'oid']);
// node-postgres returns these as strings to avoid losing precision.
const BIG = new Set(['bigint', 'int8', 'bigserial', 'numeric', 'decimal', 'money']);
const DATE = new Set(['date', 'timestamp', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz']);
const JSON_TYPES = new Set(['json', 'jsonb']);
const BINARY = new Set(['bytea']);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const propKey = (name) => (IDENT.test(name) ? name : JSON.stringify(name));

export function pascalCase(s) {
  const out = String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
  return /^[0-9]/.test(out) ? `T${out}` : out || 'Table';
}

function enumLookup(schema) {
  const map = new Map();
  for (const e of schema.enums ?? []) {
    const union = e.values.map((v) => JSON.stringify(v)).join(' | ') || 'string';
    map.set(e.name.toLowerCase(), union);
    map.set(`${e.schema}.${e.name}`.toLowerCase(), union);
  }
  return map;
}

// TypeScript type for a column, as read (row) or as written (insert).
export function tsType(col, enums = new Map(), mode = 'row') {
  const base = col.baseType;
  let t;
  if (NUMBER.has(base)) t = 'number';
  else if (BIG.has(base)) t = mode === 'row' ? 'string' : 'string | number | bigint';
  else if (base === 'boolean' || base === 'bool') t = 'boolean';
  else if (DATE.has(base)) t = mode === 'row' ? 'Date' : 'Date | string';
  else if (JSON_TYPES.has(base)) t = 'Json';
  else if (BINARY.has(base)) t = 'Uint8Array';
  else if (enums.has(base) || enums.has(base.replace(/"/g, ''))) t = enums.get(base) ?? enums.get(base.replace(/"/g, ''));
  else t = 'string';
  if (col.isArray) t = t.includes(' ') ? `(${t})[]` : `${t}[]`;
  return t;
}

// Columns a plain INSERT may leave out.
const optionalOnInsert = (c) => c.nullable || !!c.defaultValue || c.serial || c.identity === 'd';
// Columns an INSERT can't set at all.
const notInsertable = (c) => c.generated || c.identity === 'a';

// Unique interface names: public tables use the table name, others are
// prefixed with the schema (ShopOrders); clashes get a numeric suffix.
export function typeNames(schema) {
  const used = new Set();
  const names = new Map();
  for (const t of allTables(schema)) {
    let n = pascalCase(t.schema === 'public' ? t.name : `${t.schema}_${t.name}`);
    if (['Json', 'Table', 'Filter', 'Condition', 'Tables'].includes(n)) n += 'Row';
    let unique = n;
    for (let i = 2; used.has(unique); i++) unique = `${n}${i}`;
    used.add(unique);
    names.set(t.id, unique);
  }
  return names;
}

function doc(text) {
  const clean = String(text ?? '').replace(/\*\//g, '* /').trim();
  return clean ? `/** ${clean.replace(/\n/g, ' ')} */\n` : '';
}

const indent = (text, n) => text.replace(/^(?=.)/gm, ' '.repeat(n));

export function generateTableTypes(schema) {
  const enums = enumLookup(schema);
  const names = typeNames(schema);
  const out = [];
  for (const t of allTables(schema)) {
    const n = names.get(t.id);
    const pk = new Set(t.primaryKey?.columns ?? []);
    const fks = new Map();
    for (const fk of t.foreignKeys) fk.columns.forEach((c, i) => fks.set(c, `${fk.refTable}.${fk.refColumns[i]}`));
    const row = t.columns.map((c) => {
      const notes = [c.databaseType + (c.nullable ? '' : ' NOT NULL')];
      if (pk.has(c.name)) notes.push('primary key');
      if (fks.has(c.name)) notes.push(`references ${fks.get(c.name)}`);
      if (c.defaultValue) notes.push(`default ${c.defaultValue}`);
      if (c.comment) notes.push(c.comment);
      return `${doc(notes.join(' · '))}${propKey(c.name)}: ${tsType(c, enums)}${c.nullable ? ' | null' : ''};`;
    });
    const ins = t.columns.filter((c) => !notInsertable(c)).map((c) =>
      `${propKey(c.name)}${optionalOnInsert(c) ? '?' : ''}: ${tsType(c, enums, 'insert')}${c.nullable ? ' | null' : ''};`
    );
    out.push(`${doc(`${t.id}${t.comment ? ` — ${t.comment}` : ''}`)}interface ${n} {\n${indent(row.join('\n'), 4)}\n}`);
    out.push(`/** Values accepted when inserting into ${t.id}. */\ninterface ${n}Insert {\n${indent(ins.join('\n'), 4)}\n}`);
  }
  return out.join('\n\n');
}

// Script runtime API. Kept in sync with src/runner/script-worker.cjs.
export const RUNTIME_DTS = `type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Comparison for a column in a where() filter. */
interface Condition<T> {
    eq?: T | null; ne?: T | null;
    gt?: T; gte?: T; lt?: T; lte?: T;
    in?: T[]; notIn?: T[];
    like?: string; ilike?: string;
    isNull?: boolean;
}

/** Values accepted for a column in filters: bigint/numeric columns (read as strings) also take numbers, dates also take ISO strings. */
type Loose<T> = T extends Date ? Date | string : T extends string ? (string extends T ? string | number | bigint : T) : T;

/** Equality on each listed column: a value, an array (IN), null (IS NULL) or a Condition. */
type Filter<Row> = { [K in keyof Row]?: Loose<Row[K]> | Loose<NonNullable<Row[K]>>[] | Condition<Loose<NonNullable<Row[K]>>> };

interface Table<Row = Record<string, unknown>, Insert = Partial<Row>> {
    /** Qualified name, e.g. "public.orders". */
    readonly name: string;
    /** Adds conditions (AND). Returns a new query; the table itself is unchanged. */
    where(filter: Filter<Row>): Table<Row, Insert>;
    orderBy(column: keyof Row & string, direction?: "asc" | "desc"): Table<Row, Insert>;
    limit(count: number): Table<Row, Insert>;
    offset(count: number): Table<Row, Insert>;
    select(): Promise<Row[]>;
    select<K extends keyof Row & string>(...columns: K[]): Promise<Pick<Row, K>[]>;
    first(): Promise<Row | null>;
    count(): Promise<number>;
    /** Inserts one row and returns it as stored (defaults filled in). Needs the INSERT permission. */
    insert(row: Insert): Promise<Row>;
    insertMany(rows: Insert[]): Promise<Row[]>;
    /** Updates the rows matched by where(); returns the number of rows. Needs the UPDATE permission. */
    update(values: Partial<Insert>): Promise<number>;
    /** Deletes the rows matched by where(); returns the number of rows. Needs the DELETE permission. */
    delete(): Promise<number>;
}

interface ColumnInfo {
    name: string; databaseType: string; nullable: boolean; defaultValue: string | null;
    identity: "a" | "d" | null; generated: boolean; serial: boolean; comment: string;
}
interface ForeignKeyInfo { name: string; columns: string[]; refTable: string; refColumns: string[]; onUpdate: string; onDelete: string; }
interface TableInfo {
    id: string; schema: string; name: string; comment: string;
    columns: ColumnInfo[];
    primaryKey: { name: string; columns: string[] } | null;
    uniques: { name: string; columns: string[] }[];
    foreignKeys: ForeignKeyInfo[];
    indexes: { name: string; columns: string[]; unique: boolean; definition: string }[];
    checks: { name: string; expression: string }[];
}
interface RelationshipInfo extends ForeignKeyInfo { direction: "references" | "referenced-by"; from: string; to: string; }

interface ChangeSummary {
    inserts: number; updates: number; deletes: number; rowsRead: number;
    tables: { [table: string]: { insert: number; update: number; delete: number } };
}

interface DatabaseApi {
    table<K extends keyof Tables>(name: K): Table<Tables[K]["row"], Tables[K]["insert"]>;
    table(name: string): Table;
    /** Tables of one schema, e.g. db.schema("public").orders. */
    schema<S extends keyof SchemaTables>(name: S): SchemaTables[S];
    /** Raw SQL with $1, $2… parameters. SELECT needs "Run SELECT"; anything else needs "Raw SQL". */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    /** Runs the callback in a savepoint: if it throws, only its changes are undone. */
    transaction<T>(fn: (tx: ProjectDatabase) => Promise<T>): Promise<T>;
    describe: {
        tables(): string[];
        table(name: keyof Tables | string): TableInfo;
        relationships(name: keyof Tables | string): RelationshipInfo[];
        /** Tables sorted so referenced tables come first (safe insert order). */
        insertOrder(names?: (keyof Tables | string)[]): string[];
    };
    /** Changes made so far in this run. */
    preview(): ChangeSummary;
}

interface ReportEntry {
    table?: string;
    row?: unknown;
    column?: string;
    message: string;
    [key: string]: unknown;
}
declare const report: {
    error(entry: ReportEntry | string): void;
    warning(entry: ReportEntry | string): void;
    info(entry: ReportEntry | string): void;
};

/** Declares a validation. It passes when it reports no errors and doesn't throw. */
declare function validate(name: string, check: () => void | Promise<void>): void;

/** Writes a line to the script output. */
declare function log(...values: unknown[]): void;

declare const console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void };
declare function setTimeout(callback: (...args: any[]) => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** Values passed to this run. */
declare const params: Record<string, unknown>;

/** Deterministic fake data (seeded with faker.seed()). */
declare const faker: {
    seed(value: number): void;
    person: { firstName(): string; lastName(): string; fullName(): string; jobTitle(): string };
    internet: { email(name?: string): string; userName(name?: string): string; url(): string };
    phone: { number(): string };
    location: { city(): string; country(): string; streetAddress(): string; zipCode(): string };
    company: { name(): string; department(): string };
    lorem: { word(): string; words(count?: number): string; sentence(words?: number): string; paragraph(sentences?: number): string };
    number: { int(options?: { min?: number; max?: number } | number): number; float(options?: { min?: number; max?: number; fractionDigits?: number }): number };
    datatype: { boolean(probability?: number): boolean };
    date: { past(years?: number): Date; future(years?: number): Date; recent(days?: number): Date; between(from: Date | string, to: Date | string): Date; birthdate(options?: { min?: number; max?: number }): Date };
    string: { uuid(): string; alpha(length?: number): string; numeric(length?: number): string; alphanumeric(length?: number): string };
    helpers: { arrayElement<T>(items: readonly T[]): T; arrayElements<T>(items: readonly T[], count?: number): T[]; shuffle<T>(items: readonly T[]): T[]; weighted<T>(items: readonly { value: T; weight: number }[]): T };
};

/** Schema-aware test data. */
declare const seed: {
    /** A row for the table: every column that needs a value gets a plausible one; foreign keys point at existing rows. */
    row<K extends keyof Tables>(table: K, overrides?: Partial<Tables[K]["insert"]>): Promise<Tables[K]["insert"]>;
    row(table: string, overrides?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Inserts count generated rows and returns them. Needs the INSERT permission. */
    fill<K extends keyof Tables>(table: K, count: number, overrides?: Partial<Tables[K]["insert"]> | ((index: number) => Partial<Tables[K]["insert"]>)): Promise<Tables[K]["row"][]>;
    fill(table: string, count: number, overrides?: Record<string, unknown> | ((index: number) => Record<string, unknown>)): Promise<Record<string, unknown>[]>;
    /** Checks a row against the table's types, NOT NULL columns and foreign keys. Returns the problems found. */
    check(table: keyof Tables | string, row: Record<string, unknown>): Promise<string[]>;
    /** JSON Schema describing the insertable columns of a table. */
    jsonSchema(table: keyof Tables | string): Record<string, unknown>;
};

/** Assistant access from scripts. Needs the "Use AI" permission. */
declare const ai: {
    chat(prompt: string, options?: { system?: string; temperature?: number }): Promise<string>;
    /**
     * Asks the model for JSON matching a JSON Schema and validates it. With a table and no schema, the
     * table's insertable columns are used, and the result is also checked against the table.
     */
    structured<T = Record<string, unknown>>(options: { prompt: string; schema?: Record<string, unknown>; table?: keyof Tables | string; retries?: number; temperature?: number }): Promise<T>;
};

declare const db: ProjectDatabase;`;

export function generateDatabaseDts(schema) {
  const names = typeNames(schema);
  const tables = allTables(schema);
  const header = `// Generated by pgsql-erd from the ${schema.source ?? 'database'} schema. Do not edit.\n`;
  const tablesMap = [];
  for (const t of tables) {
    const n = names.get(t.id);
    tablesMap.push(`${JSON.stringify(t.id)}: { row: ${n}; insert: ${n}Insert };`);
  }
  // Unqualified names for tables whose name is unique across schemas.
  const counts = new Map();
  for (const t of tables) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  for (const t of tables) {
    if (counts.get(t.name) === 1 && t.name !== t.id) {
      const n = names.get(t.id);
      tablesMap.push(`${JSON.stringify(t.name)}: { row: ${n}; insert: ${n}Insert };`);
    }
  }
  const reserved = new Set(['table', 'schema', 'query', 'transaction', 'describe', 'preview']);
  const schemaTables = schema.schemas.map((s) => {
    const members = s.tables.map((t) => {
      const n = names.get(t.id);
      return `${propKey(t.name)}: Table<${n}, ${n}Insert>;`;
    });
    return `${propKey(s.name)}: {\n${indent(members.join('\n'), 4)}\n};`;
  });
  const direct = schema.schemas.filter((s) => !reserved.has(s.name)).map((s) => `${propKey(s.name)}: SchemaTables[${JSON.stringify(s.name)}];`);
  return [
    header,
    RUNTIME_DTS,
    generateTableTypes(schema),
    `interface Tables {\n${indent(tablesMap.join('\n'), 4)}\n}`,
    `interface SchemaTables {\n${indent(schemaTables.join('\n'), 4)}\n}`,
    `interface ProjectDatabase extends DatabaseApi {\n${indent(direct.join('\n'), 4)}\n}`,
    '',
  ].join('\n\n');
}
