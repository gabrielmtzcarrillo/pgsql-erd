// Table specs from an Entity Framework Core model or from a JSON description.
//
// Both readers return the specs that spreadsheet.js produces for a sheet of
// column definitions ({ key, sheet, layout, name, schema, rows, columns }), so
// modelFromSpecs() / importSpecs() add them to the diagram.
//
// parseEfCore(source) reads C# source text (entity classes and the DbContext,
// several files may be concatenated) without compiling it:
//  - properties of the entity classes, including the ones inherited from base
//    classes, become columns; reference navigations become foreign keys
//  - data annotations: Table, Column, Key, PrimaryKey, Required, MaxLength,
//    StringLength, ForeignKey, DatabaseGenerated, NotMapped, Keyless, Index,
//    Precision, Comment
//  - fluent API in OnModelCreating or IEntityTypeConfiguration<T>: ToTable,
//    HasDefaultSchema, HasKey, Property(...).HasColumnName / HasMaxLength /
//    IsRequired / HasColumnType / HasPrecision / HasDefaultValue(Sql) /
//    ValueGeneratedNever / HasComment, HasIndex().IsUnique, Ignore, HasNoKey,
//    HasOne / HasMany / WithOne / WithMany / HasForeignKey / HasPrincipalKey
//  - many-to-many between two collection navigations gets a join table; a
//    class derived from another entity is folded into the base table with a
//    Discriminator column. Owned types and value conversions are not followed.
//
// parseJsonModel(text) reads { schema?, tables: [{ name, schema?, description?,
// columns: [{ name, type, length?, precision?, nullable? | notNull?, pk?,
// unique?, default?, description?, references? }] }] }. `references` is
// "table.column", "schema.table.column" or { schema?, table, column? };
// `foreignKeys: [{ columns, references: { table, columns } }]` on a table is
// accepted as well, and so is a bare array of tables.

import { normalizeType, snakeCase, parseReference } from './spreadsheet.js';

// ---------------------------------------------------------------- C# text

// Remove comments, keeping string and char literals (and line breaks) intact.
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      const verbatim = c === '"' && /[@]$/.test(out.slice(-2).replace(/\$/g, ''));
      let j = i + 1;
      while (j < src.length) {
        if (verbatim) {
          if (src[j] === '"' && src[j + 1] === '"') j += 2;
          else if (src[j] === '"') break;
          else j++;
        } else if (src[j] === '\\') j += 2;
        else if (src[j] === c || src[j] === '\n') break;
        else j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Index of the bracket that closes the one at `open`, skipping string literals.
function matchClose(s, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const o = s[open];
  const c = pairs[o];
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const verbatim = ch === '"' && s[i - 1] === '@';
      for (i++; i < s.length; i++) {
        if (verbatim ? s[i] === '"' && s[i + 1] === '"' : s[i] === '\\') i++;
        else if (s[i] === ch) break;
      }
    } else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return s.length;
}

