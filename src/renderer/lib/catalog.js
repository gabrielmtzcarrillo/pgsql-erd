// Build an ERD model from PostgreSQL catalog rows (see src/main/db.cjs for
// the queries). Pure module so it can be tested without a database.

import { emptyModel, newTable, newColumn, uuid } from './pgerd.js';

// "character varying(255)" -> { type: 'character varying', length: 255 }
// "timestamp(3) with time zone" -> { type: 'timestamp with time zone', length: 3 }
// "numeric(10,2)[]" -> { type: 'numeric[]', length: 10, precision: 2 }
export function splitType(formatted) {
  const m = String(formatted).match(/^(.*?)\((\d+)(?:,(\d+))?\)(.*)$/);
  if (!m) return { type: formatted, length: null, precision: null };
  return {
    type: (m[1] + m[4]).trim(),
    length: Number(m[2]),
    precision: m[3] === undefined ? null : Number(m[3]),
  };
}

const SERIAL_OF = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' };

export const tableKey = (t) => `${t.schema || 'public'}.${t.name}`;

// catalog: { tables, columns, constraints } rows as returned by db.cjs introspect().
export function modelFromCatalog(catalog) {
  const model = emptyModel();
  const byOid = new Map();

  for (const r of catalog.tables) {
    const t = newTable({
      id: uuid(),
      name: r.name,
      schema: r.schema,
      description: r.description ?? '',
      rawData: { name: r.name, schema: r.schema, primary_key: [], unique_constraint: [] },
    });
    t.oid = r.oid;
    byOid.set(String(r.oid), t);
    model.tables.push(t);
  }

  for (const r of catalog.columns) {
    const t = byOid.get(String(r.oid));
    if (!t) continue;
    let { type, length, precision } = splitType(r.type);
    // integer + DEFAULT nextval(<owned sequence>) is how PostgreSQL stores serial.
    const serial = r.serial && SERIAL_OF[type];
    if (serial) type = serial;
    const raw = { colconstype: 'n' };
    if (r.identity) {
      raw.colconstype = 'i';
      raw.attidentity = r.identity;
    } else if (r.generated) {
      raw.colconstype = 'g';
      raw.genexpr = r.default;
    }
    t.columns.push(
      newColumn({
        name: r.name,
        type,
        length,
        precision,
        notNull: !!r.notnull,
        default: r.generated || serial ? '' : r.default ?? '',
        attnum: Number(r.attnum),
        description: r.description ?? '',
        raw,
      })
    );
  }

  const colName = (t, attnum) => t.columns.find((c) => c.attnum === Number(attnum))?.name;

  for (const r of catalog.constraints) {
    const t = byOid.get(String(r.oid));
    if (!t) continue;
    const cols = (r.cols ?? []).map(Number);
    if (r.type === 'p') {
      for (const c of t.columns) if (cols.includes(c.attnum)) c.pk = true;
      t.rawData.primary_key = [{ name: r.name, columns: cols.map((a) => ({ column: colName(t, a) })) }];
    } else if (r.type === 'u') {
      t.rawData.unique_constraint.push({ name: r.name, columns: cols.map((a) => ({ column: colName(t, a) })) });
    } else if (r.type === 'f') {
      const ref = byOid.get(String(r.ref_oid));
      if (!ref) continue;
      const group = uuid();
      const refCols = (r.ref_cols ?? []).map(Number);
      cols.forEach((attnum, i) => {
        model.links.push({
          id: uuid(),
          type: 'onetomany',
          localTable: t.id,
          localCol: attnum,
          refTable: ref.id,
          refCol: refCols[i],
          group,
          fkName: r.name,
          rawFk: {
            name: r.name,
            confupdtype: r.confupdtype,
            confdeltype: r.confdeltype,
            confmatchtype: r.confmatchtype === 'f',
          },
          raw: null,
        });
      });
    }
  }
  return model;
}
