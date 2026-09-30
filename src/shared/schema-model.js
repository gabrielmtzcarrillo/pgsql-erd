// Canonical database schema model shared by the scripting runtime, the
// TypeScript generator and the AI context builder. It can be built from the
// live database (catalog rows from src/main/db.cjs introspect()) or from the
// diagram, so scripts and the assistant also work without a connection.
//
// DatabaseSchema = {
//   source: 'database' | 'diagram',
//   schemas: [{ name, tables: DbTable[] }],
//   enums: [{ schema, name, values }],
// }
// DbTable = {
//   id: 'schema.name',   stable identifier used everywhere
//   schema, name, comment,
//   columns: [{ name, databaseType, baseType, isArray, nullable, defaultValue,
//               identity: 'a' | 'd' | null, generated: boolean, serial: boolean, comment }],
//   primaryKey: { name, columns } | null,
//   uniques: [{ name, columns }],
//   foreignKeys: [{ name, columns, refTable: 'schema.name', refColumns, onUpdate, onDelete }],
//   indexes: [{ name, columns, unique, definition }],
//   checks: [{ name, expression }],
// }

import { formatType } from '../renderer/lib/sql.js';

const FK_ACTION = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const SERIAL_BASE = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' };

export const tableId = (schema, name) => `${schema || 'public'}.${name}`;

// "character varying(20)[]" -> { baseType: 'character varying', isArray: true }
export function parseDatabaseType(type) {
  let t = String(type ?? '').trim();
  const isArray = /\[\]$/.test(t);
  t = t.replace(/(\[\])+$/, '');
  t = t.replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/, '').replace(/\s+/g, ' ').trim();
  return { baseType: t.toLowerCase(), isArray };
}

function column(props) {
  const { baseType, isArray } = parseDatabaseType(props.databaseType);
  return {
    name: props.name,
    databaseType: props.databaseType,
    baseType,
    isArray,
    nullable: !!props.nullable,
    defaultValue: props.defaultValue || null,
    identity: props.identity || null,
    generated: !!props.generated,
    serial: !!props.serial,
    comment: props.comment || '',
  };
}