// Split at top-level `sep`, ignoring separators inside brackets, <> and strings.
function splitTop(s, sep = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const end = matchQuote(s, i);
      i = end;
    } else if ('([{<'.includes(ch)) {
      if (ch === '<' && !/[\w>]/.test(s[i - 1] ?? '')) continue;
      depth++;
    } else if (')]}>'.includes(ch)) {
      if (ch === '>' && s[i - 1] === '=') continue;
      depth--;
    } else if (ch === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function matchQuote(s, i) {
  const q = s[i];
  const verbatim = q === '"' && s[i - 1] === '@';
  for (let j = i + 1; j < s.length; j++) {
    if (verbatim ? s[j] === '"' && s[j + 1] === '"' : s[j] === '\\') j++;
    else if (s[j] === q) return j;
  }
  return s.length;
}

const unquote = (s) => {
  const m = String(s ?? '').trim().match(/^@?"((?:[^"\\]|\\.|"")*)"$/);
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
};
const strings = (args) => splitTop(args ?? '').map((a) => unquote(a.replace(/^\w+\s*:\s*/, ''))).filter((v) => v !== null);
const named = (args, key) => {
  const m = String(args ?? '').match(new RegExp(`\\b${key}\\s*[=:]\\s*(@?"(?:[^"\\\\]|\\\\.)*"|[^,)\\s]+)`));
  return m ? (unquote(m[1]) ?? m[1]) : null;
};
// Property names in `e => e.A`, `e => new { e.A, e.B }`, "A" or nameof(A).
function propNames(arg) {
  const a = String(arg ?? '').trim();
  const lit = unquote(a);
  if (lit !== null) return [lit];
  const nameOf = a.match(/^nameof\(\s*(?:[\w.]*\.)?(\w+)\s*\)$/);
  if (nameOf) return [nameOf[1]];
  const body = a.includes('=>') ? a.slice(a.indexOf('=>') + 2) : a;
  if (/\bnew\b/.test(body)) return [...body.matchAll(/\b\w+\.(\w+)/g)].map((m) => m[1]);
  const m = body.match(/^\s*\(?\s*\w+\s*\.\s*(\w+)/);
  return m ? [m[1]] : [];
}

// "[A, B(1)] [C]" -> [{ name, args }]
function attributes(text) {
  const out = [];
  for (let i = text.indexOf('['); i >= 0 && i < text.length; i = text.indexOf('[', i + 1)) {
    const end = matchClose(text, i);
    for (const part of splitTop(text.slice(i + 1, end))) {
      const m = part.match(/^(?:[\w.]*\.)?(\w+?)(?:Attribute)?\s*(?:\(([\s\S]*)\))?$/);
      if (m) out.push({ name: m[1], args: m[2] ?? '' });
    }
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------- C# model

const COLLECTION = /^(?:ICollection|IList|List|HashSet|ISet|IEnumerable|Collection|IReadOnlyCollection|IReadOnlyList|ObservableCollection)<(.+)>$/;
const CLR = {
  string: { type: 'text' }, char: { type: 'character', length: 1 }, Char: { type: 'character', length: 1 },
  bool: { type: 'boolean' }, Boolean: { type: 'boolean' },
  byte: { type: 'smallint' }, sbyte: { type: 'smallint' }, short: { type: 'smallint' }, Int16: { type: 'smallint' },
  ushort: { type: 'integer' }, int: { type: 'integer' }, Int32: { type: 'integer' },
  uint: { type: 'bigint' }, long: { type: 'bigint' }, Int64: { type: 'bigint' },
  ulong: { type: 'numeric', length: 20, precision: 0 }, BigInteger: { type: 'numeric' },
  float: { type: 'real' }, Single: { type: 'real' }, double: { type: 'double precision' }, Double: { type: 'double precision' },
  decimal: { type: 'numeric' }, Decimal: { type: 'numeric' },
  DateTime: { type: 'timestamp without time zone' }, DateTimeOffset: { type: 'timestamp with time zone' },
  DateOnly: { type: 'date' }, TimeOnly: { type: 'time without time zone' }, TimeSpan: { type: 'interval' },
  Guid: { type: 'uuid' }, 'byte[]': { type: 'bytea' }, Uri: { type: 'text' }, IPAddress: { type: 'inet' },
  JsonDocument: { type: 'jsonb' }, JsonElement: { type: 'jsonb' },
};
const REFERENCE_TYPES = new Set(['string', 'byte[]', 'Uri', 'IPAddress', 'JsonDocument']);
const SERIAL = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' };

const lc = (s) => String(s).toLowerCase();

// Classes and enums of the source: { name, kind, base, attrs, body, props }.
function readTypes(src) {
  const types = [];
  const re = /\b((?:(?:public|internal|private|protected|sealed|abstract|partial|static|file)\s+)*)(class|enum)\s+(\w+)(?:<[^>{]*>)?\s*(?::\s*([^{;]+?))?\s*(?:where\s+[^{]+)?\{/g;
  for (let m; (m = re.exec(src)); ) {
    const open = m.index + m[0].length - 1;
    const end = matchClose(src, open);
    const before = src.slice(0, m.index);
    const boundary = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}'));
    const body = src.slice(open + 1, end);
    const t = {
      name: m[3],
      kind: m[2],
      abstract: /\babstract\b/.test(m[1]),
      static: /\bstatic\b/.test(m[1]),
      bases: m[4] ? splitTop(m[4]) : [],
      attrs: attributes(before.slice(boundary + 1)),
      body,
      props: [],
    };
    t.base = t.bases.find((b) => !/^I[A-Z]/.test(b) || /^Identity/.test(b)) ?? null;
    if (t.kind === 'class') t.props = readProps(body);
    types.push(t);
    // Nested types are found by continuing the scan inside the body.
  }
  return types;
}

// Members with an auto-implemented accessor list, from a class body.
function readProps(body) {
  // Flatten the nested { } so that `{ get; set; }` stays and method bodies vanish.
  let flat = '';
  for (let i = 0; i < body.length; ) {
    if (body[i] === '{') {
      const end = matchClose(body, i);
      const inner = body.slice(i + 1, end);
      const auto = /^\s*(?:(?:public|private|protected|internal)\s+)?get\s*;|^\s*(?:(?:public|private|protected|internal)\s+)?(?:set|init)\s*;/.test(inner);
      flat += auto ? '{@auto}' : '{}';
      i = end + 1;
    } else if (body[i] === '"' || body[i] === "'") {
      const end = matchQuote(body, i);
      flat += '""';
      i = end + 1;
    } else flat += body[i++];
  }
  const props = [];
  const re = /((?:\[[^\]]*\]\s*)*)\bpublic\s+((?:(?:virtual|override|required|new|static|abstract)\s+)*)([\w.<>\[\],?\s]+?)\s+(\w+)\s*\{@auto\}/g;
  for (let m; (m = re.exec(flat)); ) {
    if (/\bstatic\b/.test(m[2])) continue;
    props.push({ name: m[4], typeRaw: m[3].trim().replace(/\s+/g, ' '), attrs: attributes(m[1]), required: /\brequired\b/.test(m[2]) });
  }
  // DbSet<T> Name => Set<T>(); and DbSet<T> Name = ...;
  for (let m, dre = /\bpublic\s+(?:virtual\s+)?((?:\w+\.)*DbSet<[^>]+>)\s+(\w+)\s*(?:=>|=)/g; (m = dre.exec(flat)); ) {
    if (!props.some((x) => x.name === m[2])) props.push({ name: m[2], typeRaw: m[1], attrs: [], required: false });
  }
  // Attribute arguments were blanked in `flat`, so read them from the original.
  const attrRe = /((?:\[[^\]\n]*\]\s*)+)\bpublic\s+(?:(?:virtual|override|required|new|abstract)\s+)*[\w.<>\[\],?]+\s+(\w+)\s*\{/g;
  for (let m; (m = attrRe.exec(body)); ) {
    const p = props.find((x) => x.name === m[2]);
    if (p) p.attrs = attributes(m[1]);
  }
  return props;
}

// { name, nullable, collection } for the C# type of a property.
function clrType(raw) {
  let s = raw.replace(/^(?:[\w]+\.)+(?=\w)/, '').trim();
  let nullable = false;
  const n = s.match(/^Nullable<(.+)>$/);
  if (n) {
    s = n[1];
    nullable = true;
  }
  if (s.endsWith('?')) {
    s = s.slice(0, -1);
    nullable = true;
  }
  const c = s.match(COLLECTION);
  if (c) return { name: c[1].replace(/\?$/, '').replace(/^(?:\w+\.)+(?=\w)/, ''), nullable, collection: true };
  return { name: s.replace(/^(?:\w+\.)+(?=\w)/, ''), nullable, collection: false };
}

// ---------------------------------------------------------------- fluent API

// [{ name, generic, args }] for `x.A(1).B<T>(2)`; the leading identifier is dropped.
function chain(stmt) {
  const items = [];
  let i = stmt.search(/\./);
  while (i >= 0 && i < stmt.length) {
    const m = /^\s*\.\s*(\w+)/.exec(stmt.slice(i));
    if (!m) break;
    let p = i + m[0].length;
    let generic = null;
    if (stmt[p] === '<') {
      let depth = 0;
      let j = p;
      for (; j < stmt.length; j++) {
        if (stmt[j] === '<') depth++;
        else if (stmt[j] === '>' && --depth === 0) break;
      }
      generic = stmt.slice(p + 1, j).trim();
      p = j + 1;
    }
    let args = '';
    if (stmt[p] === '(') {
      const end = matchClose(stmt, p);
      args = stmt.slice(p + 1, end);
      p = end + 1;
    }
    items.push({ name: m[1], generic, args });
    i = stmt.indexOf('.', p);
    if (i >= 0 && stmt.slice(p, i).trim()) break;
  }
  return items;
}

const emptyConfig = () => ({ props: new Map(), indexes: [], rels: [], ignore: new Set(), key: null, table: null, schema: null, noKey: false, comment: null });
const propConfig = (cfg, name) => {
  if (!cfg.props.has(name)) cfg.props.set(name, {});
  return cfg.props.get(name);
};

function defaultLiteral(arg) {
  const a = arg.trim();
  const s = unquote(a);
  if (s !== null) return `'${s.replace(/'/g, "''")}'`;
  if (/^(true|false)$/.test(a)) return a;
  if (/^-?\d+(\.\d+)?[mMfFdDlL]?$/.test(a)) return a.replace(/[mMfFdDlL]$/, '');
  return null;
}

// Apply the statements of an entity configuration body to `cfg`.
function applyStatements(cfg, body) {
  for (const stmt of splitTop(body, ';')) {
    const items = chain(stmt);
    if (!items.length) continue;
    const [first] = items;
    const args = splitTop(first.args);
    if (first.name === 'ToTable') {
      const lits = strings(first.args);
      cfg.table = lits[0] ?? cfg.table;
      cfg.schema = named(first.args, 'schema') ?? lits[1] ?? cfg.schema;
    } else if (first.name === 'HasKey') cfg.key = args.flatMap(propNames);
    else if (first.name === 'HasNoKey') cfg.noKey = true;
    else if (first.name === 'HasComment') cfg.comment = strings(first.args)[0] ?? null;
    else if (first.name === 'Ignore') args.flatMap(propNames).forEach((n) => cfg.ignore.add(n));
    else if (first.name === 'HasIndex') {
      const ix = { cols: args.flatMap(propNames).filter((n) => !/^\w+\s*:/.test(n)), unique: false };
      for (const it of items.slice(1)) if (it.name === 'IsUnique') ix.unique = !/false/.test(it.args);
      cfg.indexes.push(ix);
    } else if (first.name === 'Property') {
      const name = propNames(args[0])[0] ?? (first.generic ? null : null);
      if (!name) continue;
      const p = propConfig(cfg, name);
      for (const it of items.slice(1)) {
        const a = splitTop(it.args);
        switch (it.name) {
          case 'HasColumnName': p.column = strings(it.args)[0] ?? p.column; break;
          case 'HasMaxLength': p.maxLength = parseInt(a[0], 10) || p.maxLength; break;
          case 'IsRequired': p.required = !/false/.test(it.args); break;
          case 'HasColumnType': p.columnType = strings(it.args)[0] ?? p.columnType; break;
          case 'HasPrecision': p.precision = parseInt(a[0], 10); p.scale = a[1] === undefined ? null : parseInt(a[1], 10); break;
          case 'HasDefaultValueSql': p.defaultSql = strings(it.args)[0] ?? ''; break;
          case 'HasDefaultValue': p.defaultValue = a.length ? defaultLiteral(a[0]) : null; break;
          case 'HasComment': p.comment = strings(it.args)[0] ?? p.comment; break;
          case 'ValueGeneratedNever': p.never = true; break;
          case 'ValueGeneratedOnAdd': case 'UseIdentityColumn': case 'UseSerialColumn': case 'UseIdentityAlwaysColumn': case 'UseIdentityByDefaultColumn':
            p.generated = true; break;
          case 'HasConversion': if (/^string$/.test(it.generic ?? '')) p.columnType = 'text'; break;
          default:
        }
      }
    } else if (first.name === 'HasOne' || first.name === 'HasMany') {
      const rel = { kind: first.name, nav: propNames(args[0])[0] ?? null, target: first.generic, inverse: null, inverseKind: null, fk: null, fkGeneric: null, principalKey: null };
      for (const it of items.slice(1)) {
        if (it.name === 'WithOne' || it.name === 'WithMany') {
          rel.inverseKind = it.name;
          rel.inverse = propNames(splitTop(it.args)[0])[0] ?? null;
        } else if (it.name === 'HasForeignKey') {
          rel.fk = splitTop(it.args).flatMap(propNames);
          rel.fkGeneric = it.generic;
        } else if (it.name === 'HasPrincipalKey') rel.principalKey = splitTop(it.args).flatMap(propNames);
      }
      cfg.rels.push(rel);
    }
  }
}


// ---------------------------------------------------------------- EF Core

const bare = (s) => String(s ?? '').trim().replace(/^(?:\w+\.)+(?=\w)/, '');
const PLAIN_SERIAL = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' };

/**
 * Table specs from C# source. Options: schema (when the model sets none) and
 * snakeCase (convert the names EF derives from class and property names).
 */
export function parseEfCore(source, { schema = 'public', snakeCase: snake = true } = {}) {
  const src = stripComments(String(source ?? ''));
  const ident = (s) => (snake ? snakeCase(s) : s);
  const types = readTypes(src);
  const classes = new Map(types.filter((t) => t.kind === 'class').map((t) => [t.name, t]));
  const enums = new Set(types.filter((t) => t.kind === 'enum').map((t) => t.name));
  const contexts = types.filter((t) => t.kind === 'class' && t.bases.some((b) => /DbContext$/.test(b.replace(/<.*$/, ''))));
  const nullableContext = /#nullable\s+enable/.test(src) || /\bstring\?\s+\w+\s*\{/.test(src);

  // -- entities and fluent configuration
  const dbSets = new Map(); // entity -> DbSet property name
  for (const ctx of contexts) {
    for (const p of ctx.props) {
      const m = p.typeRaw.match(/DbSet<(.+)>$/);
      if (m) dbSets.set(bare(m[1]), p.name);
    }
  }
  const configs = new Map();
  const cfgOf = (name) => {
    if (!configs.has(name)) configs.set(name, emptyConfig());
    return configs.get(name);
  };
  const defaultSchema = unquote(src.match(/\bHasDefaultSchema\(\s*(@?"[^"]*")/)?.[1]);
  for (let m, re = /\bEntity<([\w.]+)>\s*\(/g; (m = re.exec(src)); ) {
    const open = m.index + m[0].length - 1;
    const end = matchClose(src, open);
    const inner = src.slice(open + 1, end).trim();
    const cfg = cfgOf(bare(m[1]));
    if (inner.includes('=>')) {
      let body = inner.slice(inner.indexOf('=>') + 2).trim();
      if (body.startsWith('{')) body = body.slice(1, matchClose(body, 0));
      applyStatements(cfg, body);
    } else {
      const semi = src.indexOf(';', end);
      applyStatements(cfg, `x${src.slice(end + 1, semi < 0 ? src.length : semi)}`);
    }
  }
  for (const t of types) {
    const target = t.bases.map((b) => b.match(/IEntityTypeConfiguration<([\w.]+)>/)?.[1]).find(Boolean);
    const at = target ? t.body.search(/\bConfigure\s*\(/) : -1;
    if (at < 0) continue;
    const open = t.body.indexOf('{', matchClose(t.body, t.body.indexOf('(', at)));
    applyStatements(cfgOf(bare(target)), t.body.slice(open + 1, matchClose(t.body, open)));
  }

  const baseName = (c) => (c.base ? c.base.replace(/<.*$/, '') : null);
  const lineage = (c) => {
    const out = [c];
    for (let b = c; baseName(b) && classes.has(baseName(b)) && out.length < 20; ) out.push((b = classes.get(baseName(b))));
    return out;
  };
  const propsCache = new Map();
  const propsOf = (name) => {
    if (!propsCache.has(name)) {
      const byName = new Map();
      for (const k of lineage(classes.get(name)).reverse()) for (const p of k.props) byName.set(p.name, { ...p, owner: k.name, t: clrType(p.typeRaw) });
      propsCache.set(name, [...byName.values()].filter((p) => !p.attrs.some((a) => a.name === 'NotMapped')));
    }
    return propsCache.get(name);
  };
  const isScalar = (p) => !p.t.collection && (!!CLR[p.t.name] || enums.has(p.t.name));

  const entities = new Set([...dbSets.keys(), ...configs.keys()].filter((n) => classes.has(n)));
  if (!contexts.length && !entities.size) {
    for (const c of classes.values()) {
      if (!c.static && !c.bases.some((b) => /^IEntityTypeConfiguration/.test(b)) && !/Context$/.test(c.name) && c.props.length) entities.add(c.name);
    }
  }
  for (const queue = [...entities]; queue.length; ) {
    for (const p of propsOf(queue.pop())) {
      const n = p.t.name;
      if (isScalar(p) || !classes.has(n) || entities.has(n) || contexts.some((c) => c.name === n)) continue;
      entities.add(n);
      queue.push(n);
    }
  }
  for (const n of [...entities]) {
    if (classes.get(n).attrs.some((a) => a.name === 'Keyless' || a.name === 'Owned') || configs.get(n)?.noKey) entities.delete(n);
  }

  // -- table of each entity; a class derived from an entity shares its table
  const info = new Map();
  const entityBase = (n) => (entities.has(baseName(classes.get(n))) ? baseName(classes.get(n)) : null);
  const ownTable = (n) => configs.get(n)?.table || classes.get(n).attrs.some((a) => a.name === 'Table');
  for (const n of entities) {
    const cls = classes.get(n);
    const cfg = configs.get(n) ?? emptyConfig();
    const tableAttr = cls.attrs.find((a) => a.name === 'Table');
    let root = n;
    while (!ownTable(root) && entityBase(root)) root = entityBase(root);
    info.set(n, {
      cls, cfg, root,
      table: cfg.table ?? strings(tableAttr?.args)[0] ?? ident(dbSets.get(n) ?? n),
      schema: cfg.schema ?? named(tableAttr?.args, 'Schema') ?? defaultSchema ?? schema,
    });
  }
  const tableOf = (n) => info.get(info.get(n).root);

  const keyOf = (n) => {
    const { cfg } = info.get(n);
    if (cfg.key) return cfg.key;
    const props = propsOf(n);
    const marked = props.filter((p) => p.attrs.some((a) => a.name === 'Key')).map((p) => p.name);
    if (marked.length) return marked;
    for (const k of lineage(classes.get(n))) {
      const pk = k.attrs.find((a) => a.name === 'PrimaryKey');
      if (pk) return splitTop(pk.args).filter((a) => !/^\w+\s*=/.test(a)).flatMap(propNames);
    }
    return [(props.find((p) => lc(p.name) === 'id') ?? props.find((p) => lc(p.name) === lc(`${n}Id`)))?.name].filter(Boolean);
  };
  const keys = new Map([...entities].map((n) => [n, keyOf(info.get(n).root)]));

  // Properties used as foreign keys by the fluent API never become serial.
  const fkProps = new Set();
  for (const n of entities) for (const r of info.get(n).cfg.rels) for (const f of r.fk ?? []) fkProps.add(f);

  // -- columns
  const specs = new Map(); // root entity -> spec
  const colOf = new Map(); // `${entity}.${prop}` -> column
  const newCol = (over) => ({ length: null, precision: null, notNull: false, pk: false, unique: false, default: '', description: '', ref: null, ...over });
  const addColumn = (spec, col) => {
    const base = col.name;
    for (let i = 2; spec.columns.some((c) => c.name === col.name); i++) col.name = `${base}_${i}`;
    spec.columns.push(col);
    return col;
  };

  for (const n of entities) {
    const { cfg, cls, root } = info.get(n);
    const t = tableOf(n);
    if (!specs.has(root)) specs.set(root, { key: '', sheet: '', layout: 'definition', name: t.table, schema: t.schema, rows: 0, columns: [], description: '' });
    const spec = specs.get(root);
    spec.description ||= cfg.comment ?? strings(cls.attrs.find((a) => a.name === 'Comment')?.args)[0] ?? '';
    const folded = root !== n;
    const own = new Set(cls.props.map((p) => p.name));
    for (const p of propsOf(n)) {
      if (!isScalar(p) || cfg.ignore.has(p.name) || (folded && !own.has(p.name))) continue;
      const pc = cfg.props.get(p.name) ?? {};
      const attr = (name) => p.attrs.find((a) => a.name === name);
      const colAttr = attr('Column');
      const isKey = !folded && keys.get(n).includes(p.name);
      let type = { ...(CLR[p.t.name] ?? { type: 'integer' }) };
      const columnType = pc.columnType ?? named(colAttr?.args, 'TypeName');
      if (columnType) type = normalizeType(columnType);
      else {
        const max = pc.maxLength ?? parseInt(attr('MaxLength')?.args || attr('StringLength')?.args, 10);
        if (p.t.name === 'string' && max > 0) type = { type: 'character varying', length: max };
        const prec = attr('Precision');
        const pp = pc.precision ?? (prec ? parseInt(splitTop(prec.args)[0], 10) : NaN);
        if (p.t.name === 'decimal' && Number.isFinite(pp)) {
          const sc = pc.precision !== undefined ? pc.scale : prec ? parseInt(splitTop(prec.args)[1], 10) : 0;
          type = { type: 'numeric', length: pp, precision: Number.isFinite(sc) ? sc : 0 };
        }
        if (attr('Timestamp')) type = { type: 'bytea' };
      }
      const dbGen = attr('DatabaseGenerated')?.args ?? '';
      const never = pc.never || /\bNone\b/.test(dbGen);
      if (SERIAL[type.type] && !never && !columnType && ((isKey && keys.get(n).length === 1 && !fkProps.has(p.name)) || /Identity/.test(dbGen) || pc.generated)) {
        type = { type: SERIAL[type.type] };
      }
      let notNull = isKey || !!attr('Required') || p.required || (!p.t.nullable && (!REFERENCE_TYPES.has(p.t.name) || nullableContext));
      if (pc.required !== undefined) notNull = pc.required;
      if (isKey) notNull = true;
      if (folded) notNull = false;
      colOf.set(`${n}.${p.name}`, addColumn(spec, newCol({
        name: pc.column ?? strings(colAttr?.args)[0] ?? ident(p.name),
        ...type,
        notNull,
        pk: isKey,
        default: pc.defaultSql ?? pc.defaultValue ?? '',
        description: pc.comment ?? strings(attr('Comment')?.args)[0] ?? '',
      })));
    }
    if ([...entities].some((o) => o !== n && info.get(o).root === n && o !== n)) {
      addColumn(spec, newCol({ name: 'discriminator', type: 'text', notNull: true }));
    }
  }

  // -- unique indexes on one column, from [Index] and HasIndex
  for (const n of entities) {
    const { cfg, cls } = info.get(n);
    const indexes = [...cfg.indexes];
    for (const k of lineage(cls)) {
      for (const a of k.attrs.filter((x) => x.name === 'Index')) {
        indexes.push({ cols: splitTop(a.args).filter((x) => !/^\w+\s*=/.test(x)).flatMap(propNames), unique: /IsUnique\s*=\s*true/.test(a.args) });
      }
    }
    for (const ix of indexes) if (ix.unique && ix.cols.length === 1 && colOf.get(`${n}.${ix.cols[0]}`)) colOf.get(`${n}.${ix.cols[0]}`).unique = true;
  }

  // -- foreign keys
  // The column of `entity.prop`; a property the class does not have becomes a shadow column.
  const columnFor = (entity, prop, like, notNull) => {
    const found = colOf.get(`${entity}.${prop}`);
    if (found) return found;
    const col = addColumn(specs.get(info.get(entity).root), newCol({
      name: info.get(entity).cfg.props.get(prop)?.column ?? ident(prop),
      type: PLAIN_SERIAL[like.type] ?? like.type, length: like.length, precision: like.precision, notNull,
    }));
    colOf.set(`${entity}.${prop}`, col);
    return col;
  };
  const link = (dep, depProps, prin, prinProps, { unique = false, notNull = false } = {}) => {
    const target = tableOf(prin);
    (prinProps?.length ? prinProps : keys.get(prin)).forEach((pk, i) => {
      const pcol = colOf.get(`${prin}.${pk}`);
      if (!pcol || !depProps[i]) return;
      const col = columnFor(dep, depProps[i], pcol, notNull);
      col.ref = { schema: target.schema, table: target.table, column: pcol.name };
      if (unique && depProps.length === 1) col.unique = true;
    });
  };
  const navProp = (entity, nav) => propsOf(entity).find((p) => p.name === nav && entities.has(p.t.name));
  const hasRequired = (entity, nav) => !!nav && propsOf(entity).some((p) => p.name === nav && p.attrs.some((a) => a.name === 'Required'));
  const done = new Set();

  for (const n of entities) {
    for (const r of info.get(n).cfg.rels) {
      if (!r.fk) continue;
      const other = r.nav && navProp(n, r.nav) ? navProp(n, r.nav).t.name : bare(r.target);
      if (!entities.has(other)) continue;
      let dep = n;
      let prin = other;
      if (r.kind === 'HasMany') [dep, prin] = [other, n];
      else if (r.inverseKind === 'WithOne' && r.fkGeneric) [dep, prin] = [bare(r.fkGeneric), bare(r.fkGeneric) === n ? other : n];
      if (!entities.has(dep) || !entities.has(prin)) continue;
      const depNav = r.kind === 'HasMany' ? r.inverse : r.nav;
      link(dep, r.fk, prin, r.principalKey, { unique: r.kind === 'HasOne' && r.inverseKind === 'WithOne', notNull: hasRequired(dep, depNav) });
      if (r.nav) done.add(`${n}.${r.nav}`);
      if (r.inverse) done.add(`${other}.${r.inverse}`);
    }
  }

  // Reference navigations: [ForeignKey] on either side, then EF's naming conventions.
  for (const n of entities) {
    const props = propsOf(n);
    for (const nav of props) {
      const prin = nav.t.name;
      if (nav.t.collection || isScalar(nav) || !entities.has(prin) || done.has(`${n}.${nav.name}`) || info.get(n).cfg.ignore.has(nav.name)) continue;
      done.add(`${n}.${nav.name}`);
      const pkeys = keys.get(prin);
      let fk = strings(nav.attrs.find((a) => a.name === 'ForeignKey')?.args)[0]?.split(',').map((s) => s.trim());
      fk ??= props.filter((p) => isScalar(p) && p.attrs.some((a) => a.name === 'ForeignKey' && strings(a.args)[0] === nav.name)).map((p) => p.name);
      if (!fk.length) {
        const prefixes = [nav.name, prin];
        const per = pkeys.map((k) => prefixes.map((x) => props.find((p) => isScalar(p) && lc(p.name) === lc(`${x}${k}`))).find(Boolean)?.name);
        const idOnly = prefixes.map((x) => props.find((p) => isScalar(p) && lc(p.name) === lc(`${x}Id`))).find(Boolean)?.name;
        if (per.length && !per.includes(undefined)) fk = per;
        else if (idOnly && pkeys.length === 1) fk = [idOnly];
      }
      const back = propsOf(prin).find((p) => p.t.name === n && !p.t.collection && !isScalar(p));
      if (fk.length) {
        link(n, fk, prin, null, { notNull: hasRequired(n, nav.name), unique: !!back });
      } else if (!back) {
        // No foreign key property: EF adds a shadow one named after the navigation.
        link(n, pkeys.map((k) => `${nav.name}${k}`), prin, null, { notNull: hasRequired(n, nav.name) || (!nav.t.nullable && nullableContext) });
      }
    }
  }

  // Many-to-many: two collection navigations that point at each other.
  const joins = [];
  for (const n of entities) {
    for (const a of propsOf(n)) {
      const m = a.t.name;
      if (!a.t.collection || m === n || n > m || !entities.has(m)) continue;
      const b = propsOf(m).find((p) => p.t.collection && p.t.name === n);
      if (!b || keys.get(n).length !== 1 || keys.get(m).length !== 1 || !colOf.get(`${n}.${keys.get(n)[0]}`) || !colOf.get(`${m}.${keys.get(m)[0]}`)) continue;
      const side = (entity, nav) => {
        const pcol = colOf.get(`${entity}.${keys.get(entity)[0]}`);
        const tt = tableOf(entity);
        return newCol({
          name: ident(`${nav}${keys.get(entity)[0]}`), type: PLAIN_SERIAL[pcol.type] ?? pcol.type, length: pcol.length, precision: pcol.precision,
          notNull: true, pk: true, ref: { schema: tt.schema, table: tt.table, column: pcol.name },
        });
      }
      joins.push({
        key: '', sheet: '', layout: 'definition', name: ident([a.name, b.name].sort().join('')), schema: tableOf(n).schema,
        rows: 0, description: '', columns: [side(n, b.name), side(m, a.name)],
      });
    }
  }

  const out = [...specs.values(), ...joins].filter((s) => s.columns.length);
  // Key columns first, like EF.
  for (const s of out) s.columns.sort((a, b) => Number(b.pk) - Number(a.pk));
  for (const s of out) {
    s.key = `${s.schema}.${s.name}`;
    s.sheet = 'EF Core';
  }
  return out;
}

// ---------------------------------------------------------------- JSON

const flag = (v) => (typeof v === 'string' ? /^(true|yes|y|1)$/i.test(v) : !!v);
const present = (v) => v !== undefined && v !== null && v !== '';

/** Table specs from the JSON description documented at the top of this file. */
export function parseJsonModel(text, { schema = 'public', snakeCase: snake = true } = {}) {
  let json;
  try {
    json = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }
  const list = Array.isArray(json) ? json : json?.tables ?? json?.entities;
  if (!Array.isArray(list)) throw new Error('Expected a "tables" array');
  const ident = (s) => (snake ? snakeCase(s) : String(s ?? '').trim());
  const rootSchema = Array.isArray(json) ? null : json.schema;
  const out = [];
  for (const t of list) {
    const name = ident(t?.name ?? t?.table);
    if (!name) throw new Error('A table has no name');
    const tschema = t.schema ?? rootSchema ?? schema;
    const cols = t.columns ?? t.fields ?? t.properties;
    if (!Array.isArray(cols)) throw new Error(`Table ${name} has no "columns" array`);
    const used = new Set();
    const columns = cols.map((c, i) => {
      const cname = ident(c?.name);
      if (!cname) throw new Error(`Column ${i + 1} of ${name} has no name`);
      if (used.has(cname)) throw new Error(`Column ${cname} is repeated in ${name}`);
      used.add(cname);
      const type = normalizeType(c.type);
      const len = c.length ?? c.maxLength;
      if (present(len)) type.length = Number(len);
      if (present(c.precision)) {
        type.length = Number(c.precision);
        type.precision = present(c.scale) ? Number(c.scale) : null;
      } else if (present(c.scale)) type.precision = Number(c.scale);
      let ref = null;
      const r = c.references ?? c.ref;
      if (typeof r === 'string') ref = parseReference(r);
      else if (r && typeof r === 'object') ref = { schema: r.schema ?? null, table: r.table, column: r.column ?? null };
      if (ref) {
        ref.table = ident(ref.table);
        if (ref.column) ref.column = ident(ref.column);
      }
      const pk = flag(c.pk ?? c.primaryKey);
      return {
        name: cname,
        ...type,
        notNull: pk || flag(c.notNull ?? c.required) || (present(c.nullable) && !flag(c.nullable)),
        pk,
        unique: flag(c.unique),
        default: present(c.default) ? String(c.default) : '',
        description: c.description ?? c.comment ?? '',
        ref,
      };
    });
    for (const k of t.primaryKey ?? []) {
      const col = columns.find((c) => c.name === ident(k));
      if (col) col.pk = col.notNull = true;
    }
    for (const fk of t.foreignKeys ?? []) {
      const target = fk.references ?? {};
      const to = [].concat(target.columns ?? target.column ?? []);
      [].concat(fk.columns ?? fk.column ?? []).forEach((f, i) => {
        const col = columns.find((c) => c.name === ident(f));
        if (col) col.ref = { schema: target.schema ?? null, table: ident(target.table), column: to[i] ? ident(to[i]) : null };
      });
    }
    out.push({ key: `${tschema}.${name}`, sheet: 'JSON', layout: 'definition', name, schema: tschema, rows: 0, description: t.description ?? t.comment ?? '', columns });
  }
  return out;
}

/** Specs for a .cs or .json file's text, chosen by the file name. */
export function parseModelSource(fileName, text, options) {
  return /\.json$/i.test(fileName) ? parseJsonModel(text, options) : parseEfCore(text, options);
}

export const MODEL_EXT = /\.(cs|json)$/i;
