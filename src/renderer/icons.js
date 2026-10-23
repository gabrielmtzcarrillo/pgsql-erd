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
  'block-split': `<rect ${F} x="3" y="9" width="6" height="6" rx="1"/><path d="M9 12h4M13 12l4-6M13 12h8M13 12l4 6"/>`,
  'block-case': `<path d="M2 18 7 6l5 12M4 14h6"/><circle ${F} cx="18" cy="14.5" r="3.5"/><path d="M21.5 11v7"/>`,
  'block-map': `<rect ${F} x="3" y="3" width="8" height="8" rx="1"/><rect ${F} x="13" y="13" width="8" height="8" rx="1"/><path d="M14 7h4a2 2 0 0 1 2 2v2M10 17H6a2 2 0 0 1-2-2v-2"/>`,
  'block-convert': `<path ${F} d="M4 4h9v9H4z"/><path d="M17 11l3 3-3 3M20 14h-5M7 20l-3-3 3-3M4 17h5"/>`,
  'block-choice': `<rect ${F} x="3" y="5" width="18" height="6" rx="1.5"/><path d="m16 7.2 1.5 1.6L19 7.2M3 15h18M3 19h12"/>`,
  'block-lookup': `${MAGNIFIER}<circle cx="11" cy="11" r="1.6"/>`,
  'block-join': `<rect ${F} x="2" y="4" width="8" height="5" rx="1"/><rect ${F} x="2" y="15" width="8" height="5" rx="1"/><path d="M10 6.5h3l4 5.5M10 17.5h3l4-5.5M17 12h5"/>`,
  'block-constant': `<rect ${F} x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`,
  'block-clean': `<path ${F} d="M14 3l7 7-8 8-4-1-1-4z"/><path d="M4 21l4-4M7 14l3 3"/>`,
  'block-extract': `<path d="M8 4H5v16h3M16 4h3v16h-3"/><path ${F} d="M9 9h6v6H9z"/>`,
  'block-default': `<rect ${F} x="3" y="6" width="18" height="12" rx="2" stroke-dasharray="3 2"/><path d="M8 12h8"/>`,
  'import-designer': `<rect ${F} x="2" y="3" width="11" height="10" rx="1.5"/><path d="M2 7h11M2 10h11M6.5 3v10"/><path ${F} d="M12.5 15.5v4.5c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8v-4.5"/><ellipse cx="17" cy="15.5" rx="4.5" ry="1.8"/><path d="M12.5 18c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8M7.5 13v6h3.5M9.5 17.5l1.8 1.5-1.8 1.5"/>`,
  'import-spreadsheet': `<path ${F} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6H3z"/><path d="M13 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 9h18M9 3v18M3 15h6M18 14v7M15 18l3 3 3-3"/>`,
  'db-connect': DATABASE,
  'db-import': `<path ${F} d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4z"/><path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/>`,
  'db-compare': '<path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>',
  'toggle-db-tree': `<rect ${F} x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="10" width="7" height="5" rx="1"/><rect x="14" y="17" width="7" height="5" rx="1"/><path d="M6.5 9v10.5H14M6.5 12.5H14"/>`,
  'toggle-sql': `${SQUARE}<path d="m14 9 3 3-3 3M10 9l-3 3 3 3"/>`,
  'query-builder': `<rect ${F} x="2" y="3" width="9" height="8" rx="1"/><path d="M2 6.5h9"/><rect ${F} x="13" y="13" width="9" height="8" rx="1"/><path d="M13 16.5h9M6.5 11v6.5H13"/><path d="m14.5 6 2 2 4-4"/>`,
  'graph': `<circle ${F} cx="6" cy="6" r="3"/><circle ${F} cx="18" cy="8" r="3"/><circle ${F} cx="9" cy="18" r="3"/><path d="M9 6.3l6 1.3M6.8 8.9l1.4 6.2M16 10.3l-5 5.4"/>`,
  'export-sql': `${FILE}<path d="m10 12-2 2.5 2 2.5M14 12l2 2.5-2 2.5"/>`,
  'export-svg': `<path ${F} d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="m12 19 7-7 3 3-7 7z"/><path d="m2 2 7.6 7.6"/><circle cx="11" cy="11" r="2"/>`,
  'export-png': `${SQUARE}<circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>`,

  'db-refresh': `<path ${F} d="M3 5v11c0 1.4 3.1 2.5 7 2.5M17 5v4"/><ellipse cx="10" cy="5" rx="7" ry="2.5"/><path d="M3 10.5c0 1.4 3.1 2.5 7 2.5M22 17a4 4 0 0 1-7 2.6M14 17a4 4 0 0 1 7-2.6M21.5 12v2.6H19M14.5 22v-2.4H17"/>`,
  'audit-log': `${FILE}<path d="M8 13h8M8 17h5"/><circle cx="17" cy="17" r="0.5"/>`,

  // Scripts and assistant
  'toggle-workbench': `${SQUARE}<path d="M3 14h18M7 18h.01M7 8l3 2-3 2M12 12h4"/>`,
  'script-new': `${FILE}<path d="m9 13-1.5 1.5L9 16M13 13l1.5 1.5L13 16"/><path d="M17 18v4M15 20h4"/>`,
  'script-save': `<path ${F} d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="m9 11-2 2 2 2M15 11l2 2-2 2"/>`,
  'script-run': `<path ${F} d="M6 4v16l14-8z"/>`,
  'script-dry-run': `<path ${F} d="M5 4v16l11-8z"/><path d="M18 8.5a5 5 0 0 1 0 7" stroke-dasharray="2 2"/><path d="M20.5 6a8.5 8.5 0 0 1 0 12" stroke-dasharray="2 2"/>`,
  'script-stop': `<rect ${F} x="5" y="5" width="14" height="14" rx="2"/>`,
  'ai-assistant': `<path ${F} d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 14.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8zM5 16l.6 1.4L7 18l-1.4.6L5 20l-.6-1.4L3 18l1.4-.6z"/>`,
  'ai-settings': `<path ${F} d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>`,
  'permissions': `<path ${F} d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>`,
  'commit': `<circle ${F} cx="12" cy="12" r="4"/><path d="M3 12h5M16 12h5"/>`,
  'discard': `<path ${F} d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M9 9l6 6M15 9l-6 6"/>`,
  'send': `<path ${F} d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>`,
  'validator': `<path ${F} d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>`,
  'insert': `${SQUARE}<path d="M12 8v8M8 12h8"/>`,

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
  'suggest': '<path d="m15 4 5 5L9 20H4v-5z"/><path d="M19 2v3M17.5 3.5h3M5 3v2M4 4h2"/>',
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

