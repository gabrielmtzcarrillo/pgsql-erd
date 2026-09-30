import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokenizeSQL } from '../src/renderer/lib/highlight.js';
import { parsePgerd } from '../src/renderer/lib/pgerd.js';
import { generateSQL } from '../src/renderer/lib/sql.js';

const kinds = (sql) => tokenizeSQL(sql).filter((t) => t.type !== 'space').map((t) => [t.type, t.text]);

test('tokens reproduce the input exactly', () => {
  const sql = generateSQL(parsePgerd(readFileSync(new URL('../samples/shop.pgerd', import.meta.url), 'utf8')));
  assert.equal(tokenizeSQL(sql).map((t) => t.text).join(''), sql);
  for (const s of ["'unterminated", '/* open', '"half', '$$ body', 'a ¤ b', '']) {
    assert.equal(tokenizeSQL(s).map((t) => t.text).join(''), s);
  }
});

test('classifies keywords, types, functions and literals', () => {
  assert.deepEqual(kinds("CREATE TABLE IF NOT EXISTS public.t (id bigint NOT NULL DEFAULT now(), v numeric(10,2));"), [
    ['keyword', 'CREATE'], ['keyword', 'TABLE'], ['keyword', 'IF'], ['keyword', 'NOT'], ['keyword', 'EXISTS'],
    ['plain', 'public'], ['punct', '.'], ['plain', 't'], ['punct', '('], ['plain', 'id'], ['type', 'bigint'],
    ['keyword', 'NOT'], ['keyword', 'NULL'], ['keyword', 'DEFAULT'], ['function', 'now'], ['punct', '(),'],
    ['plain', 'v'], ['type', 'numeric'], ['punct', '('], ['number', '10'], ['punct', ','],
    ['number', '2'], ['punct', '));'],
  ]);
});

test('handles strings, quoted identifiers, casts and comments', () => {
  assert.deepEqual(kinds(`-- note\nSELECT 'it''s'::text, "Order Items", $fn$ x $fn$ /* c */`), [
    ['comment', '-- note'], ['keyword', 'SELECT'], ['string', "'it''s'"], ['operator', '::'], ['type', 'text'],
    ['punct', ','], ['ident', '"Order Items"'], ['punct', ','], ['string', '$fn$ x $fn$'], ['comment', '/* c */'],
  ]);
});

test('treats "with time zone" as part of the type', () => {
  assert.deepEqual(kinds('timestamp with time zone WITH'), [
    ['type', 'timestamp'], ['type', 'with'], ['type', 'time'], ['type', 'zone'], ['keyword', 'WITH'],
  ]);
});

test('does not treat digits inside identifiers as numbers', () => {
  assert.deepEqual(kinds('col_1 t2'), [['plain', 'col_1'], ['plain', 't2']]);
});
