// MySQL / MariaDB SQL as written by mysqldump, mariadb-dump, SHOW CREATE TABLE
// or by hand: splitting a script into statements, reading CREATE TABLE into
// the catalog that src/renderer/lib/mysqlimport.js turns into table specs,
// and reading the rows of INSERT statements for "Copy rows".
//
// Shared by the page (schema of a dump) and the main process (rows of a dump),
// so it has no dependencies.
//
// The catalog, also produced from a live server by src/main/database/mysql.cjs:
//   { tables: [{ schema, name, description, columns: [{ name, type, length,
//     precision, scale, unsigned, values, nullable, autoIncrement, generated,
//     default, description }], primaryKey: [col], uniques: [[col]],
//     foreignKeys: [{ columns, refSchema, refTable, refColumns }] }] }
// `type` is the MySQL base type in lower case ("int", "varchar", "enum"…),
// `length` the declared length or display width, `values` the members of an
// enum or set, and `default` null (no default or DEFAULT NULL),
// { literal: 'text' } or { expr: 'current_timestamp()' }. `schema` is the
// database (null for the one being imported).

/**
 * Statements of a script: { start, end, text } with `text` the statement
 * without comments (strings kept) and without its delimiter. Understands
 * quotes, `--`, `#` and block comments, and DELIMITER lines.
 */
export function* splitStatements(src) {
  let delimiter = ';';
  const n = src.length;
  let i = 0;
  let parts = []; // pieces of the current statement
  let seg = 0; // start of the text not yet copied into `parts`
  let start = 0;
  let empty = true; // only whitespace and comments so far
  const take = (to) => {
    if (to > seg) parts.push(src.slice(seg, to));
  };
  const finish = (end) => {
    take(end);
    const text = parts.join('').trim();
    parts = [];
    return text ? { start, end, text } : null;
  };
  while (i < n) {
    const c = src[i];
    if (empty) {
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
        seg = start = ++i;
        continue;
      }
      // DELIMITER at the start of a statement is a client command, not SQL.
      if ((c === 'D' || c === 'd') && /^delimiter[ \t]/i.test(src.slice(i, i + 10))) {
        const eol = src.indexOf('\n', i);
        delimiter = src.slice(i, eol < 0 ? n : eol).trim().split(/\s+/)[1] || ';';
        seg = start = i = eol < 0 ? n : eol + 1;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(src, i);
      empty = false;
      continue;
    }
    if ((c === '-' && src[i + 1] === '-' && (i + 2 >= n || /\s/.test(src[i + 2]))) || c === '#') {
      take(i);
      const eol = src.indexOf('\n', i);
      seg = i = eol < 0 ? n : eol;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      take(i);
      parts.push(' ');
      const close = src.indexOf('*/', i + 2);
      seg = i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === delimiter[0] && src.startsWith(delimiter, i)) {
      const r = finish(i);
      if (r) yield r;
      seg = start = i += delimiter.length;
      empty = true;
      continue;
    }
    empty = false;
    i++;
  }
  const r = finish(n);
  if (r) yield r;
}

// End of the quoted text starting at src[i] (one past the closing quote).
function skipQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\' && q !== '`') j += 2;
    else if (c === q) {
      if (src[j + 1] === q) j += 2;
      else return j + 1;
    } else j++;
  }
  return j;
}

const ESCAPES = { 0: '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' };

function unquote(raw) {
  const q = raw[0];
  let out = '';
  for (let j = 1; j < raw.length - 1; j++) {
    const c = raw[j];
    if (c === '\\' && q !== '`') {
      const e = raw[++j];
      // \% and \_ keep their backslash (they are LIKE escapes).
      out += e in ESCAPES ? ESCAPES[e] : e === '%' || e === '_' ? `\\${e}` : e;
    } else if (c === q && raw[j + 1] === q) {
      out += q;
      j++;
    } else out += c;
  }
  return out;
}

/**
 * Tokens of one statement: { t: 'word'|'id'|'str'|'num'|'hex'|'bits'|'op', v, raw }.
 * `id` is a backquoted name, `str` a string (with its _charset introducer
 * dropped), `hex` the bytes of x'…' / 0x…, `bits` the digits of b'…'.
 */
