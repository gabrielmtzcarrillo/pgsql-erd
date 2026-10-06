// PostgreSQL DDL generation from the internal ERD model.

import { foreignKeysOf } from './pgerd.js';
import { usesPgvector, CREATE_VECTOR_EXTENSION } from '../../shared/pgvector.js';

const RESERVED = new Set(
  `all analyse analyze and any array as asc asymmetric authorization binary both case cast
  check collate collation column concurrently constraint create cross current_catalog
  current_date current_role current_schema current_time current_timestamp current_user
  default deferrable desc distinct do else end except false fetch for foreign freeze from
  full grant group having ilike in initially inner intersect into is isnull join lateral
  leading left like limit localtime localtimestamp natural not notnull null offset on only
  or order outer overlaps placing primary references returning right select session_user
  similar some symmetric system_user table tablesample then to trailing true union unique
  user using variadic verbose when where window with`.split(/\s+/)
);

export function quoteIdent(name) {
  const s = String(name ?? '');
  if (/^[a-z_][a-z0-9_$]*$/.test(s) && !RESERVED.has(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function quoteLiteral(s) {
  return `'${String(s ?? '').replace(/'/g, "''")}'`;
}

export function qualifiedName(table) {
  return table.schema
    ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
    : quoteIdent(table.name);
}

// "character varying" + 20 -> "character varying(20)"; keeps array suffix last.
export function formatType(col) {
  let type = String(col.type ?? '').trim() || 'text';
  let suffix = '';
  const m = type.match(/^(.*?)((?:\[\])+)$/);
  if (m) {
    type = m[1];
    suffix = m[2];
  }
  const hasLen = col.length !== null && col.length !== undefined && col.length !== '';
  const hasPrec = col.precision !== null && col.precision !== undefined && col.precision !== '';
  if (hasLen && !/\(/.test(type)) {
    const args = hasPrec ? `${col.length},${col.precision}` : `${col.length}`;
    // Time types take precision after the type name but before "with/without time zone".
    const tz = type.match(/^(time|timestamp)( with(?:out)? time zone)$/i);
    type = tz ? `${tz[1]}(${args})${tz[2]}` : `${type}(${args})`;
  }
  return type + suffix;
}

export const FK_ACTIONS = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

export function columnDDL(col) {
  const parts = [quoteIdent(col.name), formatType(col)];
  const raw = col.raw ?? {};
  if (raw.colconstype === 'i' && raw.attidentity) {
    parts.push(`GENERATED ${raw.attidentity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`);
  } else if (raw.colconstype === 'g' && raw.genexpr) {
    parts.push(`GENERATED ALWAYS AS (${raw.genexpr}) STORED`);
  }
  if (col.notNull || col.pk) parts.push('NOT NULL');
  if (col.default !== '' && col.default !== null && col.default !== undefined && raw.colconstype !== 'g') {
    parts.push(`DEFAULT ${col.default}`);
  }
  return parts.join(' ');
}

// Unique constraints of a table whose columns all still exist.
export function uniqueConstraints(t) {
  const colNames = new Set(t.columns.map((c) => c.name));
  return (t.rawData?.unique_constraint ?? [])
    .map((u) => ({ name: u.name ?? '', columns: (u.columns ?? []).map((c) => c.column) }))
    .filter((u) => u.columns.length && u.columns.every((c) => colNames.has(c)));
}

export function createTableSQL(t) {
  const lines = t.columns.map((c) => `    ${columnDDL(c)}`);
  const pk = t.columns.filter((c) => c.pk);
  if (pk.length) {
    const pkName = t.rawData?.primary_key?.[0]?.name;
    const con = pkName ? `CONSTRAINT ${quoteIdent(pkName)} ` : '';
    lines.push(`    ${con}PRIMARY KEY (${pk.map((c) => quoteIdent(c.name)).join(', ')})`);
  }
  for (const u of uniqueConstraints(t)) {
    const con = u.name ? `CONSTRAINT ${quoteIdent(u.name)} ` : '';
    lines.push(`    ${con}UNIQUE (${u.columns.map(quoteIdent).join(', ')})`);
  }
  const out = [`CREATE TABLE IF NOT EXISTS ${qualifiedName(t)}`, '(', lines.join(',\n'), ');'];
  if (t.description) {
    out.push('', `COMMENT ON TABLE ${qualifiedName(t)}`, `    IS ${quoteLiteral(t.description)};`);
  }
  return out.join('\n');
}

// Resolve a group of links (one FK constraint) into column pairs.
export function foreignKeyPairs(model, table, links) {
  const ref = model.tables.find((t) => t.id === links[0].refTable);
  if (!ref) return null;
  const pairs = links
    .map((l) => [
      table.columns.find((c) => c.attnum === l.localCol),
      ref.columns.find((c) => c.attnum === l.refCol),
    ])
    .filter(([a, b]) => a && b);
  return pairs.length ? { ref, pairs } : null;
}

// PostgreSQL's own name for an unnamed foreign key (without the numeric
// suffix it adds on collisions), cut to the 63-byte identifier limit.
export function defaultForeignKeyName(table, columns) {
  let name = `${table.name}_${columns.join('_')}_fkey`;
  while (new TextEncoder().encode(name).length > 63) name = name.slice(0, -1);
  return name;
}

// A foreign key is always added under a name: an unnamed ADD FOREIGN KEY
// creates another copy (…_fkey1, …_fkey2) each time the script runs.
// replace: drop a constraint of the same name first, so the script can be
// run again.
export function addForeignKeySQL(model, table, links, { replace = false } = {}) {
  const fk = foreignKeyPairs(model, table, links);
  if (!fk) return null;
  const rawFk = links[0].rawFk ?? {};
  const name = links[0].fkName || defaultForeignKeyName(table, fk.pairs.map(([a]) => a.name));
  return [
    `ALTER TABLE IF EXISTS ${qualifiedName(table)}`,
    ...(replace ? [`    DROP CONSTRAINT IF EXISTS ${quoteIdent(name)},`] : []),
    `    ADD CONSTRAINT ${quoteIdent(name)} FOREIGN KEY (${fk.pairs
      .map(([a]) => quoteIdent(a.name))
      .join(', ')})`,
    `    REFERENCES ${qualifiedName(fk.ref)} (${fk.pairs.map(([, b]) => quoteIdent(b.name)).join(', ')})`,
    `    MATCH ${rawFk.confmatchtype ? 'FULL' : 'SIMPLE'}`,
    `    ON UPDATE ${FK_ACTIONS[rawFk.confupdtype] ?? 'NO ACTION'}`,
    `    ON DELETE ${FK_ACTIONS[rawFk.confdeltype] ?? 'NO ACTION'};`,
  ].join('\n');
}

export function generateSQL(model) {
  const out = ['-- Generated by pgsql-erd', 'BEGIN;', ''];

  const schemas = [...new Set(model.tables.map((t) => t.schema).filter(Boolean))].filter(
    (s) => s !== 'public'
  );
  for (const s of schemas) out.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`);
  if (schemas.length) out.push('');
  // vector / halfvec / sparsevec columns need the pgvector extension.
  if (usesPgvector(model.tables)) out.push(CREATE_VECTOR_EXTENSION, '');

  for (const t of model.tables) out.push(createTableSQL(t), '');

  for (const t of model.tables) {
    for (const links of foreignKeysOf(model, t)) {
      const sql = addForeignKeySQL(model, t, links, { replace: true });
      if (sql) out.push(sql, '');
    }
  }

  out.push('END;');
  return out.join('\n') + '\n';
}
