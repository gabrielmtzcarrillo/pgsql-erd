// Compare a database schema with the diagram and generate the SQL that makes
// the database match the diagram. Both sides use the internal ERD model
// (the database side comes from catalog.js).

import { foreignKeysOf } from './pgerd.js';
import {
  quoteIdent, quoteLiteral, qualifiedName, formatType, columnDDL, createTableSQL,
  addForeignKeySQL, foreignKeyPairs, uniqueConstraints,
} from './sql.js';
import { tableKey } from './catalog.js';

const ALIASES = {
  int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint',
  serial4: 'serial', serial8: 'bigserial', serial2: 'smallserial',
  varchar: 'character varying', char: 'character', bpchar: 'character',
  bool: 'boolean', float8: 'double precision', float4: 'real', float: 'double precision',
  decimal: 'numeric', timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone', timetz: 'time with time zone',
  time: 'time without time zone', varbit: 'bit varying',
};
const SERIALS = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' };

function parseType(col) {
  let type = String(col.type ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  let { length, precision } = col;
  let arr = '';
  const m = type.match(/^(.*?)((?:\[\])+)$/);
  if (m) {
    type = m[1].trim();
    arr = m[2];
  }
  const a = type.match(/^(.*?)\s*\((\d+)(?:\s*,\s*(\d+))?\)(.*)$/);
  if (a) {
    type = (a[1] + a[4]).trim();
    length = a[2];
    precision = a[3] ?? precision;
  }
  type = ALIASES[type] ?? type;
  return { type, arr, length, precision };
}

export function isSerial(col) {
  return parseType(col).type in SERIALS;
}

// Canonical spelling of a column type, e.g. varchar(20) -> character varying(20).
export function normalizeType(col) {
  let { type, arr, length, precision } = parseType(col);
  type = SERIALS[type] ?? type;
  if (type === 'character' && (length === null || length === undefined || length === '')) length = 1;
  return formatType({ type: type + arr, length, precision });
}

// Type usable in ALTER COLUMN ... TYPE (serial pseudo-types are not).
function alterType(col) {
  const { type, arr, length, precision } = parseType(col);
  if (type in SERIALS) return SERIALS[type] + arr;
  return formatType({ type: type + arr, length, precision });
}

// Normalize a default expression for comparison: drop trailing casts, case
// and whitespace outside of string literals.
export function normalizeDefault(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  for (;;) {
    const next = s.replace(/::[a-z_][a-z0-9_ ]*(\([\d, ]+\))?(\[\])*$/i, '').trim();
    if (next === s) break;
    s = next;
  }
  while (/^\(.*\)$/.test(s) && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim();
  return s
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.toLowerCase().replace(/\s+/g, '')))
    .join('');
}

