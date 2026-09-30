// Icons in the style of an Office ribbon: 24x24 outlines with a tinted fill
// on their main shape, drawn in a colour ("tone") per icon. Each ICONS value
// is the inner SVG markup; keys are icon names, and toolbar and menu commands
// use the command name as the icon name. Also used by scripts/menu-icons.mjs
// to render the PNG icons of the native application menu.

// Tinted fill for an icon's main shape; strokes stay solid.
const F = 'fill="currentColor" fill-opacity="0.22"';

const FILE = `<path ${F} d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`;
const MAGNIFIER = `<circle ${F} cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>`;
const CORNERS = '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>';
const DATABASE = `<path ${F} d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>`;
const SQUARE = `<rect ${F} x="3" y="3" width="18" height="18" rx="2"/>`;

export const ICONS = {
  // Commands (toolbar buttons and menu items)
  'new': `${FILE}<path d="M12 11v6M9 14h6"/>`,
  'new-window': `<rect ${F} x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M12 12v5M9.5 14.5h5"/>`,
  'open': `<path ${F} d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/>`,
  'save': `<path ${F} d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>`,
  'save-as': `<path ${F} d="M11 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v3"/><path d="M7 3v5h8V3M7 21v-7h4"/><path d="m18.5 13.5 2 2-5.5 5.5h-2v-2z"/>`,
  'toggle-tables': `<rect ${F} x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h9M8 12h9M8 16h9M5.5 8h.01M5.5 12h.01M5.5 16h.01"/>`,
  'add-table': `<path ${F} d="M12 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7"/><path d="M3 9h18M9 9v12M18 15v6M15 18h6"/>`,
  'add-link': `<rect ${F} x="2" y="3" width="7" height="6" rx="1"/><rect ${F} x="15" y="15" width="7" height="6" rx="1"/><path d="M5.5 9v5a4 4 0 0 0 4 4H15"/>`,
  'delete': `<path ${F} d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6z"/><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M10 11v6M14 11v6"/>`,
  'undo': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'redo': '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  'zoom-out': `${MAGNIFIER}<path d="M8 11h6"/>`,
  'zoom-in': `${MAGNIFIER}<path d="M8 11h6M11 8v6"/>`,
  'fit': `<rect ${F} x="7" y="7" width="10" height="10" rx="1"/>${CORNERS}`,
  'auto-layout': `<rect ${F} x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect ${F} x="14" y="14" width="7" height="7" rx="1"/>`,
  'toggle-grid': `${SQUARE}<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>`,
  'toggle-snap': `<path ${F} d="M6 15a6 6 0 0 0 12 0V4h-4v11a2 2 0 0 1-4 0V4H6z"/><path d="M6 8h4M14 8h4"/>`,
  'db-connect': DATABASE,
  'db-import': `<path ${F} d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4z"/><path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/>`,
  'db-compare': '<path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>',
  'toggle-sql': `${SQUARE}<path d="m14 9 3 3-3 3M10 9l-3 3 3 3"/>`,
  'export-sql': `${FILE}<path d="m10 12-2 2.5 2 2.5M14 12l2 2.5-2 2.5"/>`,
  'export-svg': `<path ${F} d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="m12 19 7-7 3 3-7 7z"/><path d="m2 2 7.6 7.6"/><circle cx="11" cy="11" r="2"/>`,
  'export-png': `${SQUARE}<circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>`,

  // Keys
  'pk': `<circle ${F} cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2.5 2.5"/>`,
  'fk': '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',

  // General actions
  'plus': '<path d="M12 5v14M5 12h14"/>',
  'close': '<path d="M18 6 6 18M6 6l12 12"/>',
  'copy': `<rect ${F} x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>`,
  'cut': `<circle ${F} cx="6" cy="6" r="3"/><circle ${F} cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>`,
  'paste': `<path ${F} d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>`,
  'select-all': '<path d="M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M21 19a2 2 0 0 1-2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1"/>',
  'check-all': `${SQUARE}<path d="m8 12 3 3 5-6"/>`,
  'check-none': SQUARE,
  'refresh': '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  'reset': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  'test': `<path ${F} d="M13 2 3 14h9l-1 8 10-12h-9z"/>`,
  'run': `<path ${F} d="M6 4v16l14-8z"/>`,
  'go': '<path d="M5 12h14M12 5l7 7-7 7"/>',
  'up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  'ok': '<path d="M20 6 9 17l-5-5"/>',
  'fullscreen': CORNERS,
  'devtools': `<path ${F} d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>`,
  'about': `<circle ${F} cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>`,
  'quit': '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
};

