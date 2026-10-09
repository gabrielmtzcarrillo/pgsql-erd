// Compare a database schema with the diagram and generate the SQL that makes
// the database match the diagram. Both sides use the internal ERD model
// (the database side comes from catalog.js).

import { foreignKeysOf } from './pgerd.js';
import {
  quoteIdent, quoteLiteral, qualifiedName, formatType, columnDDL, createTableSQL,
  addForeignKeySQL, foreignKeyPairs, uniqueConstraints, defaultExpr,
} from './sql.js';
import { tableKey } from './catalog.js';
import { usesPgvector, CREATE_VECTOR_EXTENSION, VECTOR_EXTENSION } from '../../shared/pgvector.js';
import { tr, trn } from '../../shared/i18n.js';

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
  // character and bit without a length mean length 1 in PostgreSQL.
  if ((type === 'character' || type === 'bit') && (length === null || length === undefined || length === '')) length = 1;
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
    const next = s.replace(/::(?:[a-z_][a-z0-9_ ]*|"[^"]+")(\([\d, ]+\))?(\[\])*$/i, '').trim();
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

// Type families whose members a foreign key can mix: PostgreSQL needs the key
// column's type to compare with the referenced one, directly or through an
// implicit cast (integer -> bigint or numeric, varchar -> text, ...).
const FK_FAMILY = {
  smallint: 'int', integer: 'int', bigint: 'int',
  numeric: 'num', real: 'num', 'double precision': 'num',
  text: 'str', 'character varying': 'str', character: 'str', name: 'str',
};

export function fkTypesCompatible(local, ref) {
  const a = parseType(local);
  const b = parseType(ref);
  if (a.arr !== b.arr) return false;
  const ta = SERIALS[a.type] ?? a.type;
  const tb = SERIALS[b.type] ?? b.type;
  if (ta === tb) return true;
  const fa = FK_FAMILY[ta];
  const fb = FK_FAMILY[tb];
  return !!fa && (fa === fb || (fa === 'int' && fb === 'num'));
}

// Warning for a foreign key whose column types PostgreSQL cannot compare.
function fkTypeWarning(fk) {
  const bad = fk.pairs.filter(([a, b]) => !fkTypesCompatible(a, b));
  if (!bad.length) return '';
  const list = bad.map(([a, b]) => `${a.name} ${formatType(a)} → ${b.name} ${formatType(b)}`).join(', ');
  return ` ${tr('(incompatible column types: {list}; the database rejects it)', { list })}`;
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
        pairs: fk.pairs,
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

// Columns renamed in the diagram (c.renamedFrom) whose old name the database
// still has and whose new name it does not. A name the diagram uses again for
// another column is left alone (swaps fall back to drop and add).
function findRenames(db, erdTables) {
  const out = [];
  for (const t of db.tables) {
    const key = tableKey(t);
    const e = erdTables.get(key);
    if (!e) continue;
    const dbNames = new Set(t.columns.map((c) => c.name));
    const erdNames = new Set(e.columns.map((c) => c.name));
    const taken = new Set();
    for (const c of e.columns) {
      const from = c.renamedFrom;
      if (!from || from === c.name || !dbNames.has(from) || dbNames.has(c.name) || erdNames.has(from) || taken.has(from)) continue;
      taken.add(from);
      out.push({ key, table: t, from, to: c.name });
    }
  }
  return out;
}

// A copy of the database model with the renamed columns under their new names.
function applyRenames(db, renames) {
  const copy = { ...db, tables: db.tables.map((t) => ({ ...t })) };
  for (const t of copy.tables) {
    const map = new Map(renames.filter((r) => r.key === tableKey(t)).map((r) => [r.from, r.to]));
    if (!map.size) continue;
    t.columns = t.columns.map((c) => (map.has(c.name) ? { ...c, name: map.get(c.name) } : c));
    if (t.rawData) {
      const rename = (list) => (list ?? []).map((con) => ({
        ...con,
        columns: (con.columns ?? []).map((c) => (map.has(c.column) ? { ...c, column: map.get(c.column) } : c)),
      }));
      t.rawData = { ...t.rawData, primary_key: rename(t.rawData.primary_key), unique_constraint: rename(t.rawData.unique_constraint) };
    }
  }
  return copy;
}

/**
 * @param db   model built from the database catalog (with .schemas)
 * @param erd  the diagram
 * @param opts.destructive  emit DROP COLUMN (otherwise they are marked skipped)
 * @param opts.dropTables   emit DROP TABLE for tables missing from the diagram
 * @param opts.schemas      schemas to compare (default: the diagram's schemas)
 * @param opts.recreateColumns  change a column's type by dropping it and
 *                          adding it again (deletes its data) instead of
 *                          ALTER COLUMN ... TYPE ... USING a cast; keys on
 *                          the column are re-created
 * db.extensions (names of installed extensions) decides whether pgvector
 * has to be created for vector columns; without it, pgvector counts as
 * installed when a database table already has a vector column.
 */
export function diffModels(db, erd, opts = {}) {
  const { destructive = false, dropTables = false, recreateColumns = false } = opts;
  const schemas = new Set(opts.schemas ?? erd.tables.map((t) => t.schema || 'public'));
  const erdTables = new Map(
    erd.tables.filter((t) => schemas.has(t.schema || 'public')).map((t) => [tableKey(t), t])
  );
  const renames = findRenames(db, erdTables);
  // Compare with the database as it is once the renames have run.
  if (renames.length) db = applyRenames(db, renames);
  const dbTables = new Map(
    db.tables.filter((t) => schemas.has(t.schema || 'public')).map((t) => [tableKey(t), t])
  );
  // Tables outside the compared schemas may still be referenced by foreign keys.
  const erdAll = new Set(erd.tables.map(tableKey));

  const phases = {
    rename: [], dropFk: [], dropConstraint: [], dropColumn: [], dropTable: [], createSchema: [], createExtension: [],
    createTable: [], column: [], addConstraint: [], addFk: [], comment: [],
  };
  const changes = [];
  const recreated = new Map(); // table key -> names of columns dropped and added again
  const add = (phase, change) => {
    const allowed = { 'drop-table': dropTables, 'recreate-column': recreateColumns }[change.kind] ?? destructive;
    const skipped = !!change.destructive && !allowed;
    const c = { ...change, skipped };
    phases[phase].push(c);
    changes.push(c);
  };

  // Columns renamed in the diagram, before anything refers to the new names.
  for (const r of renames) {
    add('rename', {
      kind: 'rename-column', table: r.key, summary: tr('Rename column {from} to {to}', { from: r.from, to: r.to }),
      sql: `ALTER TABLE IF EXISTS ${qualifiedName(r.table)}\n    RENAME COLUMN ${quoteIdent(r.from)} TO ${quoteIdent(r.to)};`,
    });
  }

  // Schemas.
  const dbSchemas = new Set(db.schemas ?? db.tables.map((t) => t.schema));
  for (const s of new Set([...erdTables.values()].map((t) => t.schema || 'public'))) {
    if (!dbSchemas.has(s)) {
      add('createSchema', {
        kind: 'create-schema', table: s, summary: tr('Create schema {name}', { name: s }),
        sql: `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`,
      });
    }
  }

  // pgvector, before any table or column uses its types.
  const hasPgvector = db.extensions ? db.extensions.includes(VECTOR_EXTENSION) : usesPgvector(db.tables);
  if (!hasPgvector && usesPgvector([...erdTables.values()])) {
    add('createExtension', {
      kind: 'create-extension', table: 'extensions', summary: tr('Create extension vector (pgvector)'),
      sql: CREATE_VECTOR_EXTENSION,
    });
  }

  // New tables.
  for (const [key, t] of erdTables) {
    if (dbTables.has(key)) continue;
    add('createTable', {
      kind: 'create-table', table: key, summary: `${tr('Create table {name}', { name: key })} (${trn(t.columns.length, '{n} column', '{n} columns')})`,
      sql: createTableSQL(t),
    });
  }

  // Tables only in the database.
  for (const [key, t] of dbTables) {
    if (erdTables.has(key)) continue;
    add('dropTable', {
      kind: 'drop-table', table: key, summary: tr('Drop table {name} (not in diagram)', { name: key }),
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
    const remade = new Set(
      recreateColumns ? e.columns.filter((c) => dbCols.has(c.name) && normalizeType(c) !== normalizeType(dbCols.get(c.name))).map((c) => c.name) : []
    );
    recreated.set(key, remade);
    const touchesRemade = (cols) => cols.some((c) => remade.has(c));

    for (const c of e.columns) {
      const dc = dbCols.get(c.name);
      const col = quoteIdent(c.name);
      const notNullNoDefault = (c.notNull || c.pk) && !hasDefault(c) && !isSerial(c) && !identityOf(c);
      const rowsWarning = notNullNoDefault ? ` ${tr('(NOT NULL without default: fails if the table has rows)')}` : '';
      if (remade.has(c.name)) {
        // One statement, so the column is never left dropped. Its keys are
        // dropped before and re-created after (see below).
        add('column', {
          kind: 'recreate-column', table: key, destructive: true,
          summary: tr('Drop and re-create {name} as {to} (deletes its data)', { name: c.name, to: formatType(c) }) + rowsWarning,
          sql: alter(`DROP COLUMN IF EXISTS ${col},\n    ADD COLUMN ${columnDDL({ ...c, pk: false })}`),
        });
        continue;
      }
      if (!dc) {
        add('column', {
          kind: 'add-column', table: key, summary: tr('Add column {name}', { name: `${c.name} ${formatType(c)}` }) + rowsWarning,
          sql: alter(`ADD COLUMN ${columnDDL({ ...c, pk: false })}`),
        });
        continue;
      }
      if (normalizeType(c) !== normalizeType(dc)) {
        const t = alterType(c);
        add('column', {
          kind: 'alter-type', table: key, summary: tr('Change {name} type {from} → {to}', { name: c.name, from: formatType(dc), to: t }),
          sql: alter(`ALTER COLUMN ${col} TYPE ${t} USING ${col}::${t}`),
        });
      }
      const ei = identityOf(c);
      const di = identityOf(dc);
      if (!ei && !di && !(sequenceDefault(c) && sequenceDefault(dc)) && c.raw?.colconstype !== 'g' && dc.raw?.colconstype !== 'g' &&
          normalizeDefault(defaultExpr(c)) !== normalizeDefault(dc.default)) {
        add('column', {
          kind: 'alter-default', table: key,
          summary: hasDefault(c) ? tr('Set default of {name} to {value}', { name: c.name, value: c.default }) : tr('Drop default of {name}', { name: c.name }),
          sql: alter(hasDefault(c) ? `ALTER COLUMN ${col} SET DEFAULT ${defaultExpr(c)}` : `ALTER COLUMN ${col} DROP DEFAULT`),
        });
      }
      if (ei !== di) {
        let sql;
        if (!ei) sql = `ALTER COLUMN ${col} DROP IDENTITY IF EXISTS`;
        else if (!di) {
          sql = `ALTER COLUMN ${col} ADD GENERATED ${ei === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
          if (hasDefault(dc)) sql = `ALTER COLUMN ${col} DROP DEFAULT,\n    ${sql}`;
        } else sql = `ALTER COLUMN ${col} SET GENERATED ${ei === 'a' ? 'ALWAYS' : 'BY DEFAULT'}`;
        add('column', { kind: 'alter-identity', table: key, summary: tr('Change identity of {name}', { name: c.name }), sql: alter(sql) });
      }
      const enn = !!(c.notNull || c.pk);
      const dnn = !!(dc.notNull || dc.pk);
      if (enn !== dnn) {
        add('column', {
          kind: 'alter-null', table: key, summary: enn ? tr('Set NOT NULL on {name}', { name: c.name }) : tr('Drop NOT NULL on {name}', { name: c.name }),
          sql: alter(`ALTER COLUMN ${col} ${enn ? 'SET' : 'DROP'} NOT NULL`),
        });
      }
    }

    for (const name of missingCols) {
      add('dropColumn', {
        kind: 'drop-column', table: key, summary: tr('Drop column {name} (not in diagram)', { name }),
        sql: alter(`DROP COLUMN IF EXISTS ${quoteIdent(name)}`), destructive: true,
      });
    }

    // Primary key.
    const epk = pkColumns(e);
    const dpk = pkColumns(d);
    if (!sameSet(epk, dpk) || touchesRemade(dpk)) {
      const dName = d.rawData?.primary_key?.[0]?.name;
      if (dpk.length && dName) {
        add('dropConstraint', {
          kind: 'drop-pk', table: key, columns: dpk, summary: tr('Drop primary key ({columns})', { columns: dpk.join(', ') }),
          sql: alter(`DROP CONSTRAINT IF EXISTS ${quoteIdent(dName)}`),
          // A table has one primary key: the new one needs the old one gone,
          // even when its column is kept (e.g. a renamed key column).
          destructive: touchesMissing(dpk) && !epk.length,
        });
      }
      if (epk.length) {
        const eName = e.rawData?.primary_key?.[0]?.name;
        add('addConstraint', {
          kind: 'add-pk', table: key, summary: tr('Add primary key ({columns})', { columns: epk.join(', ') }),
          sql: alter(`ADD ${eName ? `CONSTRAINT ${quoteIdent(eName)} ` : ''}PRIMARY KEY (${epk.map(quoteIdent).join(', ')})`),
        });
      }
    }

    // Unique constraints.
    const eu = uniqueConstraints(e);
    const du = uniqueConstraints(d);
    for (const u of du) {
      if ((eu.some((x) => sameSet(x.columns, u.columns)) && !touchesRemade(u.columns)) || !u.name) continue;
      add('dropConstraint', {
        kind: 'drop-unique', table: key, columns: u.columns, summary: tr('Drop unique constraint {name} ({columns})', { name: u.name, columns: u.columns.join(', ') }),
        sql: alter(`DROP CONSTRAINT IF EXISTS ${quoteIdent(u.name)}`), destructive: touchesMissing(u.columns),
      });
    }
    for (const u of eu) {
      if (du.some((x) => sameSet(x.columns, u.columns)) && !touchesRemade(u.columns)) continue;
      add('addConstraint', {
        kind: 'add-unique', table: key, summary: tr('Add unique constraint ({columns})', { columns: u.columns.join(', ') }),
        sql: alter(`ADD ${u.name ? `CONSTRAINT ${quoteIdent(u.name)} ` : ''}UNIQUE (${u.columns.map(quoteIdent).join(', ')})`),
      });
    }

    // Foreign keys of tables in both: drop the ones the diagram no longer has.
    // A database may hold several copies of one foreign key (unnamed ADD
    // FOREIGN KEY run more than once): keep the one named as in the diagram,
    // or the first, and drop the rest.
    const efks = foreignKeys(erd, e);
    const dfks = foreignKeys(db, d);
    const keeper = new Map(); // sig -> name of the copy kept
    for (const fk of dfks) {
      const match = efks.find((x) => x.sig === fk.sig);
      if (!match || match.actions !== fk.actions || !fk.name || touchesRemade(fk.cols)) continue;
      if (!keeper.has(fk.sig) || fk.name === match.name) keeper.set(fk.sig, fk.name);
    }
    for (const fk of dfks) {
      // Leave constraints to tables outside the diagram alone.
      if (!erdAll.has(tableKey(fk.ref)) || !fk.name) continue;
      const match = efks.find((x) => x.sig === fk.sig);
      if (keeper.get(fk.sig) === fk.name) continue;
      if (keeper.has(fk.sig)) {
        add('dropFk', {
          kind: 'drop-fk', table: key, fkName: fk.name,
          summary: `${tr('Drop foreign key {name}', { name: `${fk.name} (${fk.cols.join(', ')}) → ${tableKey(fk.ref)}` })} ${tr('(duplicate of {name})', { name: keeper.get(fk.sig) })}`,
          sql: alter(`DROP CONSTRAINT IF EXISTS ${quoteIdent(fk.name)}`),
        });
        continue;
      }
      add('dropFk', {
        kind: 'drop-fk', table: key, fkSig: fk.sig, fkName: fk.name,
        summary: tr('Drop foreign key {name}', { name: `${fk.name} (${fk.cols.join(', ')}) → ${tableKey(fk.ref)}` }) +
          (match && touchesRemade(fk.cols) ? ` ${tr('(re-created with the column)')}` : match ? ` ${tr('(actions changed)')}` : ''),
        sql: alter(`DROP CONSTRAINT IF EXISTS ${quoteIdent(fk.name)}`),
        destructive: !match && touchesMissing(fk.cols),
      });
    }

    if ((e.description ?? '') !== (d.description ?? '')) {
      add('comment', {
        kind: 'comment', table: key, summary: tr('Change table comment'),
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
      if (match && match.actions === fk.actions && !fk.cols.some((c) => recreated.get(key)?.has(c))) continue;
      add('addFk', {
        kind: 'add-fk', table: key, fkSig: fk.sig,
        summary: tr('Add foreign key {name}', { name: `(${fk.cols.join(', ')}) → ${tableKey(fk.ref)}(${fk.refCols.join(', ')})` }) + fkTypeWarning(fk),
        sql: addForeignKeySQL(erd, e, fk.links),
      });
    }
  }

  // Dropping a primary key or unique constraint, or a column re-created with
  // a new type, fails while foreign keys reference it: drop those first and
  // re-create them afterwards.
  const fkKey = (table, name) => `${table}\0${name}`;
  const droppedFks = new Set(phases.dropFk.filter((c) => !c.skipped).map((c) => fkKey(c.table, c.fkName)));
  const refDrops = [...phases.dropConstraint]
    .filter((c) => !c.skipped && c.columns)
    .map((c) => ({ table: c.table, columns: c.columns }));
  for (const d of db.tables) {
    for (const fk of foreignKeys(db, d)) {
      const key = tableKey(d);
      if (!fk.name || droppedFks.has(fkKey(key, fk.name))) continue;
      const hit = refDrops.some((r) => r.table === tableKey(fk.ref) && sameSet(r.columns, fk.refCols)) ||
        fk.refCols.some((c) => recreated.get(tableKey(fk.ref))?.has(c));
      if (!hit) continue;
      droppedFks.add(fkKey(key, fk.name));
      add('dropFk', {
        kind: 'drop-fk', table: key, fkSig: fk.sig, fkName: fk.name,
        summary: `${tr('Drop foreign key {name}', { name: `${fk.name} → ${tableKey(fk.ref)}` })} ${tr('(re-created after key change)')}`,
        sql: `ALTER TABLE IF EXISTS ${qualifiedName(d)}\n    DROP CONSTRAINT IF EXISTS ${quoteIdent(fk.name)};`,
      });
      const e = erdTables.get(key);
      const kept = e && foreignKeys(erd, e).find((x) => x.sig === fk.sig);
      if (!e) {
        // Not part of the comparison: restore it exactly as it was.
        add('addFk', {
          kind: 'add-fk', table: key, summary: tr('Re-create foreign key {name}', { name: `${fk.name} → ${tableKey(fk.ref)}` }),
          sql: addForeignKeySQL(db, d, fk.links),
        });
      } else if (kept && !phases.addFk.some((c) => c.fkSig === fk.sig && c.table === key)) {
        add('addFk', {
          kind: 'add-fk', table: key, fkSig: fk.sig,
          summary: tr('Re-create foreign key {name}', { name: `(${kept.cols.join(', ')}) → ${tableKey(kept.ref)}(${kept.refCols.join(', ')})` }) + fkTypeWarning(kept),
          sql: addForeignKeySQL(erd, e, kept.links),
        });
      }
    }
  }

  const order = ['rename', 'dropFk', 'dropConstraint', 'dropColumn', 'dropTable', 'createSchema', 'createExtension', 'createTable', 'column', 'addConstraint', 'addFk', 'comment'];
  const ordered = order.flatMap((p) => phases[p]);
  return { changes: ordered, sql: migrationSQL(ordered) };
}

// SQL for the changes that are not skipped; skipped ones are left out.
export function migrationSQL(changes) {
  const active = changes.filter((c) => !c.skipped);
  if (!changes.length) return `-- ${tr('The database already matches the diagram.')}\n`;
  if (!active.length) return `-- ${tr('No changes to apply.')}\n`;
  const out = [`-- ${tr('Migration generated by pgsql-erd')}`, 'BEGIN;', ''];
  for (const c of active) out.push(`-- ${c.summary}`, c.sql, '');
  out.push('COMMIT;');
  return out.join('\n') + '\n';
}