// Icons a table can show in its header, chosen in the table editor; kept
// apart from ICONS so they are not rendered as menu icons. Labels are in
// English and translated where shown.
export const TABLE_ICONS = {
  'user': { label: 'User', svg: `<circle ${F} cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>` },
  'users': { label: 'Users', svg: `<circle ${F} cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.1a4 4 0 0 1 0 7.8M22 21v-1a6 6 0 0 0-4-5.6"/>` },
  'building': { label: 'Organization', svg: `<rect ${F} x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>` },
  'home': { label: 'Home', svg: `<path ${F} d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>` },
  'cart': { label: 'Cart', svg: `<path ${F} d="M6 6h15l-2 8H8z"/><path d="M2 3h3l3 11"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>` },
  'package': { label: 'Product', svg: `<path ${F} d="m21 8-9-5-9 5v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>` },
  'tag': { label: 'Tag', svg: `<path ${F} d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1.5"/>` },
  'receipt': { label: 'Invoice', svg: `<path ${F} d="M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>` },
  'money': { label: 'Money', svg: `<rect ${F} x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>` },
  'card': { label: 'Payment', svg: `<rect ${F} x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>` },
  'calendar': { label: 'Calendar', svg: `<rect ${F} x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>` },
  'clock': { label: 'Time', svg: `<circle ${F} cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>` },
  'event': { label: 'Event', svg: `<path ${F} d="M13 2 3 14h9l-1 8 10-12h-9z"/>` },
  'task': { label: 'Task', svg: `${SQUARE}<path d="m8 12 3 3 5-6"/>` },
  'location': { label: 'Location', svg: `<path ${F} d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>` },
  'globe': { label: 'Globe', svg: `<circle ${F} cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>` },
  'truck': { label: 'Shipping', svg: `<path ${F} d="M2 6h12v10H2z"/><path d="M14 9h4l4 4v3h-8"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>` },
  'mail': { label: 'Mail', svg: `<rect ${F} x="2" y="5" width="20" height="14" rx="2"/><path d="m2 7 10 6 10-6"/>` },
  'phone': { label: 'Phone', svg: `<path ${F} d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>` },
  'message': { label: 'Message', svg: `<path ${F} d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>` },
  'bell': { label: 'Notification', svg: `<path ${F} d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>` },
  'document': { label: 'Document', svg: `${FILE}<path d="M8 13h8M8 17h6"/>` },
  'book': { label: 'Book', svg: `<path ${F} d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>` },
  'folder': { label: 'Folder', svg: `<path ${F} d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>` },
  'image': { label: 'Image', svg: `${SQUARE}<circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>` },
  'star': { label: 'Star', svg: `<path ${F} d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z"/>` },
  'heart': { label: 'Favorite', svg: `<path ${F} d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11z"/>` },
  'bookmark': { label: 'Bookmark', svg: `<path ${F} d="M6 3h12v18l-6-4-6 4z"/>` },
  'flag': { label: 'Flag', svg: `<path ${F} d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>` },
  'chart': { label: 'Chart', svg: `<path d="M3 3v18h18"/><rect ${F} x="7" y="12" width="3" height="6"/><rect ${F} x="12" y="8" width="3" height="10"/><rect ${F} x="17" y="5" width="3" height="13"/>` },
  'list': { label: 'List', svg: `${SQUARE}<path d="M8 8h9M8 12h9M8 16h9M5.5 8h.01M5.5 12h.01M5.5 16h.01"/>` },
  'layers': { label: 'Layers', svg: `<path ${F} d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5M2 17l10 5 10-5"/>` },
  'database': { label: 'Database', svg: DATABASE },
  'code': { label: 'Code', svg: `${SQUARE}<path d="m14 9 3 3-3 3M10 9l-3 3 3 3"/>` },
  'braces': { label: 'JSON', svg: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>' },
  'hash': { label: 'Identifier', svg: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>' },
  'terminal': { label: 'Terminal', svg: `<rect ${F} x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3M12 15h5"/>` },
  'bug': { label: 'Bug', svg: `<rect ${F} x="7" y="7" width="10" height="14" rx="5"/><path d="M9 7a3 3 0 0 1 6 0M12 11v10M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 20l3-2M20 20l-3-2"/>` },
  'branch': { label: 'Branch', svg: `<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle ${F} cx="18" cy="7" r="2"/><path d="M6 7v10M18 9v1a4 4 0 0 1-4 4H8.5"/>` },
  'commit': { label: 'Version', svg: `<circle ${F} cx="12" cy="12" r="4"/><path d="M3 12h5M16 12h5"/>` },
  'test': { label: 'Testing', svg: `<path ${F} d="M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3z"/><path d="M8.5 3h7M7 15h10"/>` },
  'rocket': { label: 'Deployment', svg: `<path ${F} d="M12 15 9 12a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1zM9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/>` },
  'server': { label: 'Server', svg: `<rect ${F} x="3" y="3" width="18" height="8" rx="2"/><rect ${F} x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01"/>` },
  'cloud': { label: 'Cloud', svg: `<path ${F} d="M17.5 19H8a6 6 0 1 1 5.7-7.9A4.5 4.5 0 1 1 17.5 19z"/>` },
  'api': { label: 'API', svg: `<path ${F} d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/><path d="M12 22v-5M9 8V2M15 8V2"/>` },
  'workflow': { label: 'Workflow', svg: `<rect ${F} x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M6.5 10v4a3 3 0 0 0 3 3H14"/>` },
  'network': { label: 'Network', svg: `<rect ${F} x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/>` },
  'monitor': { label: 'Monitor', svg: `<rect ${F} x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>` },
  'smartphone': { label: 'Mobile', svg: `<rect ${F} x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>` },
  'cpu': { label: 'Processor', svg: `<rect ${F} x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>` },
  'sparkles': { label: 'AI', svg: `<path ${F} d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 14.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8zM5 16l.6 1.4L7 18l-1.4.6L5 20l-.6-1.4L3 18l1.4-.6z"/>` },
  'brain': { label: 'Brain', svg: `<path ${F} d="M12 5a3 3 0 0 0-5.9-.8A3 3 0 0 0 3.5 8.5 3.5 3.5 0 0 0 4 15a3 3 0 0 0 3 4 3 3 0 0 0 5 1zM12 5a3 3 0 0 1 5.9-.8 3 3 0 0 1 2.6 4.3A3.5 3.5 0 0 1 20 15a3 3 0 0 1-3 4 3 3 0 0 1-5 1"/><path d="M12 5v15"/>` },
  'bot': { label: 'Bot', svg: `<rect ${F} x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M10 4h4M2 14h2M20 14h2M9 13v2M15 13v2"/>` },
  'assistant': { label: 'Assistant', svg: `<path ${F} d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m12 6 .8 1.7 1.7.8-1.7.8L12 11l-.8-1.7-1.7-.8 1.7-.8z"/>` },
  'neural': { label: 'Neural network', svg: `<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle ${F} cx="12" cy="12" r="2.5"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="m6.6 7.3 3.5 3.1M6.6 16.7l3.5-3.1M13.9 10.4l3.5-3.1M13.9 13.6l3.5 3.1"/>` },
  'vector': { label: 'Embedding', svg: `<path d="M3 3v18h18"/><path d="m7 17 11-11M18 6h-5M18 6v5"/><circle ${F} cx="7" cy="17" r="1.5"/>` },
  'wand': { label: 'Magic', svg: `<path ${F} d="m14 8 2 2L5 21l-2-2z"/><path d="M15 4V2M15 10V8M11 6h2M17 6h2M18 3l1-1M18 9l1 1M12 3l-1-1"/>` },
  'lightbulb': { label: 'Idea', svg: `<path ${F} d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5z"/><path d="M9 18h6M10 22h4"/>` },
  'link': { label: 'Link', svg: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>' },
  'settings': { label: 'Settings', svg: `<path ${F} d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>` },
  'lock': { label: 'Lock', svg: `<rect ${F} x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>` },
  'key': { label: 'Key', svg: `<circle ${F} cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2.5 2.5"/>` },
  'shield': { label: 'Security', svg: `<path ${F} d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z"/>` },
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
  'import-spreadsheet': 'green', 'import-designer': 'blue', 'db-connect': 'green', 'db-import': 'green', 'db-compare': 'orange', 'toggle-db-tree': 'teal',
  'block-split': 'purple', 'block-case': 'blue', 'block-map': 'orange', 'block-convert': 'teal', 'block-choice': 'amber', 'block-lookup': 'blue',
  'block-join': 'green', 'block-constant': 'amber', 'block-clean': 'teal', 'block-extract': 'purple', 'block-default': 'blue',
  'toggle-sql': 'purple', 'query-builder': 'purple', 'graph': 'teal', 'export-sql': 'orange', 'export-svg': 'orange', 'export-png': 'green',
  'pk': 'amber', 'fk': 'blue',
  'plus': 'green', 'close': 'red', 'copy': 'blue', 'paste': 'amber', 'select-all': 'blue',
  'check-all': 'green', 'refresh': 'green', 'reset': 'blue', 'suggest': 'amber', 'test': 'amber', 'run': 'green',
  'go': 'blue', 'up': 'blue', 'down': 'blue', 'ok': 'green', 'fullscreen': 'teal',
  'about': 'blue', 'quit': 'red',
  'db-refresh': 'green', 'audit-log': 'amber', 'toggle-workbench': 'purple', 'script-new': 'blue',
  'script-save': 'purple', 'script-run': 'green', 'script-dry-run': 'teal', 'script-stop': 'red',
  'ai-assistant': 'purple', 'ai-settings': 'teal', 'permissions': 'amber', 'commit': 'green',
  'discard': 'red', 'send': 'blue', 'validator': 'green', 'insert': 'blue',
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

// A table icon (see TABLE_ICONS) in the text colour.
export function tableIconElement(name, cls = 'btn-icon') {
  const t = document.createElement('template');
  t.innerHTML = TABLE_ICONS[name]
    ? `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" `
      + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TABLE_ICONS[name].svg}</svg>`
    : '';
  return t.content.firstChild;
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