const RE_HEX = /0x([0-9a-f]*)/iy;
const RE_BITS = /0b([01]*)/y;
const RE_NUM = /\d*\.?\d+(?:e[-+]?\d+)?|\d+\./iy;
const RE_WORD = /[\p{L}\p{N}_$@]+/uy;
const RE_SPACE_QUOTE = /\s+'/y;
const at = (re, text, i) => {
  re.lastIndex = i;
  return re.exec(text);
};

export function tokenize(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const j = skipQuoted(text, i);
      const raw = text.slice(i, j);
      out.push({ t: c === '`' ? 'id' : 'str', v: unquote(raw), raw });
      i = j;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const hex = c === '0' && at(RE_HEX, text, i);
      if (hex) {
        out.push({ t: 'hex', v: hex[1], raw: hex[0] });
        i += hex[0].length;
        continue;
      }
      const bits = c === '0' && at(RE_BITS, text, i);
      if (bits) {
        out.push({ t: 'bits', v: bits[1], raw: bits[0] });
        i += bits[0].length;
        continue;
      }
      const m = at(RE_NUM, text, i);
      out.push({ t: 'num', v: m[0], raw: m[0] });
      i += m[0].length;
      continue;
    }
    const m = /[\p{L}_$@]/u.test(c) && at(RE_WORD, text, i);
    if (m) {
      const w = m[0];
      const next = text[i + w.length];
      // x'00ff', b'0101' and _utf8mb4'text' / _binary'…' literals.
      if (next === "'" && (/^[xbn]$/i.test(w) || w.startsWith('_'))) {
        const j = skipQuoted(text, i + w.length);
        const quoted = text.slice(i + w.length, j);
        if (/^x$/i.test(w)) out.push({ t: 'hex', v: unquote(quoted), raw: text.slice(i, j) });
        else if (/^b$/i.test(w)) out.push({ t: 'bits', v: unquote(quoted), raw: text.slice(i, j) });
        else out.push({ t: 'str', v: unquote(quoted), raw: text.slice(i, j), binary: /^_binary$/i.test(w) });
        i = j;
        continue;
      }
      // _binary 'x' with a space: the introducer applies to the next string.
      if (w.startsWith('_') && /^_(binary|utf8\w*|latin1|ascii|ucs2|utf16\w*|utf32)$/i.test(w) && at(RE_SPACE_QUOTE, text, i + w.length)) {
        const j0 = RE_SPACE_QUOTE.lastIndex - 1;
        const j = skipQuoted(text, j0);
        out.push({ t: 'str', v: unquote(text.slice(j0, j)), raw: text.slice(i, j), binary: /^_binary$/i.test(w) });
        i = j;
        continue;
      }
      out.push({ t: 'word', v: w, raw: w });
      i += w.length;
      continue;
    }
    out.push({ t: 'op', v: c, raw: c });
    i++;
  }
  return out;
}

