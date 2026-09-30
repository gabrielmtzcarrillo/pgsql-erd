// Translations. The English text is the key: tr('Save') returns the text in
// the current locale, or the English text when there is no translation, so
// untranslated strings still read correctly. Parameters are written as
// {name} and filled from an object: tr('{n} tables', { n: 3 }).
// (tr, not t: t is the usual name for a table throughout the code.)
//
// Catalogs live in ./locales/<code>.js and map English text to the
// translation. tests/i18n.test.js checks that every string passed to tr() or
// trn() has an entry in each catalog.
//
// Used by the main process (menus, dialogs) and the page. In the page the
// locale comes from the preload bridge (window.erdHost.locale), so it is set
// before any module that imports this one runs.

import es from './locales/es.js';

// Languages offered in View → Language, by code, in their own language.
export const LOCALES = { en: 'English', es: 'Español' };

const CATALOGS = { en: {}, es };

let current = 'en';
let catalog = CATALOGS.en;

// 'es-MX' → 'es'; unknown languages fall back to English.
export function resolveLocale(preference, systemLocale = 'en') {
  const pick = (code) => {
    const base = String(code ?? '').toLowerCase().split(/[-_]/)[0];
    return base in CATALOGS ? base : null;
  };
  if (preference && preference !== 'system') return pick(preference) ?? 'en';
  return pick(systemLocale) ?? 'en';
}

export function setLocale(code) {
  current = resolveLocale(code);
  catalog = CATALOGS[current];
  return current;
}

export const getLocale = () => current;

function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

export function tr(text, params) {
  return fill(catalog[text] ?? text, params);
}

// Singular or plural by count; {n} is the count. Both forms are keys:
// trn(3, '{n} table', '{n} tables').
export function trn(n, one, other, params) {
  return tr(n === 1 ? one : other, { n, ...params });
}

// Numbers and dates in the language's format (1,234.5 or 1.234,5). In
// English they follow the system's regional settings, as before; the page's
// default Intl locale comes from the environment, not the chosen language.
const formatLocale = () => (current === 'en' ? undefined : current);

export function formatNumber(n, options) {
  return Number(n).toLocaleString(formatLocale(), options);
}

export function formatDate(value) {
  return new Date(value).toLocaleString(formatLocale());
}

// Translates the static page: text nodes and the title, placeholder and
// aria-label attributes whose text is in the catalog. Elements with
// data-i18n are translated as a whole: the key is the attribute's value, for
// a label that needs its own translation in one place (data-i18n="ribbon:
// Grid"), or else the inner HTML with whitespace collapsed, for paragraphs
// with inline markup.
export function translateDom(root) {
  if (current === 'en') return;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n') || norm(node.innerHTML);
    if (catalog[key]) node.innerHTML = catalog[key];
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('[data-i18n], script, style, pre, code')) continue;
    const key = norm(n.nodeValue);
    if (!key || !catalog[key]) continue;
    const [, lead, , trail] = n.nodeValue.match(/^(\s*)([\s\S]*?)(\s*)$/);
    n.nodeValue = lead + catalog[key] + trail;
  }
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const node of root.querySelectorAll(`[${attr}]`)) {
      const key = norm(node.getAttribute(attr));
      if (catalog[key]) node.setAttribute(attr, catalog[key]);
    }
  }
}

// In the page, take the locale from the preload bridge right away.
if (typeof window !== 'undefined' && window.erdHost?.locale) setLocale(window.erdHost.locale);