function finish(tables, enums, source) {
  const bySchema = new Map();
  for (const t of tables) {
    if (!bySchema.has(t.schema)) bySchema.set(t.schema, []);
    bySchema.get(t.schema).push(t);
  }
  const schemas = [...bySchema.keys()].sort().map((name) => ({
    name,
    tables: bySchema.get(name).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  return { source, schemas, enums };
}

// catalog: output of db.cjs introspect(). The index, check and enum lists are
// optional so older callers and fixtures still work.
export function schemaFromCatalog(catalog) {
  const byOid = new Map();
  const tables = [];
  for (const r of catalog.tables) {
    const t = {
      id: tableId(r.schema, r.name),
      schema: r.schema,
      name: r.name,
      comment: r.description ?? '',
      columns: [],
      primaryKey: null,
      uniques: [],
      foreignKeys: [],
      indexes: [],
      checks: [],
      attnums: new Map(),
    };
    byOid.set(String(r.oid), t);
    tables.push(t);
  }
  for (const r of catalog.columns) {
    const t = byOid.get(String(r.oid));
    if (!t) continue;
    const c = column({
      name: r.name,
      databaseType: r.type,
      nullable: !r.notnull,
      defaultValue: r.generated ? null : r.default,
      identity: r.identity,
      generated: !!r.generated,
      serial: !!r.serial,
      comment: r.description,
    });
    t.columns.push(c);
    t.attnums.set(Number(r.attnum), c.name);
  }
  const names = (t, attnums) => (attnums ?? []).map((a) => t.attnums.get(Number(a)));
  for (const r of catalog.constraints) {
    const t = byOid.get(String(r.oid));
    if (!t) continue;
    if (r.type === 'p') t.primaryKey = { name: r.name, columns: names(t, r.cols) };
    else if (r.type === 'u') t.uniques.push({ name: r.name, columns: names(t, r.cols) });
    else if (r.type === 'f') {
      const ref = byOid.get(String(r.ref_oid));
      if (!ref) continue;
      t.foreignKeys.push({
        name: r.name,
        columns: names(t, r.cols),
        refTable: ref.id,
        refColumns: names(ref, r.ref_cols),
        onUpdate: FK_ACTION[r.confupdtype] ?? 'NO ACTION',
        onDelete: FK_ACTION[r.confdeltype] ?? 'NO ACTION',
      });
    }
  }
  for (const r of catalog.checks ?? []) {
    const t = byOid.get(String(r.oid));
    if (t) t.checks.push({ name: r.name, expression: r.definition });
  }
  for (const r of catalog.indexes ?? []) {
    const t = byOid.get(String(r.oid));
    if (t) t.indexes.push({ name: r.name, columns: names(t, r.cols).filter(Boolean), unique: !!r.unique, definition: r.definition });
  }
  for (const t of tables) delete t.attnums;
  const enums = (catalog.enums ?? []).map((e) => ({ schema: e.schema, name: e.name, values: [...(e.values ?? [])] }));
  return finish(tables, enums, 'database');
}

// Build the same model from the diagram (src/renderer/lib/pgerd.js model).
export function schemaFromErd(model) {
  const byId = new Map(model.tables.map((t) => [t.id, t]));
  const tables = model.tables.map((t) => {
    const schema = t.schema || 'public';
    const pkCols = t.columns.filter((c) => c.pk).map((c) => c.name);
    const rawUniques = t.rawData?.unique_constraint ?? [];
    const out = {
      id: tableId(schema, t.name),
      schema,
      name: t.name,
      comment: t.description ?? '',
      columns: t.columns.map((c) => {
        const type = formatType(c);
        const serial = !!SERIAL_BASE[String(c.type).toLowerCase()];
        const kind = c.raw?.colconstype;
        return column({
          name: c.name,
          databaseType: serial ? SERIAL_BASE[String(c.type).toLowerCase()] : type,
          nullable: !c.notNull && !c.pk,
          defaultValue: kind === 'g' ? null : c.default,
          identity: kind === 'i' ? c.raw?.attidentity || 'a' : null,
          generated: kind === 'g',
          serial,
          comment: c.description,
        });
      }),
      primaryKey: pkCols.length ? { name: t.rawData?.primary_key?.[0]?.name ?? `${t.name}_pkey`, columns: pkCols } : null,
      uniques: rawUniques.map((u) => ({ name: u.name ?? '', columns: (u.columns ?? []).map((c) => c.column) })),
      foreignKeys: [],
      indexes: [],
      checks: (t.rawData?.check_constraint ?? []).map((c) => ({ name: c.name ?? '', expression: c.consrc ?? '' })),
    };
    return out;
  });
  const out = new Map(model.tables.map((t, i) => [t.id, tables[i]]));
  const groups = new Map();
  for (const l of model.links) {
    const key = l.group ?? l.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  for (const links of groups.values()) {
    const l0 = links[0];
    const local = byId.get(l0.localTable);
    const ref = byId.get(l0.refTable);
    if (!local || !ref) continue;
    const colName = (t, attnum) => t.columns.find((c) => c.attnum === attnum)?.name;
    out.get(local.id).foreignKeys.push({
      name: l0.fkName || `${local.name}_${colName(local, l0.localCol)}_fkey`,
      columns: links.map((l) => colName(local, l.localCol)),
      refTable: out.get(ref.id).id,
      refColumns: links.map((l) => colName(ref, l.refCol)),
      onUpdate: FK_ACTION[l0.rawFk?.confupdtype] ?? 'NO ACTION',
      onDelete: FK_ACTION[l0.rawFk?.confdeltype] ?? 'NO ACTION',
    });
  }
  return finish(tables, [], 'diagram');
}

export const allTables = (schema) => schema.schemas.flatMap((s) => s.tables);

// Resolve "schema.table", or an unqualified name (public first, then any
// schema where it is unique). Matching is exact, then case-insensitive.
export function findTable(schema, name) {
  const tables = allTables(schema);
  const n = String(name ?? '').trim().replace(/"/g, '');
  const exact = tables.find((t) => t.id === n) ?? tables.find((t) => t.id === `public.${n}`);
  if (exact) return exact;
  const lower = n.toLowerCase();
  const ci = tables.filter((t) => t.id.toLowerCase() === lower || t.id.toLowerCase() === `public.${lower}`);
  if (ci.length === 1) return ci[0];
  const byName = tables.filter((t) => t.name === n);
  if (byName.length === 1) return byName[0];
  const byNameCi = tables.filter((t) => t.name.toLowerCase() === lower);
  return byNameCi.length === 1 ? byNameCi[0] : null;
}

// Relationships of a table in both directions.
export function relationshipsOf(schema, id) {
  const out = [];
  for (const t of allTables(schema)) {
    for (const fk of t.foreignKeys) {
      if (t.id === id) out.push({ direction: 'references', from: t.id, to: fk.refTable, ...fk });
      else if (fk.refTable === id) out.push({ direction: 'referenced-by', from: t.id, to: fk.refTable, ...fk });
    }
  }
  return out;
}

// Order tables so that referenced tables come before the tables that point
// at them (insert order). Self references are ignored; cycles are broken by
// keeping the remaining tables in their original order.
export function dependencyOrder(schema, ids = null) {
  const wanted = ids ? ids.map((id) => findTable(schema, id)?.id).filter(Boolean) : allTables(schema).map((t) => t.id);
  const set = new Set(wanted);
  const deps = new Map(wanted.map((id) => [id, new Set()]));
  for (const id of wanted) {
    const t = findTable(schema, id);
    for (const fk of t.foreignKeys) if (fk.refTable !== id && set.has(fk.refTable)) deps.get(id).add(fk.refTable);
  }
  const order = [];
  const done = new Set();
  while (order.length < wanted.length) {
    const ready = wanted.filter((id) => !done.has(id) && [...deps.get(id)].every((d) => done.has(d)));
    const next = ready.length ? ready : [wanted.find((id) => !done.has(id))];
    for (const id of next) {
      done.add(id);
      order.push(id);
    }
  }
  return order;
}

// The tables a column set is "about": a table plus its direct neighbours.
export function neighbourhood(schema, ids) {
  const out = new Set();
  for (const id of ids) {
    const t = findTable(schema, id);
    if (!t) continue;
    out.add(t.id);
    for (const r of relationshipsOf(schema, t.id)) out.add(r.direction === 'references' ? r.to : r.from);
  }
  return [...out];
}

// Human-readable change list between two schema models (e.g. the cached
// database schema and a fresh read), used to tell the user what a refresh
// changed. Not used to generate DDL; see src/renderer/lib/diff.js for that.
export function summarizeSchemaChanges(before, after) {
  const changes = [];
  const a = new Map(allTables(before).map((t) => [t.id, t]));
  const b = new Map(allTables(after).map((t) => [t.id, t]));
  for (const [id, t] of b) {
    const old = a.get(id);
    if (!old) {
      changes.push(`+ ${id}`);
      continue;
    }
    const oc = new Map(old.columns.map((c) => [c.name, c]));
    for (const c of t.columns) {
      const o = oc.get(c.name);
      if (!o) changes.push(`+ ${id}.${c.name} ${c.databaseType}${c.nullable ? '' : ' NOT NULL'}`);
      else if (o.databaseType !== c.databaseType || o.nullable !== c.nullable)
        changes.push(`~ ${id}.${c.name} ${o.databaseType}${o.nullable ? '' : ' NOT NULL'} → ${c.databaseType}${c.nullable ? '' : ' NOT NULL'}`);
      oc.delete(c.name);
    }
    for (const name of oc.keys()) changes.push(`- ${id}.${name}`);
  }
  for (const id of a.keys()) if (!b.has(id)) changes.push(`- ${id}`);
  return changes;
}
