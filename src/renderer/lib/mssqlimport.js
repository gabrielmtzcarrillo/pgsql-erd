// Table specs from a Microsoft SQL Server schema, read either from a live
// database (src/main/database/mssql.cjs) or from a T-SQL script such as the
// one SQL Server Management Studio writes with "Script Table as > CREATE To"
// or "Generate Scripts" (parseTsql below). Both give the same catalog:
//   { tables: [{ schema, name, description, columns: [{ name, type, length,
//     precision, scale, nullable, identity, computed, default, description }],
//     primaryKey: [col], uniques: [[col]], foreignKeys: [{ columns, refSchema,
//     refTable, refColumns }] }] }
//
// The specs are the ones the other imports produce, so the same dialog adds
// them to the diagram:
//  - types become their PostgreSQL equivalents (nvarchar(50) -> character
//    varying(50), nvarchar(max) -> text, datetime2 -> timestamp, bit ->
//    boolean, uniqueidentifier -> uuid, rowversion -> bytea…)
//  - an IDENTITY column of an integer type becomes serial / bigserial / smallserial
//  - primary keys, NOT NULL, single-column unique constraints and indexes,
//    foreign keys and MS_Description comments are kept; defaults are
//    translated (getdate() -> CURRENT_TIMESTAMP, newid() -> gen_random_uuid(),
//    N'…' -> '…') and dropped when they call a function PostgreSQL does not have
//  - tables of the dbo schema go to the schema chosen in the dialog; other
//    schemas keep their name

import { snakeCase } from './spreadsheet.js';
import { parseJsonModel } from './efimport.js';

export const TSQL_EXT = /\.sql$/i;

const SIMPLE = {
  bigint: 'bigint', int: 'integer', smallint: 'smallint', tinyint: 'smallint', bit: 'boolean',
  real: 'real', money: 'numeric(19,4)', smallmoney: 'numeric(10,4)',
  date: 'date', datetime: 'timestamp', smalldatetime: 'timestamp', datetimeoffset: 'timestamp with time zone',
  text: 'text', ntext: 'text', image: 'bytea', timestamp: 'bytea', rowversion: 'bytea',
  uniqueidentifier: 'uuid', xml: 'xml', sql_variant: 'text', hierarchyid: 'text',
  geography: 'geography', geometry: 'geometry', sysname: 'character varying(128)', json: 'jsonb',
};
const SERIAL = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' };

/** PostgreSQL type for a SQL Server column ({ type, length, precision, scale }). */
export function mssqlType({ type, length = null, precision = null, scale = null } = {}) {
  const t = String(type ?? '').trim().toLowerCase();
  if (SIMPLE[t]) return SIMPLE[t];
  const max = length === -1 || length === 'max';
  const n = Number(length);
  const sized = (pg) => (max || !Number.isFinite(n) || n <= 0 ? null : `${pg}(${n})`);
  switch (t) {
    case 'char': case 'nchar':
      return max ? 'text' : sized('character') ?? 'character(1)';
    case 'varchar': case 'nvarchar':
      return max ? 'text' : sized('character varying') ?? 'character varying(1)';
    case 'binary': case 'varbinary':
      return 'bytea';
    case 'decimal': case 'numeric': {
      const p = Number(precision);
      if (!Number.isFinite(p) || p <= 0) return 'numeric(18,0)';
      return `numeric(${p},${Number.isFinite(Number(scale)) ? Number(scale) : 0})`;
    }
    case 'float': {
      const p = Number(precision);
      return Number.isFinite(p) && p > 0 && p <= 24 ? 'real' : 'double precision';
    }
    case 'datetime2':
    case 'time': {
      const s = Number(scale);
      const pg = t === 'time' ? 'time' : 'timestamp';
      // SQL Server keeps up to 7 fractional digits, PostgreSQL 6; 6 and more is PostgreSQL's default.
      return Number.isFinite(s) && scale !== null && s < 6 ? `${pg}(${s})` : pg;
    }
    default:
      return 'text';
  }
}