/** "int(10) unsigned zerofill", "enum('a','b')", "decimal(10,2)" -> parts of a catalog column. */
export function parseColumnType(text) {
  const tokens = typeof text === 'string' ? tokenize(text) : text;
  let i = 0;
  const col = { type: 'text', length: null, precision: null, scale: null, unsigned: false, values: null };
  if (!tokens[i]) return { col, end: i };
  let type = tokens[i++].v.toLowerCase();
  // Two-word types.
  const next = tokens[i]?.t === 'word' ? tokens[i].v.toLowerCase() : null;
  if (type === 'double' && next === 'precision') i++;
  if ((type === 'character' || type === 'char' || type === 'national') && next === 'varying') {
    i++;
    type = 'varchar';
  }
  if (type === 'national' && (next === 'char' || next === 'character' || next === 'varchar')) {
    i++;
    type = next === 'varchar' ? 'varchar' : 'char';
  }
  if (type === 'long' && (next === 'varchar' || next === 'varbinary')) {
    i++;
    type = next === 'varchar' ? 'mediumtext' : 'mediumblob';
  }
  type = { integer: 'int', character: 'char', bool: 'tinyint', boolean: 'tinyint', dec: 'decimal', numeric: 'decimal', fixed: 'decimal', nchar: 'char', nvarchar: 'varchar', real: 'double' }[type] ?? type;
  if (/^(bool|boolean)$/i.test(tokens[i - 1]?.v ?? '')) col.length = 1;
  col.type = type;
  if (tokens[i]?.t === 'op' && tokens[i].v === '(') {
    i++;
    const args = [];
    while (tokens[i] && !(tokens[i].t === 'op' && tokens[i].v === ')')) {
      if (!(tokens[i].t === 'op' && tokens[i].v === ',')) args.push(tokens[i]);
      i++;
    }
    i++;
    if (type === 'enum' || type === 'set') col.values = args.map((a) => a.v);
    else if (['decimal', 'float', 'double'].includes(type)) {
      col.precision = args[0] ? Number(args[0].v) : null;
      col.scale = args[1] ? Number(args[1].v) : null;
    } else if (['datetime', 'timestamp', 'time'].includes(type)) col.scale = args[0] ? Number(args[0].v) : null;
    else if (args[0]) col.length = Number(args[0].v);
  }
  for (;;) {
    const w = tokens[i]?.t === 'word' ? tokens[i].v.toLowerCase() : null;
    if (w === 'unsigned') col.unsigned = true;
    else if (w === 'signed' || w === 'zerofill') {
      if (w === 'zerofill') col.unsigned = true;
    } else if (w === 'character' && tokens[i + 1]?.v?.toLowerCase() === 'set') i += 2;
    else if (w === 'charset' || w === 'collate') i++;
    else if (w === 'binary' || w === 'ascii' || w === 'unicode' || w === 'byte') {
      // CHAR(10) BINARY and friends
    } else break;
    i++;
  }
  return { col, end: i };
}

const word = (tok) => (tok?.t === 'word' ? tok.v.toUpperCase() : null);
const isOp = (tok, v) => tok?.t === 'op' && tok.v === v;
const isName = (tok) => tok && (tok.t === 'id' || tok.t === 'word' || tok.t === 'str');

// Parse a qualified name at tokens[i]: { schema, name, end }.
function qualified(tokens, i) {
  if (!isName(tokens[i])) return null;
  let schema = null;
  let name = tokens[i].v;
  i++;
  if (isOp(tokens[i], '.') && isName(tokens[i + 1])) {
    schema = name;
    name = tokens[i + 1].v;
    i += 2;
  }
  return { schema, name, end: i };
}

// (a, b(10), c DESC) -> { cols, end }; a prefix length or an expression makes `partial` true.
function keyParts(tokens, i) {
  const cols = [];
  let partial = false;
  if (!isOp(tokens[i], '(')) return { cols, end: i, partial };
  i++;
  while (tokens[i] && !isOp(tokens[i], ')')) {
    if (isOp(tokens[i], '(')) {
      partial = true; // a functional key part
      let depth = 0;
      do {
        if (isOp(tokens[i], '(')) depth++;
        if (isOp(tokens[i], ')')) depth--;
        i++;
      } while (tokens[i] && depth > 0);
      continue;
    }
    if (isName(tokens[i])) cols.push(tokens[i].v);
    i++;
    if (isOp(tokens[i], '(')) {
      partial = true; // a prefix: name(10)
      while (tokens[i] && !isOp(tokens[i], ')')) i++;
      i++;
    }
    while (tokens[i] && !isOp(tokens[i], ',') && !isOp(tokens[i], ')')) i++;
    if (isOp(tokens[i], ',')) i++;
  }
  return { cols, end: i + 1, partial };
}

