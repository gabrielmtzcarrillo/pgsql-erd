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
`;

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
`;