// Tone colours as [on light backgrounds, on dark backgrounds].
export const TONES = {
  blue: ['#1f6fc5', '#5aa9f0'],
  green: ['#218a4c', '#4cc47d'],
  amber: ['#c98a00', '#f2bd3d'],
  red: ['#c93636', '#f07070'],
  purple: ['#7a4cc7', '#b391f0'],
  teal: ['#12808c', '#3fc0cd'],
  orange: ['#cf6214', '#f59a55'],
};

// Tone of each icon; icons without one use the text colour.
export const ICON_TONES = {
  'new': 'blue', 'new-window': 'blue', 'open': 'amber', 'save': 'purple', 'save-as': 'purple',
  'toggle-tables': 'teal', 'add-table': 'green', 'add-link': 'blue', 'delete': 'red',
  'undo': 'blue', 'redo': 'blue', 'zoom-out': 'teal', 'zoom-in': 'teal', 'fit': 'teal',
  'auto-layout': 'purple', 'toggle-grid': 'teal', 'toggle-snap': 'red',
  'db-connect': 'green', 'db-import': 'green', 'db-compare': 'orange',
  'toggle-sql': 'purple', 'export-sql': 'orange', 'export-svg': 'orange', 'export-png': 'green',
  'pk': 'amber', 'fk': 'blue',
  'plus': 'green', 'close': 'red', 'copy': 'blue', 'paste': 'amber', 'select-all': 'blue',
  'check-all': 'green', 'refresh': 'green', 'reset': 'blue', 'test': 'amber', 'run': 'green',
  'go': 'blue', 'up': 'blue', 'down': 'blue', 'ok': 'green', 'fullscreen': 'teal',
  'about': 'blue', 'quit': 'red',
};

export function iconTone(name) {
  return TONES[ICON_TONES[name]] ?? null;
}

export function iconMarkup(name, cls = 'btn-icon') {
  const inner = ICONS[name];
  if (!inner) return '';
  const tone = iconTone(name);
  const style = tone ? ` style="--tone:${tone[0]};--tone-dark:${tone[1]}"` : '';
  return `<svg class="${cls}"${style} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" `
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

// A standalone icon element, e.g. for badges.
export function iconElement(name, cls) {
  const t = document.createElement('template');
  t.innerHTML = iconMarkup(name, cls);
  return t.content.firstChild;
}

// Give one button an icon, and wrap its text in a .label span so the label
// can be changed without removing the icon. A button with no text becomes
// icon-only, labelled by its title.
export function decorateButton(btn, name) {
  if (!ICONS[name] || btn.querySelector(':scope > .btn-icon')) return btn;
  const text = btn.textContent.trim();
  btn.textContent = '';
  btn.insertAdjacentHTML('afterbegin', iconMarkup(name));
  if (text) {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = text;
    btn.append(label);
  } else {
    btn.classList.add('icon-only');
    if (btn.title) btn.setAttribute('aria-label', btn.title);
  }
  return btn;
}

// Decorate every button in `root` that names an icon with data-icon, or
// failing that, runs a command with a known icon (data-cmd).
export function decorateButtons(root) {
  for (const btn of root.querySelectorAll('button[data-icon], button[data-cmd]')) {
    decorateButton(btn, btn.dataset.icon ?? btn.dataset.cmd);
  }
}
