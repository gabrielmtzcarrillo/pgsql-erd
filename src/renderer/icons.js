// Icons: 24x24 stroked outlines drawn with currentColor. Each value is the
// inner SVG markup. Keys are icon names; toolbar and menu commands use the
// command name as the icon name. Also used by scripts/menu-icons.cjs to
// render the PNG icons of the native application menu.

const FILE = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
const MAGNIFIER = '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>';
const SAVE = '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>';
const CORNERS = '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>';
const CLOSE = '<path d="M18 6 6 18M6 6l12 12"/>';
const DATABASE = '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>';

export const ICONS = {
  // Commands (toolbar buttons and menu items)
  'new': `${FILE}<path d="M12 11v6M9 14h6"/>`,
  'new-window': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M12 12v5M9.5 14.5h5"/>',
  'open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 7v11a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4l2.1-6.3A1 1 0 0 0 20.6 11H7.4a2 2 0 0 0-1.9 1.4L3 20"/>',
  'save': SAVE,
  'save-as': '<path d="M11 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v3"/><path d="M7 3v5h8V3M7 21v-7h4"/><path d="m18.5 13.5 2 2-5.5 5.5h-2v-2z"/>',
  'toggle-tables': '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  'add-table': '<path d="M12 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 9h18M9 9v12M18 15v6M15 18h6"/>',
  'add-link': '<rect x="2" y="3" width="7" height="6" rx="1"/><rect x="15" y="15" width="7" height="6" rx="1"/><path d="M5.5 9v5a4 4 0 0 0 4 4H15"/>',
  'delete': '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  'undo': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'redo': '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  'zoom-out': `${MAGNIFIER}<path d="M8 11h6"/>`,
  'zoom-in': `${MAGNIFIER}<path d="M8 11h6M11 8v6"/>`,
  'fit': CORNERS,
  'auto-layout': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  'toggle-grid': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  'toggle-snap': '<path d="M6 15a6 6 0 0 0 12 0V4h-4v11a2 2 0 0 1-4 0V4H6z"/><path d="M6 8h4M14 8h4"/>',
  'db-connect': DATABASE,
  'db-import': '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  'db-compare': '<path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>',
  'toggle-sql': '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  'export-sql': `${FILE}<path d="m10 12-2 2.5 2 2.5M14 12l2 2.5-2 2.5"/>`,
  'export-svg': '<path d="m12 19 7-7 3 3-7 7z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="m2 2 7.6 7.6"/><circle cx="11" cy="11" r="2"/>',
  'export-png': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',

  // Keys
  'pk': '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2.5 2.5"/>',
  'fk': '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',

  // General actions
  'plus': '<path d="M12 5v14M5 12h14"/>',
  'close': CLOSE,
  'copy': '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  'cut': '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  'paste': '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  'select-all': '<path d="M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M21 19a2 2 0 0 1-2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1"/>',
  'check-all': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
  'check-none': '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  'refresh': '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  'reset': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  'test': '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  'run': '<path d="M6 4v16l14-8z"/>',
  'go': '<path d="M5 12h14M12 5l7 7-7 7"/>',
  'up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  'ok': '<path d="M20 6 9 17l-5-5"/>',
  'fullscreen': CORNERS,
  'devtools': '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  'about': '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  'quit': '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
};

export function iconMarkup(name, cls = 'btn-icon') {
  const inner = ICONS[name];
  if (!inner) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" `
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