// Text of tokens [a, b) for a default expression.
const joinRaw = (tokens, a, b) =>
  tokens
    .slice(a, b)
    .map((t) => t.raw)
    .join(' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s*,\s*/g, ', ');

const COLUMN_STOP = new Set(['NOT', 'NULL', 'DEFAULT', 'AUTO_INCREMENT', 'PRIMARY', 'KEY', 'UNIQUE', 'COMMENT', 'COLLATE', 'REFERENCES',
  'CHECK', 'CONSTRAINT', 'ON', 'GENERATED', 'AS', 'VIRTUAL', 'STORED', 'PERSISTENT', 'INVISIBLE', 'VISIBLE', 'COLUMN_FORMAT', 'STORAGE',
  'SRID', 'ENGINE_ATTRIBUTE', 'SECONDARY_ENGINE_ATTRIBUTE', 'WITHOUT', 'WITH', 'SERIAL']);

function columnDefinition(tokens, i, table) {
  const name = tokens[i++].v;
  const { col: type, end } = parseColumnType(tokens.slice(i));
  i += end;
  const col = { name, ...type, nullable: true, autoIncrement: false, generated: false, default: null, description: '' };
  if (type.type === 'serial') Object.assign(col, { type: 'bigint', unsigned: true, autoIncrement: true, nullable: false });
  while (i < tokens.length) {
    const w = word(tokens[i]);
    if (w === 'NOT' && word(tokens[i + 1]) === 'NULL') {
      col.nullable = false;
      i += 2;
    } else if (w === 'NULL') i++;
    else if (w === 'DEFAULT') {
      i++;
      const start = i;
      if (isOp(tokens[i], '(')) {
        let depth = 0;
        do {
          if (isOp(tokens[i], '(')) depth++;
          if (isOp(tokens[i], ')')) depth--;
          i++;
        } while (i < tokens.length && depth > 0);
        col.default = { expr: joinRaw(tokens, start, i) };
      } else {
        const tok = tokens[i++];
        if (isOp(tok, '-') || isOp(tok, '+')) {
          col.default = { expr: `${tok.v === '-' ? '-' : ''}${tokens[i++]?.v ?? ''}` };
        } else if (tok?.t === 'str') col.default = { literal: tok.v };
        else if (word(tok) === 'NULL') col.default = null;
        else {
          // a function call: current_timestamp(), now(6)…
          if (isOp(tokens[i], '(')) {
            while (tokens[i] && !isOp(tokens[i], ')')) i++;
            i++;
          }
          col.default = { expr: joinRaw(tokens, start, i) };
        }
      }
    } else if (w === 'ON' && word(tokens[i + 1]) === 'UPDATE') {
      i += 3;
      if (isOp(tokens[i], '(')) {
        while (tokens[i] && !isOp(tokens[i], ')')) i++;
        i++;
      }
    } else if (w === 'AUTO_INCREMENT') {
      col.autoIncrement = true;
      i++;
    } else if (w === 'PRIMARY' || (w === 'KEY' && word(tokens[i - 1]) !== 'UNIQUE')) {
      table.primaryKey = [name];
      col.nullable = false;
      i += w === 'PRIMARY' ? 2 : 1;
    } else if (w === 'UNIQUE') {
      table.uniques.push([name]);
      i++;
      if (word(tokens[i]) === 'KEY') i++;
    } else if (w === 'COMMENT') {
      col.description = tokens[i + 1]?.v ?? '';
      i += 2;
    } else if (w === 'REFERENCES') {
      const ref = qualified(tokens, i + 1);
      if (!ref) break;
      const parts = keyParts(tokens, ref.end);
      table.foreignKeys.push({ columns: [name], refSchema: ref.schema, refTable: ref.name, refColumns: parts.cols });
      i = parts.end;
    } else if (w === 'GENERATED' || w === 'AS') {
      col.generated = true;
      while (i < tokens.length && !isOp(tokens[i], '(')) i++;
      let depth = 0;
      do {
        if (isOp(tokens[i], '(')) depth++;
        if (isOp(tokens[i], ')')) depth--;
        i++;
      } while (i < tokens.length && depth > 0);
    } else if (w === 'CHECK') {
      i++;
      // MariaDB writes its JSON type as LONGTEXT CHECK (json_valid(`col`)).
      if (/^json_valid$/i.test(tokens[i + 1]?.v ?? '') && tokens[i + 3]?.v === name && /text$/.test(col.type)) col.type = 'json';
      let depth = 0;
      do {
        if (isOp(tokens[i], '(')) depth++;
        if (isOp(tokens[i], ')')) depth--;
        i++;
      } while (i < tokens.length && depth > 0);
    } else i++; // COLLATE x, VIRTUAL, STORED, INVISIBLE, CONSTRAINT name…
  }
  return col;
}

// Split the body of CREATE TABLE ( … ) into its elements' tokens.
function elements(tokens, i) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (isOp(t, '(')) depth++;
    if (isOp(t, ')')) {
      if (depth === 0) {
        if (cur.length) out.push(cur);
        return { items: out, end: i + 1 };
      }
      depth--;
    }
    if (isOp(t, ',') && depth === 0) {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return { items: out, end: i };
}

/** A catalog table for the tokens of a CREATE TABLE statement (null if it is not one). */
export function parseCreateTable(tokens, database = null) {
  let i = 0;
  if (word(tokens[i]) !== 'CREATE') return null;
  i++;
  if (word(tokens[i]) === 'OR' && word(tokens[i + 1]) === 'REPLACE') i += 2;
  if (word(tokens[i]) === 'TEMPORARY') return null;
  if (word(tokens[i]) !== 'TABLE') return null;
  i++;
  if (word(tokens[i]) === 'IF') i += 3; // IF NOT EXISTS
  const ref = qualified(tokens, i);
  if (!ref) return null;
  i = ref.end;
  // CREATE TABLE a LIKE b / AS SELECT: no column list to read.
  if (!isOp(tokens[i], '(')) return null;
  const table = { schema: ref.schema ?? database, name: ref.name, description: '', columns: [], primaryKey: [], uniques: [], foreignKeys: [] };
  const body = elements(tokens, i + 1);
  for (const el of body.items) {
    let k = 0;
    if (word(el[k]) === 'CONSTRAINT') k += isName(el[k + 1]) && !['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'].includes(word(el[k + 1])) ? 2 : 1;
    const w = word(el[k]);
    if (w === 'PRIMARY') {
      k += 2;
      while (el[k] && !isOp(el[k], '(')) k++;
      table.primaryKey = keyParts(el, k).cols;
    } else if (w === 'UNIQUE') {
      k++;
      while (el[k] && !isOp(el[k], '(')) k++;
      const parts = keyParts(el, k);
      if (!parts.partial && parts.cols.length) table.uniques.push(parts.cols);
    } else if (w === 'FOREIGN') {
      k += 2;
      while (el[k] && !isOp(el[k], '(')) k++;
      const parts = keyParts(el, k);
      k = parts.end;
      if (word(el[k]) !== 'REFERENCES') continue;
      const target = qualified(el, k + 1);
      if (!target) continue;
      const to = keyParts(el, target.end);
      table.foreignKeys.push({ columns: parts.cols, refSchema: target.schema ?? database, refTable: target.name, refColumns: to.cols });
    } else if (['KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'CHECK', 'PERIOD', 'VECTOR'].includes(w)) {
      // non-unique indexes and checks are not imported
    } else if (isName(el[k])) table.columns.push(columnDefinition(el, k, table));
  }
  for (const fk of table.foreignKeys) fk.refSchema ??= database;
  // Table options: COMMENT='…'
  for (let j = body.end; j < tokens.length; j++) {
    if (word(tokens[j]) === 'COMMENT') {
      const v = isOp(tokens[j + 1], '=') ? tokens[j + 2] : tokens[j + 1];
      if (v?.t === 'str') table.description = v.v;
    }
  }
  const pk = new Set(table.primaryKey);
  for (const c of table.columns) if (pk.has(c.name)) c.nullable = false;
  return table;
}

/**
 * The catalog of the CREATE TABLE statements of a script. A dump of several
 * databases (USE `db` before each) gives each table its database as schema;
 * a dump of one gives null (the schema chosen in the dialog).
 */
export function parseDump(src) {
  const tables = new Map();
  let database = null;
  const databases = new Set();
  for (const st of splitStatements(src)) {
    const head = st.text.slice(0, 40).toUpperCase();
    if (head.startsWith('USE ')) {
      const tok = tokenize(st.text);
      database = tok[1]?.v ?? null;
      if (database) databases.add(database);
      continue;
    }
    if (head.startsWith('DROP TABLE')) continue;
    if (!/^CREATE\s+(OR\s+REPLACE\s+)?TABLE/.test(head)) continue;
    const t = parseCreateTable(tokenize(st.text), database);
    if (t) tables.set(`${t.schema ?? ''}.${t.name}`.toLowerCase(), t);
  }
  const list = [...tables.values()];
  // One database: its tables go to the schema chosen in the dialog.
  if (databases.size <= 1) {
    const only = [...databases][0];
    for (const t of list) {
      if (t.schema === only) t.schema = null;
      for (const fk of t.foreignKeys) if (fk.refSchema === only) fk.refSchema = null;
    }
  }
  return { tables: list, databases: [...databases] };
}

// A value of a VALUES list at tokens[i]: { value, end }. Strings stay strings,
// numbers stay text (exact), x'…' becomes a Uint8Array, b'…' its digits.
function value(tokens, i) {
  const tok = tokens[i];
  if (!tok) return { value: null, end: i };
  if (isOp(tok, '-') || isOp(tok, '+')) {
    const next = value(tokens, i + 1);
    return { value: tok.v === '-' && next.value !== null ? `-${next.value}` : next.value, end: next.end };
  }
  if (tok.t === 'str') return { value: tok.binary ? new TextEncoder().encode(tok.v) : tok.v, end: i + 1 };
  if (tok.t === 'num') return { value: tok.v, end: i + 1 };
  if (tok.t === 'hex') return { value: hexBytes(tok.v), end: i + 1 };
  if (tok.t === 'bits') return { value: { bits: tok.v }, end: i + 1 };
  const w = word(tok);
  if (w === 'NULL') return { value: null, end: i + 1 };
  if (w === 'TRUE' || w === 'FALSE') return { value: w === 'TRUE' ? '1' : '0', end: i + 1 };
  // A function call or anything else: skip it (null), so one odd value does not stop the copy.
  let j = i + 1;
  if (isOp(tokens[j], '(')) {
    let depth = 0;
    do {
      if (isOp(tokens[j], '(')) depth++;
      if (isOp(tokens[j], ')')) depth--;
      j++;
    } while (tokens[j] && depth > 0);
  }
  return { value: null, end: j };
}

function hexBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16);
  return out;
}