function balanced(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

// serial columns and explicit nextval() defaults are equivalent.
const sequenceDefault = (c) => isSerial(c) || /^nextval\(/i.test(String(c.default ?? ''));
const identityOf = (c) => (c.raw?.colconstype === 'i' ? c.raw.attidentity || 'd' : '');
const hasDefault = (c) => c.default !== '' && c.default !== null && c.default !== undefined;
const pkColumns = (t) => t.columns.filter((c) => c.pk).map((c) => c.name);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

function foreignKeys(model, t) {
  return foreignKeysOf(model, t)
    .map((links) => {
      const fk = foreignKeyPairs(model, t, links);
      if (!fk) return null;
      const raw = links[0].rawFk ?? {};
      return {
        links,
        name: links[0].fkName,
        ref: fk.ref,
        cols: fk.pairs.map(([a]) => a.name),
        refCols: fk.pairs.map(([, b]) => b.name),
        sig: `${tableKey(fk.ref)}(${fk.pairs.map(([, b]) => b.name).join(',')})<-(${fk.pairs.map(([a]) => a.name).join(',')})`,
        actions: `${raw.confupdtype ?? 'a'}${raw.confdeltype ?? 'a'}${raw.confmatchtype ? 'f' : 's'}`,
      };
    })
    .filter(Boolean);
}

/**
 * @param db   model built from the database catalog (with .schemas)
 * @param erd  the diagram
 * @param opts.destructive  emit DROP COLUMN (otherwise they are commented out)
 * @param opts.dropTables   emit DROP TABLE for tables missing from the diagram
 * @param opts.schemas      schemas to compare (default: the diagram's schemas)
 */
export function diffModels(db, erd, opts = {}) {
  const { destructive = false, dropTables = false } = opts;
  const schemas = new Set(opts.schemas ?? erd.tables.map((t) => t.schema || 'public'));
  const dbTables = new Map(
    db.tables.filter((t) => schemas.has(t.schema || 'public')).map((t) => [tableKey(t), t])
  );
  const erdTables = new Map(
    erd.tables.filter((t) => schemas.has(t.schema || 'public')).map((t) => [tableKey(t), t])
  );
  // Tables outside the compared schemas may still be referenced by foreign keys.
  const erdAll = new Set(erd.tables.map(tableKey));

  const phases = {
    dropFk: [], dropConstraint: [], dropColumn: [], dropTable: [], createSchema: [],
    createTable: [], column: [], addConstraint: [], addFk: [], comment: [],
  };
  const changes = [];
  const add = (phase, change) => {
    const skipped = !!change.destructive && !(change.kind === 'drop-table' ? dropTables : destructive);
    const c = { ...change, skipped };
    phases[phase].push(c);
    changes.push(c);
  };

  // Schemas.
  const dbSchemas = new Set(db.schemas ?? db.tables.map((t) => t.schema));
  for (const s of new Set([...erdTables.values()].map((t) => t.schema || 'public'))) {
    if (!dbSchemas.has(s)) {
      add('createSchema', {
        kind: 'create-schema', table: s, summary: `Create schema ${s}`,
        sql: `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`,
      });
    }
  }

  // New tables.
  for (const [key, t] of erdTables) {
    if (dbTables.has(key)) continue;
    add('createTable', {
      kind: 'create-table', table: key, summary: `Create table ${key} (${t.columns.length} columns)`,
      sql: createTableSQL(t),
    });
  }

  // Tables only in the database.
  for (const [key, t] of dbTables) {
    if (erdTables.has(key)) continue;
    add('dropTable', {
      kind: 'drop-table', table: key, summary: `Drop table ${key} (not in diagram)`,
      sql: `DROP TABLE IF EXISTS ${qualifiedName(t)};`, destructive: true,
    });
  }

  // Tables in both.
  for (const [key, e] of erdTables) {
    const d = dbTables.get(key);
    if (!d) continue;
    const tn = qualifiedName(e);
    const alter = (body) => `ALTER TABLE IF EXISTS ${tn}\n    ${body};`;
    const erdCols = new Map(e.columns.map((c) => [c.name, c]));
    const dbCols = new Map(d.columns.map((c) => [c.name, c]));
    const missingCols = new Set([...dbCols.keys()].filter((n) => !erdCols.has(n)));
    const touchesMissing = (cols) => cols.some((c) => missingCols.has(c));

    for (const c of e.columns) {
      const dc = dbCols.get(c.name);
      const col = quoteIdent(c.name);
      if (!dc) {
        const notNullNoDefault = (c.notNull || c.pk) && !hasDefault(c) && !isSerial(c) && !identityOf(c);
        add('column', {
          kind: 'add-column', table: key, summary: `Add column ${c.name} ${formatType(c)}` +
            (notNullNoDefault ? ' (NOT NULL without default: fails if the table has rows)' : ''),
          sql: alter(`ADD COLUMN ${columnDDL({ ...c, pk: false })}`),
        });
        continue;
      }
      if (normalizeType(c) !== normalizeType(dc)) {
        const t = alterType(c);
        add('column', {
          kind: 'alter-type', table: key, summary: `Change ${c.name} type ${formatType(dc)} → ${t}`,
          sql: alter(`ALTER COLUMN ${col} TYPE ${t} USING ${col}::${t}`),
        });
      }
      const ei = identityOf(c);
      const di = identityOf(dc);
      if (!ei && !di && !(sequenceDefault(c) && sequenceDefault(dc)) && c.raw?.colconstype !== 'g' && dc.raw?.colconstype !== 'g' &&
          normalizeDefault(c.default) !== normalizeDefault(dc.default)) {
        add('column', {
          kind: 'alter-default', table: key,
          summary: hasDefault(c) ? `Set default of ${c.name} to ${c.default}` : `Drop default of ${c.name}`,
          sql: alter(hasDefault(c) ? `ALTER COLUMN ${col} SET DEFAULT ${c.default}` : `ALTER COLUMN ${col} DROP DEFAULT`),
        });
      }
      if (ei !== di) {
        let sql;
        if (!ei) sql = `ALTER COLUMN ${col} DROP IDENTITY IF EXISTS`;
        else if (!di) {
          sql = `ALTER COLUMN ${col} ADD GENERATED ${ei === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
          if (hasDefault(dc)) sql = `ALTER COLUMN ${col} DROP DEFAULT,\n    ${sql}`;
        } else sql = `ALTER COLUMN ${col} SET GENERATED ${ei === 'a' ? 'ALWAYS' : 'BY DEFAULT'}`;
        add('column', { kind: 'alter-identity', table: key, summary: `Change identity of ${c.name}`, sql: alter(sql) });
      }
      const enn = !!(c.notNull || c.pk);
      const dnn = !!(dc.notNull || dc.pk);
      if (enn !== dnn) {
        add('column', {
          kind: 'alter-null', table: key, summary: `${enn ? 'Set' : 'Drop'} NOT NULL on ${c.name}`,
          sql: alter(`ALTER COLUMN ${col} ${enn ? 'SET' : 'DROP'} NOT NULL`),
        });
      }
    }

    for (const name of missingCols) {
      add('dropColumn', {
        kind: 'drop-column', table: key, summary: `Drop column ${name} (not in diagram)`,
        sql: alter(`DROP COLUMN IF EXISTS ${quoteIdent(name)}`), destructive: true,
      });
    }

    // Primary key.
    const epk = pkColumns(e);
    const dpk = pkColumns(d);
    if (!sameSet(epk, dpk)) {
      const dName = d.rawData?.primary_key?.[0]?.name;
      if (dpk.length && dName) {
        add('dropConstraint', {
          kind: 'drop-pk', table: key, columns: dpk, summary: `Drop primary key (${dpk.join(', ')})`,
          sql: alter(`DROP CONSTRAINT IF EXISTS ${quoteIdent(dName)}`), destructive: touchesMissing(dpk),
        });
      }
      if (epk.length) {
        const eName = e.rawData?.primary_key?.[0]?.name;
        add('addConstraint', {
          kind: 'add-pk', table: key, summary: `Add primary key (${epk.join(', ')})`,
          sql: alter(`ADD ${eName ? `CONSTRAINT ${quoteIdent(eName)} ` : ''}PRIMARY KEY (${epk.map(quoteIdent).join(', ')})`),
        });
      }
    }

    // Unique constraints.
    const eu = uniqueConstraints(e);
    const du = uniqueConstraints(d);
    for (const u of du) {
      if (eu.some((x) => sameSet(x.columns, u.columns)) || !u.name) continue;
      add('dropConstraint', {
        kind: 'drop-unique', table: key, columns: u.columns, summary: `Drop unique constraint ${u.name} (${u.columns.join(', ')})`,
        sql: alter(`DROP CONSTRAINT IF EXISTS ${quoteIdent(u.name)}`), destructive: touchesMissing(u.columns),
      });
    }
    for (const u of eu) {
      if (du.some((x) => sameSet(x.columns, u.columns))) continue;
      add('addConstraint', {
        kind: 'add-unique', table: key, summary: `Add unique constraint (${u.columns.join(', ')})`,
        sql: alter(`ADD ${u.name ? `CONSTRAINT ${quoteIdent(u.name)} ` : ''}UNIQUE (${u.columns.map(quoteIdent).join(', ')})`),
      });
    }

    // Foreign keys of tables in both: drop the ones the diagram no longer has.
    const efks = foreignKeys(erd, e);
    for (const fk of foreignKeys(db, d)) {
      // Leave constraints to tables outside the diagram alone.
      if (!erdAll.has(tableKey(fk.ref)) || !fk.name) continue;
      const match = efks.find((x) => x.sig === fk.sig);
      if (match && match.actions === fk.actions) continue;
      add('dropFk', {
        kind: 'drop-fk', table: key, fkSig: fk.sig,
        summary: `Drop foreign key ${fk.name} (${fk.cols.join(', ')}) → ${tableKey(fk.ref)}` + (match ? ' (actions changed)' : ''),
        sql: alter(`DROP CONSTRAINT IF EXISTS ${quoteIdent(fk.name)}`),
        destructive: !match && touchesMissing(fk.cols),
      });
    }

    if ((e.description ?? '') !== (d.description ?? '')) {
      add('comment', {
        kind: 'comment', table: key, summary: 'Change table comment',
        sql: `COMMENT ON TABLE ${tn}\n    IS ${e.description ? quoteLiteral(e.description) : 'NULL'};`,
      });
    }
  }

  // Foreign keys to add (for new and existing tables).
  for (const [key, e] of erdTables) {
    const d = dbTables.get(key);
    const dfks = d ? foreignKeys(db, d) : [];
    for (const fk of foreignKeys(erd, e)) {
      const match = dfks.find((x) => x.sig === fk.sig);
      if (match && match.actions === fk.actions) continue;
      add('addFk', {
        kind: 'add-fk', table: key, fkSig: fk.sig,
        summary: `Add foreign key (${fk.cols.join(', ')}) → ${tableKey(fk.ref)}(${fk.refCols.join(', ')})`,
        sql: addForeignKeySQL(erd, e, fk.links),
      });
    }
  }

  // Dropping a primary key or unique constraint fails while foreign keys
  // reference it: drop those first and re-create them afterwards.
  const droppedFks = new Set(phases.dropFk.filter((c) => !c.skipped).map((c) => c.fkSig));
  const refDrops = [...phases.dropConstraint]
    .filter((c) => !c.skipped && c.columns)
    .map((c) => ({ table: c.table, columns: c.columns }));
  for (const d of db.tables) {
    for (const fk of foreignKeys(db, d)) {
      if (!fk.name || droppedFks.has(fk.sig)) continue;
      const hit = refDrops.some((r) => r.table === tableKey(fk.ref) && sameSet(r.columns, fk.refCols));
      if (!hit) continue;
      const key = tableKey(d);
      droppedFks.add(fk.sig);
      add('dropFk', {
        kind: 'drop-fk', table: key, fkSig: fk.sig,
        summary: `Drop foreign key ${fk.name} → ${tableKey(fk.ref)} (re-created after key change)`,
        sql: `ALTER TABLE IF EXISTS ${qualifiedName(d)}\n    DROP CONSTRAINT IF EXISTS ${quoteIdent(fk.name)};`,
      });
      const e = erdTables.get(key);
      const kept = e && foreignKeys(erd, e).find((x) => x.sig === fk.sig);
      if (!e) {
        // Not part of the comparison: restore it exactly as it was.
        add('addFk', {
          kind: 'add-fk', table: key, summary: `Re-create foreign key ${fk.name} → ${tableKey(fk.ref)}`,
          sql: addForeignKeySQL(db, d, fk.links),
        });
      } else if (kept && !phases.addFk.some((c) => c.fkSig === fk.sig && c.table === key)) {
        add('addFk', {
          kind: 'add-fk', table: key, fkSig: fk.sig,
          summary: `Re-create foreign key (${kept.cols.join(', ')}) → ${tableKey(kept.ref)}(${kept.refCols.join(', ')})`,
          sql: addForeignKeySQL(erd, e, kept.links),
        });
      }
    }
  }

  const order = ['dropFk', 'dropConstraint', 'dropColumn', 'dropTable', 'createSchema', 'createTable', 'column', 'addConstraint', 'addFk', 'comment'];
  const ordered = order.flatMap((p) => phases[p]);
  return { changes: ordered, sql: migrationSQL(ordered) };
}

export function migrationSQL(changes) {
  const active = changes.filter((c) => !c.skipped);
  const skipped = changes.filter((c) => c.skipped);
  if (!changes.length) return '-- The database already matches the diagram.\n';
  const out = ['-- Migration generated by pgsql-erd', 'BEGIN;', ''];
  for (const c of active) out.push(`-- ${c.summary}`, c.sql, '');
  out.push('COMMIT;');
  if (skipped.length) {
    out.push('', '-- Skipped destructive changes (enable them to include):');
    for (const c of skipped) out.push(...c.sql.split('\n').map((l) => `-- ${l}`));
  }
  return out.join('\n') + '\n';
}
