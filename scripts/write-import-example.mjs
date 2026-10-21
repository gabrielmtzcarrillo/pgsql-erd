// Writes docs/examples/alumnos.import.json: the example of the spec, exactly as the tests use it.
import { writeFileSync } from 'node:fs';
import { EXAMPLE_TEMPLATE } from '../tests/import-template.fixtures.js';

writeFileSync(new URL('../docs/examples/alumnos.import.json', import.meta.url), `${JSON.stringify(EXAMPLE_TEMPLATE, null, 2)}\n`);
