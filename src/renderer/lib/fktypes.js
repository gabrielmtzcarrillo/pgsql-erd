// A foreign key column must have its referenced column's type, or PostgreSQL
// refuses the constraint (bigint against numeric(20,0), say). Types are
// translated column by column, and the two ends of a key can come out
// different: MySQL's bigint unsigned AUTO_INCREMENT becomes bigserial while a
// bigint unsigned that points to it becomes numeric(20,0). This gives each
// foreign key column the type of the column it references (a serial type's
// plain integer), for tables in the shape parseJsonModel() reads.

const PLAIN = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' };

/** Tables: [{ name, schema, columns: [{ name, type }], foreignKeys: [{ columns, references: { schema, table, columns } }] }]. Changed in place. */
export function alignForeignKeyTypes(tables, defaultSchema) {
  const key = (schema, name) => `${schema ?? defaultSchema}.${name}`.toLowerCase();
  const byKey = new Map(tables.map((t) => [key(t.schema, t.name), t]));
  for (const t of tables) {
    for (const fk of t.foreignKeys ?? []) {
      const target = byKey.get(key(fk.references?.schema, fk.references?.table));
      if (!target) continue;
      const refCols = fk.references.columns?.length ? fk.references.columns : null;
      fk.columns.forEach((name, i) => {
        const col = t.columns.find((c) => c.name === name);
        const refName = refCols?.[i] ?? (target.primaryKey?.length === fk.columns.length ? target.primaryKey[i] : null);
        const ref = refName && target.columns.find((c) => c.name === refName);
        if (!col || !ref) return;
        col.type = PLAIN[ref.type] ?? ref.type;
      });
    }
  }
  return tables;
}
