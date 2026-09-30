// Pull tables from a database model (catalog.js) into the diagram.

import { nextAttnum, uuid } from './pgerd.js';
import { tableKey } from './catalog.js';

/**
 * Add or update the tables named by `keys` ("schema.table") in `erd` from `db`.
 * Existing tables keep their id, position, color and note; their columns,
 * keys and comment are replaced by the database definition. Relationships
 * between tables in the diagram are brought in line with the database.
 * Returns { added: [tableId], updated: [tableId] }.
 */
export function mergeFromDb(erd, db, keys) {
  const erdByKey = new Map(erd.tables.map((t) => [tableKey(t), t]));
  const dbByKey = new Map(db.tables.map((t) => [tableKey(t), t]));
  const added = [];
  const updated = [];
  const synced = new Set();

  for (const key of keys) {
    const d = dbByKey.get(key);
    if (!d) continue;
    const e = erdByKey.get(key);
    if (!e) {
      const t = structuredClone(d);
      t.id = uuid();
      erd.tables.push(t);
      erdByKey.set(key, t);
      added.push(t.id);
      synced.add(key);
      continue;
    }
    const old = new Map(e.columns.map((c) => [c.name, c]));
    let next = nextAttnum(e);
    e.columns = d.columns.map((dc) => {
      const prev = old.get(dc.name);
      return {
        ...structuredClone(dc),
        attnum: prev ? prev.attnum : next++,
        raw: { ...(prev?.raw ?? {}), ...dc.raw },
      };
    });
    const kept = new Set(e.columns.map((c) => c.attnum));
    erd.links = erd.links.filter(
      (l) => !(l.localTable === e.id && !kept.has(l.localCol)) && !(l.refTable === e.id && !kept.has(l.refCol))
    );
    e.description = d.description;
    e.rawData = {
      ...(e.rawData ?? {}),
      primary_key: structuredClone(d.rawData.primary_key),
      unique_constraint: structuredClone(d.rawData.unique_constraint),
    };
    updated.push(e.id);
    synced.add(key);
  }

  // Relationships: DB foreign keys between tables that are in the diagram,
  // where at least one side was just synced.
  const dbById = new Map(db.tables.map((t) => [t.id, t]));
  const erdAttnum = (dbTable, dbAttnum) => {
    const name = dbTable.columns.find((c) => c.attnum === dbAttnum)?.name;
    return erdByKey.get(tableKey(dbTable))?.columns.find((c) => c.name === name)?.attnum;
  };
  const sig = (l) => `${l.localTable}:${l.localCol}->${l.refTable}:${l.refCol}`;
  const wanted = [];
  const groups = new Map();
  for (const l of db.links) {
    const dl = dbById.get(l.localTable);
    const dr = dbById.get(l.refTable);
    const el = erdByKey.get(tableKey(dl));
    const er = erdByKey.get(tableKey(dr));
    if (!el || !er || !(synced.has(tableKey(dl)) || synced.has(tableKey(dr)))) continue;
    const localCol = erdAttnum(dl, l.localCol);
    const refCol = erdAttnum(dr, l.refCol);
    if (localCol === undefined || refCol === undefined) continue;
    if (!groups.has(l.group)) groups.set(l.group, uuid());
    wanted.push({
      ...structuredClone(l),
      id: uuid(),
      group: groups.get(l.group),
      localTable: el.id,
      localCol,
      refTable: er.id,
      refCol,
    });
  }

  // For synced tables, drop outgoing relationships to database tables that
  // the database no longer has.
  const wantedSigs = new Set(wanted.map(sig));
  const erdIdsInDb = new Set([...erdByKey].filter(([k]) => dbByKey.has(k)).map(([, t]) => t.id));
  const syncedIds = new Set([...synced].map((k) => erdByKey.get(k).id));
  erd.links = erd.links.filter(
    (l) => !(syncedIds.has(l.localTable) && erdIdsInDb.has(l.refTable)) || wantedSigs.has(sig(l))
  );
  const have = new Set(erd.links.map(sig));
  for (const l of wanted) if (!have.has(sig(l))) erd.links.push(l);

  return { added, updated };
}