/**
 * The rows of an INSERT / REPLACE statement: { schema, table, columns (null
 * when not listed), rows: [[value]] }, or null for any other statement.
 */
export function parseInsert(text) {
  if (!/^(INSERT|REPLACE)\b/i.test(text)) return null;
  const tokens = tokenize(text);
  let i = 1;
  while (['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE', 'INTO'].includes(word(tokens[i]))) i++;
  const ref = qualified(tokens, i);
  if (!ref) return null;
  i = ref.end;
  let columns = null;
  if (isOp(tokens[i], '(')) {
    columns = [];
    i++;
    while (tokens[i] && !isOp(tokens[i], ')')) {
      if (isName(tokens[i])) columns.push(tokens[i].v);
      i++;
    }
    i++;
  }
  if (word(tokens[i]) !== 'VALUES' && word(tokens[i]) !== 'VALUE') return null;
  i++;
  const rows = [];
  while (isOp(tokens[i], '(')) {
    i++;
    const row = [];
    while (tokens[i] && !isOp(tokens[i], ')')) {
      const v = value(tokens, i);
      row.push(v.value);
      i = v.end;
      if (isOp(tokens[i], ',')) i++;
    }
    i++;
    rows.push(row);
    if (isOp(tokens[i], ',')) i++;
  }
  return { schema: ref.schema, table: ref.name, columns, rows };
}

/** Every INSERT of a dump, in order, with the database it applies to. */
export function* dumpInserts(src) {
  let database = null;
  for (const st of splitStatements(src)) {
    if (/^USE\s/i.test(st.text)) {
      database = tokenize(st.text)[1]?.v ?? null;
      continue;
    }
    const ins = parseInsert(st.text);
    if (ins) yield { ...ins, schema: ins.schema ?? database };
  }
}
