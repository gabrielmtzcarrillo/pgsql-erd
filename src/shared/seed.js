// Plausible values for table columns, used by seed.row() / seed.fill() in
// the script runner. Picks by column type first and refines by column name
// (email, name, phone, city, …, in English and Spanish).

const RULES = [
  [/(^|_)(e?mail|correo)/i, (f, i, u) => (u ? `${f.internet.userName()}.${i}@example.com` : f.internet.email())],
  [/(first_?name|nombres?$|primer_?nombre)/i, (f) => f.person.firstName()],
  [/(last_?name|surname|apellido)/i, (f) => f.person.lastName()],
  [/(full_?name|^name$|nombre_?completo|^nombre$|display_?name)/i, (f) => f.person.fullName()],
  [/(user_?name|login|usuario$)/i, (f, i, u) => (u ? `${f.internet.userName()}${i}` : f.internet.userName())],
  [/(phone|tel[eé]fono|celular|mobile)/i, (f) => f.phone.number()],
  [/(city|ciudad|municipio)/i, (f) => f.location.city()],
  [/(country|pa[ií]s)/i, (f) => f.location.country()],
  [/(address|direcci[oó]n|calle|street)/i, (f) => f.location.streetAddress()],
  [/(zip|postal|cp$)/i, (f) => f.location.zipCode()],
  [/(company|empresa|organi[sz]a)/i, (f) => f.company.name()],
  [/(department|departamento|area|área)/i, (f) => f.company.department()],
  [/(title|puesto|cargo|job)/i, (f) => f.person.jobTitle()],
  [/(url|website|sitio)/i, (f) => f.internet.url()],
  [/(description|descripci[oó]n|notes?|comment|observaci)/i, (f) => f.lorem.sentence()],
  [/(code|c[oó]digo|clave|sku|n[uú]mero|number|folio|matr[ií]cula)/i, (f, i, u) => (u ? `${f.string.alpha(2).toUpperCase()}${String(i).padStart(6, '0')}` : f.string.alphanumeric(8).toUpperCase())],
];

const INT = /^(smallint|integer|int|int2|int4|bigint|int8|serial|bigserial|smallserial)$/;
const lengthOf = (t) => Number(String(t).match(/\((\d+)/)?.[1]) || null;

// Fit a value into varchar(n). Unique values keep their end, where the
// distinguishing counter is.
function clip(v, col, unique) {
  const len = lengthOf(col.databaseType);
  if (!len || typeof v !== 'string' || v.length <= len) return v;
  return unique ? v.slice(-len) : v.slice(0, len);
}

// enums: Map of enum type name (lowercase, plain and schema-qualified) -> values.
export function valueForColumn(col, faker, { index = 0, unique = false, enums = new Map() } = {}) {
  const base = col.baseType;
  const one = () => {
    if (enums.has(base)) return faker.helpers.arrayElement(enums.get(base));
    if (base === 'boolean' || base === 'bool') return faker.datatype.boolean();
    if (INT.test(base)) {
      if (unique) return index + 1;
      const max = base === 'smallint' || base === 'int2' ? 1000 : 100000;
      return faker.number.int({ min: 1, max });
    }
    if (/^(numeric|decimal|real|double precision|float4|float8|money)$/.test(base)) {
      const scale = Number(String(col.databaseType).match(/\(\s*\d+\s*,\s*(\d+)\s*\)/)?.[1] ?? 2);
      const precision = Number(String(col.databaseType).match(/\(\s*(\d+)/)?.[1] ?? 10);
      const max = Math.min(10 ** Math.max(precision - scale, 1) - 1, 100000);
      return faker.number.float({ min: 0, max, fractionDigits: Math.min(scale, 4) });
    }
    if (base === 'uuid') return faker.string.uuid();
    if (base === 'date') return faker.date.past(5).toISOString().slice(0, 10);
    if (/^timestamp/.test(base)) return faker.date.past(2);
    if (/^time( |$)/.test(base)) return `${String(faker.number.int({ min: 0, max: 23 })).padStart(2, '0')}:${String(faker.number.int({ min: 0, max: 59 })).padStart(2, '0')}:00`;
    if (base === 'interval') return `${faker.number.int({ min: 1, max: 90 })} days`;
    if (base === 'json' || base === 'jsonb') return {};
    if (base === 'inet' || base === 'cidr') return `10.${faker.number.int(255)}.${faker.number.int(255)}.${faker.number.int({ min: 1, max: 254 })}`;
    if (base === 'bytea') return null;
    // Text and anything else PostgreSQL accepts as a string literal.
    const rule = RULES.find(([re]) => re.test(col.name));
    let v = rule ? rule[1](faker, index + 1, unique) : faker.lorem.words(faker.number.int({ min: 1, max: 3 }));
    if (unique && !rule) v = `${v} ${index + 1}`;
    if (base === 'character' || base === 'char' || base === 'bpchar') {
      const len = lengthOf(col.databaseType) ?? 1;
      v = String(v).replace(/\s+/g, '').toUpperCase().padEnd(len, 'X').slice(0, len);
    }
    return clip(v, col, unique);
  };
  if (col.isArray) return [one(), one()].filter((v) => v !== null);
  return one();
}

// Columns a generated row has to fill: everything except columns the
// database produces (serial, identity, generated) and nullable columns with
// a default. Nullable columns without a default are filled too, so the rows
// look realistic.
export function columnsToFill(table) {
  return table.columns.filter((c) => !c.generated && !c.identity && !c.serial && !(c.defaultValue && c.nullable) && !(c.defaultValue && /nextval\(|gen_random_uuid|uuid_generate|now\(\)|current_/i.test(c.defaultValue)));
}

// Columns that must be unique on their own (single-column PK / UNIQUE).
export function uniqueColumns(table) {
  const out = new Set();
  if (table.primaryKey?.columns.length === 1) out.add(table.primaryKey.columns[0]);
  for (const u of table.uniques) if (u.columns.length === 1) out.add(u.columns[0]);
  for (const i of table.indexes ?? []) if (i.unique && i.columns.length === 1) out.add(i.columns[0]);
  return out;
}

export function enumValues(schema) {
  const map = new Map();
  for (const e of schema?.enums ?? []) {
    map.set(e.name.toLowerCase(), e.values);
    map.set(`${e.schema}.${e.name}`.toLowerCase(), e.values);
  }
  return map;
}
