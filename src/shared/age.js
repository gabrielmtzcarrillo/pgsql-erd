// Apache AGE (https://age.apache.org) support shared by the main process and
// the Graph tab: agtype parsing, Cypher literals and the column list that
// cypher() calls need. No imports, so both sides can load it.
//
// Graph element ids (graphid) are 64-bit and often above
// Number.MAX_SAFE_INTEGER, so they are always kept as strings here.

export const AGE_EXTENSION = 'age';

// Graph names: AGE wants 3–63 characters; we also keep them plain identifiers
// so they can be used unquoted in SQL and Cypher.
export const isGraphName = (s) => /^[A-Za-z_][A-Za-z0-9_]{2,62}$/.test(String(s ?? ''));
export const isLabelName = (s) => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(String(s ?? '')) && !String(s).startsWith('_ag_');
export const isGraphId = (s) => /^\d{1,20}$/.test(String(s ?? ''));

const SAFE = /^-?\d+$/;
const bigInt = (digits) => SAFE.test(digits) && !Number.isSafeInteger(Number(digits));

/**
 * Parse agtype text output: JSON with ::vertex, ::edge, ::path and ::numeric
 * annotations. Vertices become { kind: 'vertex', id, label, properties },
 * edges { kind: 'edge', id, label, start, end, properties }, paths
 * { kind: 'path', items }. Integers too large for a JS number (and ::numeric
 * values) become strings.
 */
export function parseAgtype(text) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  let out = '';
  const opens = []; // output offsets of open [ and {
  let lastNumber = -1; // output offset of the last number token
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
      lastNumber = -1;
      continue;
    }
    if (ch === '[' || ch === '{') {
      opens.push(out.length);
      out += ch;
      i++;
      continue;
    }
    if (ch === ']' || ch === '}') {
      const start = opens.pop();
      out += ch;
      i++;
      const m = s.slice(i).match(/^::(vertex|edge|path)\b/);
      if (m) {
        out = `${out.slice(0, start)}{"__ag":"${m[1]}","v":${out.slice(start)}}`;
        i += m[0].length;
      }
      lastNumber = -1;
      continue;
    }
    if (s.startsWith('::numeric', i)) {
      if (lastNumber !== -1) out = `${out.slice(0, lastNumber)}"${out.slice(lastNumber).replace(/^"|"$/g, '')}"`;
      i += '::numeric'.length;
      continue;
    }
    const num = s.slice(i).match(/^-?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (num && /[-\d]/.test(ch)) {
      lastNumber = out.length;
      out += bigInt(num[0]) ? `"${num[0]}"` : num[0];
      i += num[0].length;
      continue;
    }
    const special = s.slice(i).match(/^-?(?:NaN|Infinity)/);
    if (special) {
      out += 'null';
      i += special[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return convert(JSON.parse(out));
}

function convert(v) {
  if (Array.isArray(v)) return v.map(convert);
  if (v === null || typeof v !== 'object') return v;
  if (v.__ag) {
    const x = v.v;
    if (v.__ag === 'path') return { kind: 'path', items: x.map(convert) };
    const el = { kind: v.__ag, id: String(x.id), label: x.label, properties: convert(x.properties ?? {}) };
    if (v.__ag === 'edge') Object.assign(el, { start: String(x.start_id), end: String(x.end_id) });
    return el;
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x)]));
}

// Properties as stored (agtype text of a map) -> object.
export const parseProperties = (text) => (text === null || text === undefined ? {} : parseAgtype(text) ?? {});

// Cypher name in backticks (labels, property keys).
export function cypherName(name) {
  const s = String(name);
  if (!s || s.includes('`')) throw new Error(`Invalid name: ${s}`);
  return `\`${s}\``;
}