// Remove the parentheses around a whole expression: "((0))" -> "0".
function unwrap(expr) {
  let s = String(expr).trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === "'") {
        i = s.indexOf("'", i + 1);
        if (i < 0) return s;
      } else if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) {
        closesAtEnd = false;
        break;
      }
    }
    if (!closesAtEnd) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

const NOW = /^(getdate|sysdatetime|getutcdate|sysutcdatetime|sysdatetimeoffset|current_timestamp)(\s*\(\s*\))?$/i;
const NOW_SQL = { date: 'CURRENT_DATE', time: 'CURRENT_TIME' };

/** A SQL Server default (as stored, "((0))", or as written, "getdate()") as a PostgreSQL expression. */
export function mssqlDefault(value, pgType = '') {
  if (value === null || value === undefined) return '';
  const s = unwrap(value);
  if (!s || /^null$/i.test(s)) return '';
  const base = pgType.replace(/\(.*$/, '');
  if (NOW.test(s)) return NOW_SQL[base] ?? 'CURRENT_TIMESTAMP';
  if (/^(newid|newsequentialid)\s*\(\s*\)$/i.test(s)) return 'gen_random_uuid()';
  if (/^(suser_sname|suser_name|user_name|current_user|session_user|system_user|original_login)(\s*\(\s*\))?$/i.test(s)) return 'CURRENT_USER';
  // N'text' is a Unicode literal; PostgreSQL strings are Unicode already.
  const str = s.match(/^N?'((?:[^']|'')*)'$/i);
  if (str) {
    if (base === 'boolean') return /^(1|true)$/i.test(str[1]) ? 'true' : /^(0|false)$/i.test(str[1]) ? 'false' : '';
    return `'${str[1]}'`;
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) {
    const num = unwrap(s);
    if (base === 'boolean') return Number(num) === 0 ? 'false' : 'true';
    if (base === 'uuid' || base === 'bytea') return '';
    return num.replace(/^\+/, '');
  }
  if (/^0x[0-9a-f]*$/i.test(s)) return base === 'bytea' ? `'\\x${s.slice(2)}'` : '';
  return ''; // a function call, CONVERT, CAST… without a PostgreSQL equivalent
}

/** Table specs for a catalog. Options: schema (for dbo), snakeCase (convert names). */
export function mssqlSpecs(catalog, options = {}) {
  const target = options.schema || 'public';
  const snake = options.snakeCase !== false;
  const mapSchema = (s) => {
    const name = String(s ?? '').trim() || 'dbo';
    if (name.toLowerCase() === 'dbo') return target;
    return snake ? snakeCase(name) : name;
  };
  const tables = (catalog?.tables ?? []).map((t) => {
    const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
    const unique = new Set(t.uniques.filter((u) => u.length === 1).map((u) => u[0]));
    // A single-column primary key is unique already.
    if (t.primaryKey.length === 1) unique.delete(t.primaryKey[0]);
    const columns = t.columns.map((c) => {
      let type = mssqlType(c);
      if (c.identity && SERIAL[type] && !fkCols.has(c.name)) type = SERIAL[type];
      return {
        name: c.name,
        type,
        nullable: !!c.nullable && !t.primaryKey.includes(c.name),
        unique: unique.has(c.name),
        default: Object.values(SERIAL).includes(type) || c.computed ? '' : mssqlDefault(c.default, type),
        description: c.description ?? '',
      };
    });
    const foreignKeys = t.foreignKeys.map((f) => ({
      columns: f.columns,
      references: { schema: mapSchema(f.refSchema), table: f.refTable, columns: f.refColumns ?? [] },
    }));
    return { name: t.name, schema: mapSchema(t.schema), description: t.description ?? '', columns, primaryKey: t.primaryKey, foreignKeys };
  });
  return parseJsonModel({ tables }, { schema: target, snakeCase: snake }).map((spec) => ({ ...spec, sheet: 'SQL Server' }));
}

