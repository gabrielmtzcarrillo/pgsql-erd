// Toolbar icons: 24x24 stroked outlines drawn with currentColor, keyed by the
// button's data-cmd. Each value is the inner SVG markup.

const FILE = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
const MAGNIFIER = '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>';

export const ICONS = {
  'new': `${FILE}<path d="M12 11v6M9 14h6"/>`,
  'open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 7v11a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4l2.1-6.3A1 1 0 0 0 20.6 11H7.4a2 2 0 0 0-1.9 1.4L3 20"/>',
  'save': '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  'toggle-tables': '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  'add-table': '<path d="M12 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 9h18M9 9v12M18 15v6M15 18h6"/>',
  'add-link': '<rect x="2" y="3" width="7" height="6" rx="1"/><rect x="15" y="15" width="7" height="6" rx="1"/><path d="M5.5 9v5a4 4 0 0 0 4 4H15"/>',
  'delete': '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  'undo': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'redo': '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  'zoom-out': `${MAGNIFIER}<path d="M8 11h6"/>`,
  'zoom-in': `${MAGNIFIER}<path d="M8 11h6M11 8v6"/>`,
  'fit': '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  'auto-layout': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  'toggle-grid': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  'toggle-snap': '<path d="M6 15a6 6 0 0 0 12 0V4h-4v11a2 2 0 0 1-4 0V4H6z"/><path d="M6 8h4M14 8h4"/>',
  'db-connect': '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  'db-import': '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  'db-compare': '<path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>',
  'toggle-sql': '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  'export-sql': `${FILE}<path d="m10 12-2 2.5 2 2.5M14 12l2 2.5-2 2.5"/>`,
  'export-svg': '<path d="m12 19 7-7 3 3-7 7z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="m2 2 7.6 7.6"/><circle cx="11" cy="11" r="2"/>',
  'export-png': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
};

// Prepend an icon to every button with a known data-cmd inside `root`, and
// wrap its text in a .label span so the label can be changed without
// removing the icon. Buttons with no text become icon-only.
export function decorateButtons(root) {
  for (const btn of root.querySelectorAll('button[data-cmd]')) {
    const inner = ICONS[btn.dataset.cmd];
    if (!inner) continue;
    const text = btn.textContent.trim();
    btn.textContent = '';
    btn.insertAdjacentHTML('afterbegin',
      `<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" `
      + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`);
    if (text) {
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = text;
      btn.append(label);
    } else {
      btn.classList.add('icon-only');
      btn.setAttribute('aria-label', btn.title);
    }
  }
}