// A JS value as a Cypher literal. AGE doesn't accept parameters for property
// maps in CREATE or SET, so properties are written as literals.
export function cypherLiteral(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Not a finite number: ${v}`);
    return String(v);
  }
  if (typeof v === 'string') {
    return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;
  }
  if (Array.isArray(v)) return `[${v.map(cypherLiteral).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${cypherName(k)}: ${cypherLiteral(x)}`).join(', ')}}`;
  throw new Error(`Unsupported value: ${typeof v}`);
}

// Walk Cypher text outside string literals and backtick names.
function codeSpans(query) {
  const spans = [];
  const q = String(query);
  let i = 0;
  let start = 0;
  while (i < q.length) {
    const ch = q[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      spans.push([start, i]);
      let j = i + 1;
      while (j < q.length && q[j] !== ch) j += q[j] === '\\' && ch !== '`' ? 2 : 1;
      i = j + 1;
      start = i;
      continue;
    }
    if (ch === '/' && q[i + 1] === '/') {
      spans.push([start, i]);
      const nl = q.indexOf('\n', i);
      i = nl === -1 ? q.length : nl;
      start = i;
      continue;
    }
    i++;
  }
  spans.push([start, q.length]);
  return spans;
}

// Query text with strings, names and comments blanked out (same length).
function maskLiterals(query) {
  const q = String(query);
  const out = ' '.repeat(q.length).split('');
  for (const [a, b] of codeSpans(q)) for (let k = a; k < b; k++) out[k] = q[k];
  return out.join('');
}

// Whether a Cypher query changes the graph.
export const isCypherWrite = (query) => /\b(CREATE|MERGE|SET|DELETE|REMOVE)\b/i.test(maskLiterals(query));

/**
 * Column names for the AS (...) list of a cypher() call, from the last
 * RETURN clause: aliases (AS x), plain variables, a.b -> a_b, otherwise cN.
 * A query without RETURN gets one column. RETURN * can't be resolved here.
 */
export function cypherReturnColumns(query) {
  const q = String(query);
  const masked = maskLiterals(q);
  // Top-level positions (outside (), [], {}).
  const depthAt = [];
  let d = 0;
  for (let k = 0; k < masked.length; k++) {
    if ('([{'.includes(masked[k])) d++;
    depthAt[k] = d;
    if (')]}'.includes(masked[k])) d--;
  }
  const top = (re) => {
    const hits = [];
    const r = new RegExp(re.source, 'gi');
    let m;
    while ((m = r.exec(masked))) if (depthAt[m.index] === 0) hits.push(m);
    return hits;
  };
  const ret = top(/\bRETURN\b/).at(-1);
  if (!ret) return ['result'];
  let from = ret.index + ret[0].length;
  const end = top(/\b(ORDER\s+BY|SKIP|LIMIT|UNION)\b/).find((m) => m.index > from)?.index ?? masked.length;
  let clause = masked.slice(from, end);
  const distinct = clause.match(/^\s*DISTINCT\b/i);
  if (distinct) {
    from += distinct[0].length;
    clause = masked.slice(from, end);
  }
  if (clause.trim() === '*') throw new Error('RETURN * needs explicit columns: list them in the Columns field.');
  const items = [];
  let last = from;
  for (let k = from; k < end; k++) if (masked[k] === ',' && depthAt[k] === 0) items.push([last, k]), (last = k + 1);
  items.push([last, end]);
  const used = new Set();
  return items.map(([a, b], n) => {
    const text = q.slice(a, b).trim().replace(/;$/, '');
    let name = text.match(/\s+AS\s+`([^`]+)`\s*$/i)?.[1] ?? text.match(/\s+AS\s+([A-Za-z_]\w*)\s*$/i)?.[1];
    if (!name && /^[A-Za-z_]\w*$/.test(text)) name = text;
    if (!name && /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(text)) name = text.replace('.', '_');
    name ||= `c${n + 1}`;
    let unique = name;
    for (let k = 2; used.has(unique); k++) unique = `${name}_${k}`;
    used.add(unique);
    return unique;
  });
}

// Dollar-quote tag that doesn't occur in the text.
export function dollarQuote(text) {
  let tag = '$cypher$';
  for (let n = 1; String(text).includes(tag); n++) tag = `$cypher${n}$`;
  return `${tag}${text}${tag}`;
}

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sqlIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

// SELECT * FROM cypher(...) AS (...) for a query. params: SQL parameter
// placeholder (e.g. '$1') holding an agtype map, or null.
export function cypherSQL(graph, query, { columns = null, params = null } = {}) {
  if (!isGraphName(graph)) throw new Error(`Invalid graph name: ${graph}`);
  const text = String(query ?? '').trim().replace(/;\s*$/, '');
  if (!text) throw new Error('Type a Cypher query first.');
  const cols = columns?.length ? columns : cypherReturnColumns(text);
  return `SELECT * FROM ag_catalog.cypher(${sqlLiteral(graph)}, ${dollarQuote(` ${text} `)}${params ? `, ${params}` : ''}) AS (${cols.map((c) => `${sqlIdent(c)} ag_catalog.agtype`).join(', ')})`;
}

// Vertices and edges found anywhere in parsed results (rows of values).
export function graphElements(values) {
  const vertices = new Map();
  const edges = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.kind === 'vertex') vertices.set(v.id, v);
      else if (v.kind === 'edge') edges.set(v.id, v);
      else if (v.kind === 'path') v.items.forEach(walk);
      else Object.values(v).forEach(walk);
    }
  };
  walk(values);
  return { vertices: [...vertices.values()], edges: [...edges.values()] };
}

// A short name for a vertex: its name / title property, another short
// string property, or label and id.
export function vertexCaption(v) {
  const p = v?.properties ?? {};
  for (const k of ['name', 'title', 'label', 'username', 'email', 'code', 'key']) if (typeof p[k] === 'string' && p[k]) return p[k];
  const s = Object.values(p).find((x) => typeof x === 'string' && x && x.length <= 40);
  return s ?? `${v?.label ?? 'vertex'} ${String(v?.id ?? '').slice(-6)}`;
}

// Compact JSON of properties for tables.
export function formatProperties(p) {
  const keys = Object.keys(p ?? {});
  if (!keys.length) return '';
  return JSON.stringify(p);
}

// A result value as display text.
export function formatAgValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return typeof v === 'string' ? v : String(v);
  if (v.kind === 'vertex') return `(${v.label} ${vertexCaption(v)})`;
  if (v.kind === 'edge') return `[:${v.label} ${v.start}→${v.end}]${Object.keys(v.properties).length ? ` ${JSON.stringify(v.properties)}` : ''}`;
  if (v.kind === 'path') return v.items.map(formatAgValue).join('-');
  return JSON.stringify(v);
}
