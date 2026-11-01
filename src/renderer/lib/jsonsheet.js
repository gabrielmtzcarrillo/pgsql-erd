// A JSON data file as worksheets of string cells, so the Import Designer can
// treat a folder of JSON files like an example workbook: the reference file
// gives the columns, and every other file of the folder is expected to have
// the same shape.
//
// A top-level array of objects is one sheet named after the file; an object
// whose properties hold arrays of objects gives one sheet per property; any
// other object is a sheet with a single row. Nested objects become dotted
// columns (address.city), arrays of plain values are joined with ", " and
// other nested arrays are kept as JSON text.

const MAX_COLS = 200;

function flatten(value, prefix, out) {
  if (Array.isArray(value)) {
    out[prefix] = value.every((v) => v === null || typeof v !== 'object') ? value.map((v) => v ?? '').join(', ') : JSON.stringify(value);
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) out[prefix] = '';
    for (const k of keys) flatten(value[k], prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = value === null || value === undefined ? '' : String(value);
  return out;
}

function toSheet(name, records) {
  const keys = [];
  const seen = new Set();
  const flat = records.map((r) => flatten(r, '', {}));
  for (const f of flat) {
    for (const k of Object.keys(f)) {
      if (!seen.has(k) && keys.length < MAX_COLS) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return { name, hidden: false, rows: [keys, ...flat.map((f) => keys.map((k) => f[k] ?? ''))] };
}

const isRecord = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Sheets for the text of one JSON file; `fileName` names the sheet (or `sheetName`, for a file that is one list or one record). */
export function jsonSheets(fileName, text, sheetName = null) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }
  const base = sheetName || String(fileName).split(/[\/]/).pop().replace(/\.json$/i, '') || 'json';
  if (Array.isArray(json)) {
    return [toSheet(base, json.map((r) => (isRecord(r) ? r : { value: r })))];
  }
  if (!isRecord(json)) throw new Error('Expected a JSON object or an array');
  const lists = Object.entries(json).filter(([, v]) => Array.isArray(v) && v.length && v.every(isRecord));
  if (lists.length) return lists.map(([k, v]) => toSheet(k.slice(0, 31) || base, v));
  return [toSheet(base, [json])];
}

/**
 * Sheets for a folder of JSON files: `files` is [{ name, text }] with the
 * reference file first. Its fields are the columns; the records of every
 * file (the reference included) are the rows, matched to the columns by field
 * name. A file that is a plain list (or one record) is the reference's first
 * sheet. A sheet that only a later file has is ignored, and so are its fields
 * the reference does not have. Returns { sheets, failed: [{ name, message }] }.
 */
export function jsonFolderSheets(files) {
  const failed = [];
  let sheets = null;
  for (const f of files) {
    let found;
    try {
      if (f.error) throw new Error(f.error);
      found = jsonSheets(f.name, f.text, sheets?.[0]?.name);
    } catch (err) {
      if (!sheets) throw err; // the reference file must be readable
      failed.push({ name: f.name, message: err.message });
      continue;
    }
    if (!sheets) {
      sheets = found;
      continue;
    }
    for (const sheet of found) {
      const base = sheets.find((s) => s.name === sheet.name);
      if (!base) continue;
      const at = new Map(sheet.rows[0].map((k, i) => [k, i]));
      const cols = base.rows[0].map((k) => (at.has(k) ? at.get(k) : -1));
      for (const row of sheet.rows.slice(1)) base.rows.push(cols.map((c) => (c < 0 ? '' : row[c])));
    }
  }
  return { sheets, failed };
}