// ---------------------------------------------------------------------------
// T-SQL scripts

/** Tokens of a T-SQL script: { t: 'word'|'id'|'str'|'num'|'op', v, s, e } (s/e: offsets). Comments are dropped. */
export function tokenizeTsql(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      // T-SQL block comments nest.
      let depth = 0;
      let j = i;
      while (j < src.length) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          j += 2;
          if (--depth === 0) break;
        } else j++;
      }
      i = j;
      continue;
    }
    const start = i;
    if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"';
      let v = '';
      i++;
      while (i < src.length) {
        if (src[i] === close) {
          if (src[i + 1] === close) {
            v += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'id', v, s: start, e: i });
      continue;
    }
    if (c === "'" || ((c === 'N' || c === 'n') && src[i + 1] === "'")) {
      i += c === "'" ? 1 : 2;
      let v = '';
      while (i < src.length) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'str', v, s: start, e: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = src.slice(i).match(/^(0x[0-9a-f]*|\d*\.?\d+(?:e[-+]?\d+)?\.?)/i);
      i += m[0].length;
      out.push({ t: 'num', v: m[0], s: start, e: i });
      continue;
    }
    if (/[\p{L}_@#$]/u.test(c)) {
      const m = src.slice(i).match(/^[\p{L}\p{N}_@#$]+/u);
      i += m[0].length;
      out.push({ t: 'word', v: m[0], s: start, e: i });
      continue;
    }
    out.push({ t: 'op', v: c, s: start, e: ++i });
  }
  return { tokens: out, src };
}

// Words that start a statement: an expression or clause without a closing ';' ends before them.
const STATEMENT = new Set(['GO', 'ALTER', 'CREATE', 'EXEC', 'EXECUTE', 'INSERT', 'SET', 'USE', 'DROP', 'IF', 'BEGIN', 'END',
  'PRINT', 'DECLARE', 'SELECT', 'UPDATE', 'DELETE', 'GRANT', 'DENY', 'REVOKE', 'WHILE', 'RETURN', 'TRUNCATE', 'MERGE', 'WITH']);
// Words that start a column clause after a data type or a DEFAULT expression.
const COLUMN_CLAUSE = new Set(['NOT', 'NULL', 'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'FOREIGN', 'CHECK', 'COLLATE',
  'IDENTITY', 'ROWGUIDCOL', 'SPARSE', 'FILESTREAM', 'DEFAULT', 'MASKED', 'ENCRYPTED', 'GENERATED', 'HIDDEN', 'PERSISTED', 'INDEX', 'FOR']);

/**
 * The catalog described by a T-SQL script: CREATE TABLE statements with
 * their column and table constraints, ALTER TABLE … ADD (constraints,
 * defaults and columns), CREATE UNIQUE INDEX, CREATE TYPE … FROM (alias
 * types) and sp_addextendedproperty MS_Description comments.
 */
export function parseTsql(text) {
  const { tokens, src } = tokenizeTsql(text);
  let i = 0;
  const tables = new Map(); // "schema.name" (lower case) -> table
  const aliases = new Map(); // alias type name (lower case) -> { type, length, precision, scale, nullable }
  const comments = []; // [{ schema, table, column, text }]

  const peek = (k = 0) => tokens[i + k];
  const word = (tok) => (tok?.t === 'word' ? tok.v.toUpperCase() : null);
  const is = (w, k = 0) => word(peek(k)) === w;
  const isOp = (v, k = 0) => peek(k)?.t === 'op' && peek(k).v === v;
  const accept = (w) => (is(w) ? (i++, true) : false);
  const acceptOp = (v) => (isOp(v) ? (i++, true) : false);
  const isName = (tok) => tok && (tok.t === 'id' || (tok.t === 'word' && !STATEMENT.has(tok.v.toUpperCase())));
  const atStop = () => {
    const tok = peek();
    return !tok || (tok.t === 'op' && (tok.v === ';' || tok.v === ',' || tok.v === ')')) || (tok.t === 'word' && STATEMENT.has(tok.v.toUpperCase()));
  };
  // Skip a parenthesized group starting at the current '('; returns its inner text.
  const group = () => {
    if (!isOp('(')) return '';
    const open = peek();
    let depth = 0;
    while (i < tokens.length) {
      const tok = tokens[i++];
      if (tok.t === 'op' && tok.v === '(') depth++;
      else if (tok.t === 'op' && tok.v === ')' && --depth === 0) return src.slice(open.e, tok.s);
    }
    return src.slice(open.e);
  };
  // A multi-part name: [db].[schema].[table] -> { schema, name }.
  const qualifiedName = () => {
    const parts = [];
    if (!isName(peek())) return null;
    parts.push(tokens[i++].v);
    while (isOp('.')) {
      i++;
      if (isOp('.')) {
        parts.push(''); // db..table
        continue;
      }
      if (!isName(peek())) break;
      parts.push(tokens[i++].v);
    }
    return { schema: parts.length > 1 ? parts[parts.length - 2] || 'dbo' : 'dbo', name: parts[parts.length - 1] };
  };
  // (a ASC, [b] DESC) -> ['a', 'b']
  const columnList = () => {
    const cols = [];
    if (!acceptOp('(')) return cols;
    while (i < tokens.length && !isOp(')')) {
      if (isName(peek())) cols.push(tokens[i++].v);
      while (i < tokens.length && !isOp(',') && !isOp(')')) {
        if (isOp('(')) group();
        else i++;
      }
      acceptOp(',');
    }
    acceptOp(')');
    return cols;
  };
  const key = (schema, name) => `${String(schema).toLowerCase()}.${String(name).toLowerCase()}`;
  const tableFor = (ref, create = false) => {
    const k = key(ref.schema, ref.name);
    if (!tables.has(k) && create) {
      tables.set(k, { schema: ref.schema, name: ref.name, description: '', columns: [], primaryKey: [], uniques: [], foreignKeys: [] });
    }
    return tables.get(k);
  };
  // Expression text up to the next clause keyword (or `stopWords`) at depth 0.
  const expression = (stopWords = COLUMN_CLAUSE) => {
    const first = peek();
    if (!first) return '';
    let last = first;
    let n = 0;
    while (i < tokens.length) {
      if (n > 0 && (atStop() || (peek().t === 'word' && stopWords.has(peek().v.toUpperCase())))) break;
      if (n === 0 && atStop() && !isOp('(')) break;
      if (isOp('(')) {
        group();
        last = tokens[i - 1];
      } else last = tokens[i++];
      n++;
    }
    return n ? src.slice(first.s, last.e) : '';
  };
  // ON DELETE CASCADE, NOT FOR REPLICATION… after a REFERENCES clause.
  const referenceOptions = () => {
    for (;;) {
      if (is('ON') && (is('DELETE', 1) || is('UPDATE', 1))) {
        i += 2;
        if (accept('NO')) accept('ACTION');
        else if (accept('SET')) i++;
        else accept('CASCADE');
      } else if (is('NOT') && is('FOR', 1)) i += 3;
      else return;
    }
  };
  const references = (table, columns) => {
    const ref = qualifiedName();
    const refColumns = isOp('(') ? columnList() : [];
    referenceOptions();
    if (ref) table.foreignKeys.push({ columns, refSchema: ref.schema, refTable: ref.name, refColumns });
  };
  // CLUSTERED / NONCLUSTERED, WITH (…), ON [filegroup] after a key.
  const indexOptions = () => {
    for (;;) {
      if (accept('CLUSTERED') || accept('NONCLUSTERED')) {
        accept('HASH');
        accept('COLUMNSTORE');
      } else if (is('WITH') && isOp('(', 1)) {
        i++;
        group();
      } else if (is('ON') && !is('DELETE', 1) && !is('UPDATE', 1)) {
        i++;
        if (isName(peek())) i++;
        if (isOp('(')) group();
      } else return;
    }
  };

  // A table constraint (after an optional CONSTRAINT name); false if there is none here.
  const tableConstraint = (table) => {
    if (accept('CONSTRAINT') && isName(peek())) i++;
    if (accept('PRIMARY')) {
      accept('KEY');
      indexOptions();
      table.primaryKey = columnList();
      indexOptions();
      return true;
    }
    if (accept('UNIQUE')) {
      indexOptions();
      table.uniques.push(columnList());
      indexOptions();
      return true;
    }
    if (accept('FOREIGN')) {
      accept('KEY');
      const cols = columnList();
      if (accept('REFERENCES')) references(table, cols);
      return true;
    }
    if (accept('CHECK')) {
      if (is('NOT') && is('FOR', 1)) i += 3;
      group();
      return true;
    }
    if (accept('DEFAULT')) {
      const expr = expression(new Set(['FOR']));
      if (accept('FOR') && isName(peek())) {
        const col = table.columns.find((c) => c.name.toLowerCase() === tokens[i].v.toLowerCase());
        if (col) col.default = expr;
        i++;
      }
      accept('WITH') && accept('VALUES');
      return true;
    }
    if (accept('INDEX')) {
      // An inline index: INDEX name [UNIQUE] [CLUSTERED] (cols)
      if (isName(peek())) i++;
      const unique = accept('UNIQUE');
      indexOptions();
      const cols = columnList();
      if (unique) table.uniques.push(cols);
      while (!atStop()) i++;
      return true;
    }
    if (accept('PERIOD')) {
      while (!atStop()) i++;
      return true;
    }
    return false;
  };

  // A column definition at the current name token.
  const columnDefinition = (table, name = null) => {
    const col = { name: name ?? tokens[i++].v, type: 'text', length: null, precision: null, scale: null, nullable: true, identity: false, computed: false, default: '', description: '' };
    let explicitNull = false;
    if (accept('AS')) {
      col.computed = true;
      expression(new Set(['PERSISTED', 'NOT', 'NULL', 'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'FOREIGN', 'CHECK']));
    } else if (isName(peek()) && !COLUMN_CLAUSE.has(word(peek()) ?? '')) {
      const t = qualifiedName();
      let type = t.name.toLowerCase();
      let args = [];
      if (isOp('(')) args = group().split(',').map((a) => a.trim().toLowerCase());
      // Two-word types.
      if (type === 'double' && accept('PRECISION')) type = 'float';
      if ((type === 'national' && (is('CHAR') || is('CHARACTER'))) || type === 'char' || type === 'character') {
        if (type === 'national') {
          i++;
          type = 'nchar';
        }
        if (accept('VARYING')) type = type === 'nchar' ? 'nvarchar' : 'varchar';
        if (type === 'character') type = 'char';
        if (isOp('(')) args = group().split(',').map((a) => a.trim().toLowerCase());
      }
      const alias = aliases.get(type);
      if (alias) {
        Object.assign(col, { type: alias.type, length: alias.length, precision: alias.precision, scale: alias.scale });
        if (!alias.nullable) col.nullable = false;
      } else {
        col.type = { integer: 'int', dec: 'decimal' }[type] ?? type;
        if (['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'].includes(col.type)) {
          col.length = args[0] === 'max' ? -1 : args[0] ? Number(args[0]) : 1;
        } else if (['decimal', 'numeric'].includes(col.type)) {
          col.precision = args[0] ? Number(args[0]) : 18;
          col.scale = args[1] ? Number(args[1]) : 0;
        } else if (col.type === 'float') col.precision = args[0] ? Number(args[0]) : 53;
        else if (['datetime2', 'time', 'datetimeoffset'].includes(col.type)) col.scale = args[0] ? Number(args[0]) : 7;
      }
    }
    // Column clauses, in any order.
    for (;;) {
      if (accept('NOT')) {
        if (accept('NULL')) {
          col.nullable = false;
          explicitNull = true;
        } else if (accept('FOR')) accept('REPLICATION');
      } else if (accept('NULL')) {
        col.nullable = true;
        explicitNull = true;
      } else if (accept('IDENTITY')) {
        col.identity = true;
        group();
        if (is('NOT') && is('FOR', 1)) i += 3;
      } else if (accept('CONSTRAINT')) {
        if (isName(peek())) i++;
      } else if (accept('DEFAULT')) {
        col.default = expression();
        if (is('WITH') && is('VALUES', 1)) i += 2;
      } else if (accept('PRIMARY')) {
        accept('KEY');
        indexOptions();
        table.primaryKey = [col.name];
      } else if (accept('UNIQUE')) {
        indexOptions();
        table.uniques.push([col.name]);
      } else if (accept('FOREIGN')) {
        accept('KEY');
      } else if (accept('REFERENCES')) {
        references(table, [col.name]);
      } else if (accept('CHECK')) {
        if (is('NOT') && is('FOR', 1)) i += 3;
        group();
      } else if (accept('COLLATE')) {
        if (isName(peek())) i++;
      } else if (accept('INDEX')) {
        if (isName(peek())) i++;
        indexOptions();
      } else if (accept('MASKED') || accept('ENCRYPTED')) {
        accept('WITH');
        group();
      } else if (accept('GENERATED')) {
        while (!atStop() && !is('HIDDEN') && !is('NOT') && !is('NULL') && !is('CONSTRAINT')) i++;
      } else if (accept('ROWGUIDCOL') || accept('SPARSE') || accept('FILESTREAM') || accept('HIDDEN') || accept('PERSISTED')) {
        // nothing to keep
      } else break;
    }
    if (!explicitNull && table.primaryKey.includes(col.name)) col.nullable = false;
    return col;
  };

  // The elements of a CREATE TABLE body, or the items of ALTER TABLE … ADD.
  const elements = (table, inParens) => {
    for (;;) {
      if (inParens && isOp(')')) {
        i++;
        return;
      }
      if (!peek()) return;
      if (!tableConstraint(table)) {
        if (isName(peek()) && !STATEMENT.has(word(peek()) ?? '')) {
          const col = columnDefinition(table);
          const existing = table.columns.findIndex((c) => c.name.toLowerCase() === col.name.toLowerCase());
          if (existing >= 0) table.columns[existing] = col;
          else table.columns.push(col);
        } else if (!inParens) return;
      }
      // Skip whatever this parser does not understand up to the end of the element.
      let depth = 0;
      while (peek() && !(depth === 0 && (isOp(',') || isOp(')') || isOp(';')))) {
        if (!inParens && depth === 0 && STATEMENT.has(word(peek()) ?? '')) return;
        if (isOp('(')) depth++;
        if (isOp(')')) depth--;
        i++;
      }
      if (acceptOp(',')) continue;
      if (inParens && isOp(')')) continue;
      return;
    }
  };

  const createTable = () => {
    const ref = qualifiedName();
    if (!ref || !isOp('(')) return;
    // Temporary tables are not part of the schema.
    if (ref.name.startsWith('#')) {
      group();
      return;
    }
    const table = tableFor(ref, true);
    table.columns = [];
    table.primaryKey = [];
    table.uniques = [];
    table.foreignKeys = [];
    i++;
    elements(table, true);
  };

  const alterTable = () => {
    const ref = qualifiedName();
    if (!ref) return;
    const table = tableFor(ref);
    if (accept('WITH')) accept('CHECK') || accept('NOCHECK');
    if (!table) return;
    if (accept('ADD')) elements(table, false);
    else if (accept('ALTER') && accept('COLUMN') && isName(peek())) {
      const name = peek().v.toLowerCase();
      const col = columnDefinition({ ...table, primaryKey: table.primaryKey, uniques: [], foreignKeys: [] });
      const idx = table.columns.findIndex((c) => c.name.toLowerCase() === name);
      if (idx >= 0) table.columns[idx] = { ...table.columns[idx], ...col, default: table.columns[idx].default, identity: table.columns[idx].identity };
    } else if (accept('DROP')) {
      if (accept('COLUMN')) {
        accept('IF') && accept('EXISTS');
        const names = [];
        do if (isName(peek())) names.push(tokens[i++].v.toLowerCase());
        while (acceptOp(','));
        table.columns = table.columns.filter((c) => !names.includes(c.name.toLowerCase()));
      }
    }
  };

  const createIndex = (unique) => {
    indexOptions();
    if (!accept('INDEX')) return;
    if (isName(peek())) i++;
    if (!accept('ON')) return;
    const ref = qualifiedName();
    const cols = columnList();
    accept('INCLUDE') && columnList();
    const filtered = is('WHERE');
    const table = ref && tableFor(ref);
    if (unique && table && !filtered && cols.length) table.uniques.push(cols);
  };

  const createType = () => {
    const ref = qualifiedName();
    if (!ref || !accept('FROM')) return;
    const holder = { schema: 'dbo', name: '', columns: [], primaryKey: [], uniques: [], foreignKeys: [] };
    // The column parser reads "<base type> [NOT NULL]".
    const col = columnDefinition(holder, ref.name);
    aliases.set(ref.name.toLowerCase(), col);
  };

  // EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'…', @level0type = N'SCHEMA', …
  const extendedProperty = () => {
    const named = {};
    const positional = [];
    const order = ['name', 'value', 'level0type', 'level0name', 'level1type', 'level1name', 'level2type', 'level2name'];
    while (peek() && !atStop()) {
      let name = null;
      if (peek().t === 'word' && peek().v.startsWith('@') && isOp('=', 1)) {
        name = peek().v.slice(1).toLowerCase();
        i += 2;
      }
      const tok = tokens[i++];
      const v = tok.t === 'str' || tok.t === 'num' || tok.t === 'id' ? tok.v : tok.t === 'word' && tok.v.toUpperCase() !== 'NULL' ? tok.v : null;
      if (name) named[name] = v;
      else positional.push(v);
      if (!acceptOp(',')) break;
    }
    positional.forEach((v, k) => order[k] && !(order[k] in named) && (named[order[k]] = v));
    if (String(named.name ?? '').toLowerCase() !== 'ms_description') return;
    if (String(named.level1type ?? '').toUpperCase() !== 'TABLE') return;
    const column = String(named.level2type ?? '').toUpperCase() === 'COLUMN' ? named.level2name : null;
    comments.push({ schema: named.level0name || 'dbo', table: named.level1name, column, text: String(named.value ?? '') });
  };

  while (i < tokens.length) {
    const w = word(peek());
    if (w === 'CREATE') {
      i++;
      if (accept('TABLE')) createTable();
      else if (accept('UNIQUE')) createIndex(true);
      else if (is('INDEX') || is('CLUSTERED') || is('NONCLUSTERED')) createIndex(false);
      else if (accept('TYPE')) createType();
      continue;
    }
    if (w === 'ALTER' && is('TABLE', 1)) {
      i += 2;
      alterTable();
      continue;
    }
    if ((w === 'EXEC' || w === 'EXECUTE') && peek(1)) {
      i++;
      const proc = qualifiedName();
      if (proc && proc.name.toLowerCase() === 'sp_addextendedproperty') extendedProperty();
      continue;
    }
    i++;
  }

  for (const c of comments) {
    const t = tables.get(key(c.schema, c.table));
    if (!t) continue;
    if (!c.column) t.description = c.text;
    else {
      const col = t.columns.find((x) => x.name.toLowerCase() === String(c.column).toLowerCase());
      if (col) col.description = c.text;
    }
  }
  for (const t of tables.values()) {
    for (const col of t.columns) if (t.primaryKey.some((k) => k.toLowerCase() === col.name.toLowerCase())) col.nullable = false;
  }
  return { tables: [...tables.values()].filter((t) => t.columns.length) };
}
