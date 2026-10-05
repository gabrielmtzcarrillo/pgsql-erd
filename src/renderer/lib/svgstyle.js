// Styles for diagram elements. Shared by the live canvas and by exported
// SVG/PNG images so both look the same.

export const FONT_FAMILY = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
export const FONT = `12px ${FONT_FAMILY}`;
export const FONT_BOLD = `600 13px ${FONT_FAMILY}`;

export const LIGHT_VARS = `
  --erd-table-bg: #ffffff;
  --erd-table-border: #c9ced6;
  --erd-header-bg: #2f6fb3;
  --erd-header-fg: #ffffff;
  --erd-text: #1f2328;
  --erd-muted: #6b7280;
  --erd-row-hover: #eef4fb;
  --erd-pk: #b7791f;
  --erd-fk: #2f6fb3;
  --erd-link: #7d8590;
  --erd-accent: #0a84ff;
  --erd-script-bg: #fbfaff;
  --erd-script-border: #b9acd9;
  --erd-script-header: #6f4fb0;
  --erd-pass: #1a7f37;
  --erd-fail: #cf222e;
`;

export const DARK_VARS = `
  --erd-table-bg: #23272e;
  --erd-table-border: #3d444d;
  --erd-header-bg: #2b5b8f;
  --erd-header-fg: #ffffff;
  --erd-text: #e6edf3;
  --erd-muted: #8b949e;
  --erd-row-hover: #2d333b;
  --erd-pk: #e3b341;
  --erd-fk: #6cb6ff;
  --erd-link: #8b949e;
  --erd-accent: #4aa3ff;
  --erd-script-bg: #262233;
  --erd-script-border: #4d4466;
  --erd-script-header: #5b4494;
  --erd-pass: #4cc47d;
  --erd-fail: #f07070;
`;

export const VS2026_VARS = `
  --erd-table-bg: #2b2b2b;
  --erd-table-border: #454545;
  --erd-header-bg: #68217a;
  --erd-header-fg: #ffffff;
  --erd-text: #dcdcdc;
  --erd-muted: #9d9d9d;
  --erd-row-hover: #383838;
  --erd-pk: #dcdcaa;
  --erd-fk: #4ec9b0;
  --erd-link: #8a8a8a;
  --erd-accent: #a68af9;
  --erd-script-bg: #2a2633;
  --erd-script-border: #5e5373;
  --erd-script-header: #4b3a80;
  --erd-pass: #6a9955;
  --erd-fail: #f14c4c;
`;

export const WINME_VARS = `
  --erd-table-bg: #ffffff;
  --erd-table-border: #000000;
  --erd-header-bg: #0a246a;
  --erd-header-fg: #ffffff;
  --erd-text: #000000;
  --erd-muted: #808080;
  --erd-row-hover: #d4d0c8;
  --erd-pk: #808000;
  --erd-fk: #000080;
  --erd-link: #000000;
  --erd-accent: #0a246a;
  --erd-script-bg: #ffffe1;
  --erd-script-border: #808080;
  --erd-script-header: #800080;
  --erd-pass: #008000;
  --erd-fail: #ff0000;
`;

// Diagram colours and exported-image background per theme (View → Theme).
export const THEME_DIAGRAM = {
  white: { vars: LIGHT_VARS, background: '#ffffff' },
  dark: { vars: DARK_VARS, background: '#1b1e24' },
  vs2026: { vars: VS2026_VARS, background: '#1f1f1f' },
  winme: { vars: WINME_VARS, background: '#ffffff' },
};

export const DIAGRAM_CSS = `
  .erd-table .t-body { fill: var(--erd-table-bg); stroke: var(--erd-table-border); stroke-width: 1; }
  .erd-table .t-header { fill: var(--erd-header-bg); }
  .erd-table .t-title { fill: var(--erd-header-fg); font: ${FONT_BOLD}; }
  .erd-table .t-schema { fill-opacity: 0.75; font-weight: 400; }
  .erd-table .t-note { fill: var(--erd-header-fg); font: ${FONT}; }
  .erd-table .t-col { fill: var(--erd-text); font: ${FONT}; }
  .erd-table .t-col.nn { font-weight: 600; }
  .erd-table .t-type { fill: var(--erd-muted); font: ${FONT}; }
  .erd-table .t-key { fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .erd-table .t-key.pk { color: var(--erd-pk); }
  .erd-table .t-key.fk { color: var(--erd-fk); }
  .erd-table .t-empty { fill: var(--erd-muted); font: italic ${FONT}; }
  .erd-table .t-row-bg { fill: transparent; }
  .erd-link .l-line { fill: none; stroke: var(--erd-link); stroke-width: 1.4; }
  .erd-link .l-marker { fill: none; stroke: var(--erd-link); stroke-width: 1.4; }
  .erd-link .l-hit { fill: none; stroke: transparent; stroke-width: 12; }
  .erd-script .s-body { fill: var(--erd-script-bg); stroke: var(--erd-script-border); stroke-width: 1; stroke-dasharray: 4 3; }
  .erd-script .s-header { fill: var(--erd-script-header); }
  .erd-script.type-validator .s-header { fill: #2c7a4b; }
  .erd-script.type-migration .s-header { fill: #b35a1f; }
  .erd-script.type-query .s-header, .erd-script.type-export .s-header { fill: #2f6fb3; }
  .erd-script .s-icon { color: #ffffff; }
  .erd-script .s-title { fill: #ffffff; font: ${FONT_BOLD}; }
  .erd-script .s-line { fill: var(--erd-text); font: ${FONT}; }
  .erd-script .muted { fill: var(--erd-muted); }
  .erd-script .s-status { font: ${FONT_BOLD}; font-size: 12px; }
  .erd-script .pass { fill: var(--erd-pass); }
  .erd-script .fail { fill: var(--erd-fail); }
  .erd-script-link .sl-line { fill: none; stroke: var(--erd-script-border); stroke-width: 1.4; stroke-dasharray: 5 4; }
  .erd-script-link .sl-end { fill: var(--erd-script-border); }
  .erd-script-link .sl-label-bg { fill: var(--erd-script-bg); stroke: var(--erd-script-border); stroke-width: 1; }
  .erd-script-link .sl-label { fill: var(--erd-muted); font: italic 11px ${FONT_FAMILY}; }
`;
