// Colour theme picked in View → Theme. The main process sets Chromium's light or
// dark scheme to match the theme's base, so prefers-color-scheme (and Monaco)
// follows along; this applies the theme's own colours as <html data-theme>.

import { THEME_DIAGRAM } from './lib/svgstyle.js';

const host = window.erdHost;
const BASE = { white: 'light', dark: 'dark', vs2026: 'dark', winme: 'light' };
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

let choice = host?.theme ?? 'system';

// The theme in effect: 'system' resolves to White or Dark.
export function currentTheme() {
  if (BASE[choice]) return choice;
  return darkQuery.matches ? 'dark' : 'white';
}

export const isDarkTheme = () => BASE[currentTheme()] === 'dark';

export const diagramTheme = () => THEME_DIAGRAM[currentTheme()];

function apply() {
  const root = document.documentElement;
  root.dataset.theme = currentTheme();
  root.dataset.base = BASE[currentTheme()];
}

export function initTheme() {
  apply();
  darkQuery.addEventListener('change', apply);
  host?.onTheme?.((name) => {
    choice = name;
    apply();
  });
}
