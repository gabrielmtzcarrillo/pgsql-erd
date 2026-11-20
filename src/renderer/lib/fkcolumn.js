// The foreign key column made by dragging a table's bottom "+" node onto a
// column of another table: it takes the referenced column's name and type.
// No DOM access here, so it can be tested under Node.

import { newColumn, nextAttnum } from './pgerd.js';

const PLAIN = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' };

/** Type, length and precision for a column that references refCol (a serial key is referenced as its plain integer). */
export function refColumnType(refCol) {
  return {
    type: PLAIN[refCol.type] ?? refCol.type,
    length: refCol.length ?? null,
    precision: refCol.precision ?? null,
  };
}

/**
 * Name for the new column in `table`: the referenced column's name, or
 * `<ref table>_<column>` when the table already has a column with that name
 * (a referenced `id`, say), with a number added while it is still taken.
 */
export function fkColumnName(table, refTable, refCol) {
  const taken = new Set(table.columns.map((c) => String(c.name).toLowerCase()));
  const free = (n) => !taken.has(n.toLowerCase());
  if (free(refCol.name)) return refCol.name;
  const base = `${refTable.name}_${refCol.name}`;
  if (free(base)) return base;
  let i = 2;
  while (!free(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** A new column for `table` that matches refCol of refTable, ready to push. */
export function newFkColumn(table, refTable, refCol) {
  return newColumn({
    name: fkColumnName(table, refTable, refCol),
    ...refColumnType(refCol),
    attnum: nextAttnum(table),
  });
}

/** The column a drop on a whole table refers to: its primary key when it has exactly one column. */
export function singlePrimaryKey(table) {
  const pks = table.columns.filter((c) => c.pk);
  return pks.length === 1 ? pks[0] : null;
}
