// Translations: every string passed to tr() / trn(), every label shown from
// the shared modules and every text of the static page has an entry in each
// catalog, with the same {placeholders}.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr, trn, setLocale, resolveLocale, LOCALES } from '../src/shared/i18n.js';
import es from '../src/shared/locales/es.js';
import { SCRIPT_TYPES } from '../src/shared/scripts.js';
import { SCRIPT_PROFILES, SCRIPT_PERMISSION_LABELS, AI_PERMISSION_LABELS } from '../src/shared/permissions.js';
import { VECTOR_DISTANCES } from '../src/shared/pgvector.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGS = { es };

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'locales' || e.name === 'menu-icons' ? [] : sourceFiles(p);
    return /\.(c?js|mjs)$/.test(e.name) ? [p] : [];
  });
}

// Reads a string literal at s[i] ('…', "…" or `…` without ${}); null if none.
function literal(s, i) {
  const q = s[i];
  if (!`'"\``.includes(q)) return null;
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      const n = s[++j];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else if (c === q) return { text: out, end: j + 1 };
    else if (q === '`' && c === '$' && s[j + 1] === '{') return null;
    else out += c;
  }
  return null;
}

const skipSpace = (s, i) => {
  while (/\s/.test(s[i])) i++;
  return i;
};

// Keys used in code: tr('text', …) and trn(n, 'one', 'other', …).
function codeKeys(files = sourceFiles(path.join(root, 'src'))) {
  const keys = new Map(); // key -> first file:line
  for (const file of files) {
    const s = fs.readFileSync(file, 'utf8');
    for (const m of s.matchAll(/\btr(n?)\(/g)) {
      if (/[\w.]/.test(s[m.index - 1] ?? '') || s.slice(m.index - 9, m.index) === 'function ') continue;
      let i = m.index + m[0].length;
      if (m[1]) {
        // skip the count argument
        let depth = 0;
        for (; i < s.length; i++) {
          if ('([{'.includes(s[i])) depth++;
          else if (')]}'.includes(s[i])) depth--;
          else if (s[i] === ',' && depth === 0) break;
        }
        i++;
      }
      for (let n = 0; n < (m[1] ? 2 : 1); n++) {
        i = skipSpace(s, i);
        const lit = literal(s, i);
        if (!lit) break;
        const line = s.slice(0, m.index).split('\n').length;
        if (!keys.has(lit.text)) keys.set(lit.text, `${path.relative(root, file)}:${line}`);
        i = skipSpace(s, lit.end);
        if (s[i] === ',') i++;
      }
    }
  }
  return keys;
}

// Labels kept in English in shared modules and translated where shown.
function labelKeys() {
  return [
    ...Object.values(SCRIPT_TYPES).map((x) => x.label),
    ...Object.values(SCRIPT_PROFILES).map((x) => x.label),
    ...Object.values(SCRIPT_PERMISSION_LABELS),
    ...Object.values(AI_PERMISSION_LABELS),
    ...VECTOR_DISTANCES.map((x) => x.label),
  ];
}

// Texts of the static page that are not translated: names, numbers, SQL
// terms and examples.
const HTML_KEEP = new Set([
  'pgsql-erd', '100%', 'SSL', 'disable', 'verify-full', 'localhost', '5432', 'postgres', 'SQL', 'Cypher',
  'API key', 'Base URL', 'public', 'Excel', 'PNG', 'SVG',
]);

// Texts of index.html, as translateDom() finds them.
function htmlKeys() {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const decode = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const keys = new Set();
  const body = html.slice(html.indexOf('<body'));
  // data-i18n elements: the attribute's value, or else their inner HTML
  const whole = [];
  for (const m of body.matchAll(/<(\w+)([^>]*\bdata-i18n\b[^>]*)>([\s\S]*?)<\/\1>/g)) {
    keys.add(m[2].match(/\bdata-i18n="([^"]+)"/)?.[1] ?? norm(m[3]));
    whole.push(m[0]);
  }
  let rest = body;
  for (const w of whole) rest = rest.replace(w, '');
  rest = rest.replace(/<(script|style|pre|code)\b[\s\S]*?<\/\1>/g, '');
  for (const m of rest.matchAll(/>([^<>]+)</g)) {
    const k = norm(decode(m[1]));
    if (k && /[A-Za-z]/.test(k)) keys.add(k);
  }
  for (const m of body.matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g)) {
    const k = norm(decode(m[1]));
    if (k && /[A-Za-z]/.test(k)) keys.add(k);
  }
  return [...keys].filter((k) => !HTML_KEEP.has(k));
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('i18n: English is the default and needs no catalog', () => {
  setLocale('en');
  assert.equal(tr('Save'), 'Save');
  assert.equal(tr('Opened {n} tables from {file}', { n: 2, file: 'a.pgerd' }), 'Opened 2 tables from a.pgerd');
  assert.equal(trn(1, '{n} table', '{n} tables'), '1 table');
  assert.equal(trn(3, '{n} table', '{n} tables'), '3 tables');
  assert.equal(tr('Unknown {x}'), 'Unknown {x}');
});

test('i18n: locale resolution', () => {
  assert.equal(resolveLocale('system', 'es-MX'), 'es');
  assert.equal(resolveLocale(undefined, 'es_ES'), 'es');
  assert.equal(resolveLocale('system', 'fr-FR'), 'en');
  assert.equal(resolveLocale('en', 'es-ES'), 'en');
  assert.equal(resolveLocale('es', 'en-US'), 'es');
  assert.equal(resolveLocale('xx', 'es-ES'), 'en');
  assert.deepEqual(Object.keys(LOCALES).sort(), ['en', ...Object.keys(CATALOGS)].sort());
});

test('i18n: Spanish', () => {
  setLocale('es');
  try {
    assert.equal(tr('Save'), es.Save);
    assert.equal(trn(1, '{n} table', '{n} tables'), es['{n} table'].replace('{n}', '1'));
    assert.equal(trn(4, '{n} table', '{n} tables'), es['{n} tables'].replace('{n}', '4'));
    assert.equal(tr('not in any catalog'), 'not in any catalog');
  } finally {
    setLocale('en');
  }
});

for (const [code, catalog] of Object.entries(CATALOGS)) {
  test(`i18n: ${code} catalog covers every string`, () => {
    const missing = [];
    for (const [key, where] of codeKeys()) if (!(key in catalog)) missing.push(`${where}: ${JSON.stringify(key)}`);
    for (const key of labelKeys()) if (!(key in catalog)) missing.push(`label: ${JSON.stringify(key)}`);
    for (const key of htmlKeys()) if (!(key in catalog)) missing.push(`index.html: ${JSON.stringify(key)}`);
    assert.deepEqual(missing, [], `missing ${code} translations`);
  });

  test(`i18n: ${code} translations keep placeholders and spacing`, () => {
    const bad = [];
    for (const [key, value] of Object.entries(catalog)) {
      if (typeof value !== 'string' || !value.trim()) bad.push(`${JSON.stringify(key)}: empty`);
      else if (placeholders(key).join() !== placeholders(value).join()) bad.push(`${JSON.stringify(key)}: placeholders differ`);
      else if (/^\s/.test(key) !== /^\s/.test(value) || /\s$/.test(key) !== /\s$/.test(value)) bad.push(`${JSON.stringify(key)}: leading/trailing space differs`);
    }
    assert.deepEqual(bad, []);
  });

  test(`i18n: ${code} catalog has no unused entries`, () => {
    const used = new Set([...codeKeys().keys(), ...labelKeys(), ...htmlKeys()]);
    const unused = Object.keys(catalog).filter((k) => !used.has(k));
    assert.deepEqual(unused, []);
  });
}
