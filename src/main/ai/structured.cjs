// Structured generation: ask the model for JSON matching a schema, then
// parse it, validate it against the JSON Schema and (for a table) against
// the table's columns, NOT NULL constraints and types. Invalid output is sent
// back to the model with the errors, up to `retries` times. Only validated
// values are returned.

const { isFormatUnsupported } = require('./provider.cjs');

async function structured({ provider, model, shared, schema: dbSchema, prompt, jsonSchema, table, retries = 2, temperature, signal, system }) {
  let t = null;
  if (table) {
    t = shared.findTable(dbSchema, table);
    if (!t) throw new Error(`Unknown table: ${table}`);
  }
  const schema = jsonSchema ?? (t ? shared.tableJsonSchema(t, dbSchema) : null);
  if (!schema) throw new Error('ai.structured() needs a schema or a table.');

  const messages = [
    {
      role: 'system',
      content:
        (system ? `${system}\n\n` : '') +
        'Reply with a single JSON value that matches this JSON Schema. No prose, no code fences.\n' +
        JSON.stringify(schema),
    },
    { role: 'user', content: String(prompt) },
  ];
  let useFormat = true;
  let lastErrors = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await provider.chat({ model, messages, temperature, json: useFormat ? { name: 'result', schema } : undefined }, { signal });
    } catch (err) {
      if (useFormat && isFormatUnsupported(err)) {
        useFormat = false;
        attempt--;
        continue;
      }
      throw err;
    }
    const parsed = shared.parseModelJson(res.content);
    let errors;
    if (!parsed.ok) errors = [parsed.error];
    else {
      errors = shared.validateJson(parsed.value, schema);
      if (!errors.length && t) errors = shared.checkRowAgainstTable(t, parsed.value, dbSchema).filter((e) => !isMissingForeignKey(t, e));
    }
    if (!errors.length) return { value: parsed.value, attempts: attempt + 1 };
    lastErrors = errors;
    messages.push({ role: 'assistant', content: String(res.content ?? '') });
    messages.push({ role: 'user', content: `That output is invalid:\n- ${errors.slice(0, 20).join('\n- ')}\nReply again with corrected JSON only.` });
  }
  const err = new Error(`The model did not return valid data after ${retries + 1} attempts:\n- ${lastErrors.slice(0, 10).join('\n- ')}`);
  err.validationErrors = lastErrors;
  throw err;
}

// Foreign key columns are left out of the table's JSON schema (they must
// point at existing rows); the script fills them, e.g. with seed.row().
function isMissingForeignKey(t, error) {
  const col = error.split(':')[0];
  return /NOT NULL column has no value/.test(error) && t.foreignKeys.some((fk) => fk.columns.includes(col));
}

module.exports = { structured };
