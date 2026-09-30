// pgvector (https://github.com/pgvector/pgvector) support shared by the
// diagram, migrations, the script runtime and the query analyzer: vector
// type detection, value encoding and decoding, distance operators and the
// index SQL that makes nearest-neighbour queries fast. No imports, so both
// the renderer and the main process can load it.

export const VECTOR_EXTENSION = 'vector';
export const CREATE_VECTOR_EXTENSION = 'CREATE EXTENSION IF NOT EXISTS vector;';
export const VECTOR_TYPES = ['vector', 'halfvec', 'sparsevec'];

// HNSW and IVFFlat index at most this many dimensions (sparsevec: non-zero
// elements); larger vectors can be indexed as halfvec, up to 4,000.
const INDEX_MAX_DIMS = { vector: 2000, halfvec: 4000 };

// Distance operators, cheapest first as pgvector's docs list them.
export const VECTOR_DISTANCES = [
  { metric: 'l2', operator: '<->', label: 'L2 (Euclidean) distance' },
  { metric: 'cosine', operator: '<=>', label: 'cosine distance' },
  { metric: 'ip', operator: '<#>', label: 'negative inner product' },
  { metric: 'l1', operator: '<+>', label: 'L1 (taxicab) distance' },
];

// 'vector', 'vector(3)', 'public.vector(3)', '"extensions"."halfvec"' -> kind;
// anything else (arrays of vectors included) -> null.
export function vectorKind(type) {
  const t = String(type ?? '').toLowerCase().replace(/"/g, '').trim();
  if (/\[\]$/.test(t)) return null;
  const name = t.replace(/\s*\(\s*\d*\s*\)$/, '').split('.').pop().trim();
  return VECTOR_TYPES.includes(name) ? name : null;
}

export const isVectorType = (type) => vectorKind(type) !== null;

// 'vector(1536)' -> 1536; no dimensions -> null.
export function vectorDimensions(type) {
  const m = String(type ?? '').match(/\(\s*(\d+)\s*\)\s*$/);
  return m ? Number(m[1]) : null;
}

// Whether any column uses a pgvector type. Accepts diagram tables (column
// .type + .length) and schema-model tables (column .databaseType).
export function usesPgvector(tables) {
  return (tables ?? []).some((t) => (t.columns ?? []).some((c) => isVectorType(c.databaseType ?? c.type)));
}

// A JS value as pgvector text input: number arrays (and Float32Array etc.)
// become '[1,2,3]', or '{1:1,3:2}/3' for sparsevec (1-based, zeros left
// out). Strings are passed through, so '[1,2,3]' works as well.
export function toVectorText(kind, v) {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) v = Array.from(v);
  if (!Array.isArray(v)) return v;
  const nums = v.map(Number);
  const bad = nums.findIndex((x) => !Number.isFinite(x));
  if (bad !== -1) throw new Error(`Vector element ${bad} is not a finite number: ${v[bad]}`);
  if (kind === 'sparsevec') {
    const parts = [];
    nums.forEach((x, i) => {
      if (x !== 0) parts.push(`${i + 1}:${x}`);
    });
    return `{${parts.join(',')}}/${nums.length}`;
  }
  return `[${nums.join(',')}]`;
}

// PostgreSQL's text output of vector / halfvec ('[1,2,3]') -> [1, 2, 3].
// Anything else (sparsevec text, null) is returned unchanged.
export function parseVectorText(s) {
  if (typeof s !== 'string') return s;
  const m = s.trim().match(/^\[([\s\S]*)\]$/);
  if (!m) return s;
  return m[1].trim() ? m[1].split(',').map(Number) : [];
}

// Short display form for long vectors: '[0.1,0.2,0.3,…] (1536 dims)'.
export function abbreviateVector(text, keep = 6) {
  const s = String(text ?? '');
  const m = s.match(/^\[([\s\S]*)\]$/);
  if (!m) return s;
  const parts = m[1].split(',');
  if (parts.length <= keep) return s;
  return `[${parts.slice(0, keep).join(',')},…] (${parts.length} dims)`;
}

const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Operator class for a column kind and metric, e.g. vector + cosine ->
// vector_cosine_ops. IVFFlat has no L1 or sparsevec support.
export function vectorOpclass(kind, metric = 'cosine', method = 'hnsw') {
  if (method === 'ivfflat' && (kind === 'sparsevec' || metric === 'l1')) return null;
  return `${kind}_${metric}_ops`;
}

/**
 * CREATE INDEX for nearest-neighbour search on a vector column.
 * table: { schema, name }; column: { name, type | databaseType, length? }.
 * Vectors with more dimensions than HNSW/IVFFlat index directly (2,000)
 * are indexed through a halfvec expression, which pgvector supports up to
 * 4,000 dimensions; queries must then use the same cast.
 * Returns { sql, note? } or null when the column can't be indexed.
 */
export function vectorIndexSQL(table, column, { metric = 'cosine', method = 'hnsw' } = {}) {
  const type = column.databaseType ?? column.type;
  const kind = vectorKind(type);
  if (!kind) return null;
  const dims = vectorDimensions(type) ?? (Number(column.length) || null);
  const target = `${table.schema ? `${quote(table.schema)}.` : ''}${quote(table.name)}`;
  let expr = quote(column.name);
  let opsKind = kind;
  let note;
  if (kind !== 'sparsevec' && dims && dims > INDEX_MAX_DIMS[kind]) {
    if (kind !== 'vector' || dims > INDEX_MAX_DIMS.halfvec) return null;
    expr = `(${quote(column.name)}::halfvec(${dims}))`;
    opsKind = 'halfvec';
    note = `${dims} dimensions is above the ${INDEX_MAX_DIMS.vector} that ${method} indexes for vector, so this indexes it as halfvec; ORDER BY ${column.name}::halfvec(${dims}) ${distanceOf(metric).operator} … to use it.`;
  }
  const ops = vectorOpclass(opsKind, metric, method);
  if (!ops) return null;
  const withLists = method === 'ivfflat' ? ' WITH (lists = 100)' : '';
  return { sql: `CREATE INDEX ON ${target} USING ${method} (${expr} ${ops})${withLists};`, note };
}

export const distanceOf = (metric) => VECTOR_DISTANCES.find((d) => d.metric === metric) ?? VECTOR_DISTANCES[1];
export const metricOfOperator = (op) => VECTOR_DISTANCES.find((d) => d.operator === op)?.metric ?? null;

// Vector (HNSW / IVFFlat) indexes on a column, from index definitions as
// pg_get_indexdef() prints them: [{ name, method, metric }].
export function vectorIndexesOn(table, columnName) {
  const out = [];
  const col = new RegExp(`\\(+\\s*"?${columnName.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')}"?[\\s:)]`);
  for (const i of table.indexes ?? []) {
    const def = String(i.definition ?? '');
    const m = def.match(/\bUSING\s+(hnsw|ivfflat)\b/i);
    if (!m || !col.test(def.slice(m.index))) continue;
    const ops = def.match(/\b(?:vector|halfvec|sparsevec|bit)_(l2|cosine|ip|l1|hamming|jaccard)_ops\b/i);
    out.push({ name: i.name, method: m[1].toLowerCase(), metric: ops ? ops[1].toLowerCase() : null });
  }
  return out;
}

// Random unit vector with `dims` elements, from a faker-like generator.
export function randomVector(faker, dims) {
  const n = Math.max(1, dims || 3);
  const v = Array.from({ length: n }, () => faker.number.float({ min: -1, max: 1, fractionDigits: 6 }));
  const len = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => Number((x / len).toFixed(6)));
}
