// Writes docs/import-template.schema.json from IMPORT_TEMPLATE_SCHEMA.
//   node scripts/write-import-schema.mjs
import { writeFileSync } from 'node:fs';
import { IMPORT_TEMPLATE_SCHEMA } from '../src/shared/import-template.js';

writeFileSync(new URL('../docs/import-template.schema.json', import.meta.url), `${JSON.stringify(IMPORT_TEMPLATE_SCHEMA, null, 2)}\n`);
