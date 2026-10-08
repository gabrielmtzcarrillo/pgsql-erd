// Electron main process: windows, menus, native file dialogs and file I/O.

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerWorkbench } = require('./ipc/workbench-ipc.cjs');
const { sharedDir } = require('./shared.cjs');

const windows = new Set();
let pendingOpen = []; // files requested before the app was ready (macOS open-file)

// App settings in <userData>/settings.json:
// { locale: 'system' | 'en' | 'es', theme: 'system' | 'white' | 'dark' | 'vs' | 'winme' }.
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() {
  try {
    settings = JSON.parse(fsSync.readFileSync(settingsPath(), 'utf8')) ?? {};
  } catch {
    settings = {};
  }
}
function saveSettings() {
  fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8').catch(() => {});
}

// Translations (src/shared/i18n.js), loaded when the app is ready.
let i18n = null;
const tr = (text, params) => (i18n ? i18n.tr(text, params) : text);
const systemLocale = () => app.getPreferredSystemLanguages?.()[0] ?? app.getLocale();
let relaunchOnQuit = false;

// A language picked in View → Language also applies to Chromium: number and
// date formats in the page, and its built-in menus. Must be set before ready.
loadSettings();
if (settings.locale && settings.locale !== 'system') app.commandLine.appendSwitch('lang', settings.locale);

// View → Theme. Each theme is drawn on a light or dark base, which also sets
// Chromium's colour scheme (scrollbars, native controls, Monaco) and the
// menu icon variant. The page applies the theme's own colours.
const THEMES = {
  system: { base: 'system', label: () => tr('System theme') },
  white: { base: 'light', label: () => tr('White'), background: '#f4f5f7' },
  dark: { base: 'dark', label: () => tr('Dark'), background: '#16181d' },
  vs: { base: 'light', label: () => 'Visual Studio', background: '#ccd5f0' },
  winme: { base: 'light', label: () => 'Windows ME', background: '#d4d0c8' },
};
const themeChoice = () => (THEMES[settings.theme] ? settings.theme : 'system');
const themeBackground = () =>
  THEMES[themeChoice()].background ?? (nativeTheme.shouldUseDarkColors ? THEMES.dark.background : THEMES.white.background);
nativeTheme.themeSource = THEMES[themeChoice()].base;

// Packaged builds take their icon from the executable / bundle. When running
// from source (npm start), point Electron at the icon in build/ instead.
const devIcon = app.isPackaged
  ? undefined
  : path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function pgerdArgs(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.pgerd'))
    .map((a) => path.resolve(a));
}

function createWindow(filePath = null) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'pgsql-erd',
    backgroundColor: themeBackground(),
    icon: devIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The page reads its language from here (see preload.cjs).
      additionalArguments: [`--pgsql-erd-locale=${i18n?.getLocale() ?? 'en'}`, `--pgsql-erd-theme=${themeChoice()}`],
    },
  });
  windows.add(win);
  win.state = { dirty: false, forceClose: false };

  // The renderer sets the title through setState; ignore the page <title>.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    if (filePath) openFileInWindow(win, filePath);
  });

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!win.state.dirty || win.state.forceClose) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: [tr('Save'), tr("Don't Save"), tr('Cancel')],
      defaultId: 0,
      cancelId: 2,
      message: tr('Do you want to save the changes to this diagram?'),
      detail: tr("Your changes will be lost if you don't save them."),
    });
    if (choice === 2) {
      e.preventDefault();
      relaunchOnQuit = false;
    } else if (choice === 0) {
      e.preventDefault();
      send(win, 'menu', 'save-and-close');
    }
  });
  const contentsId = win.webContents.id;
  win.on('closed', () => {
    windows.delete(win);
    workbench.windowClosed(contentsId).catch(() => {});
  });
  return win;
}

function send(win, channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function focusedWindow() {
  return BrowserWindow.getFocusedWindow() ?? [...windows][0] ?? null;
}

// Recently opened or saved diagrams, newest first, kept in settings.json.
// File → Open Recent and the empty diagram's start screen list them.
const RECENT_MAX = 10;
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const recentFiles = () => (Array.isArray(settings.recentFiles) ? settings.recentFiles : []);

function setRecentFiles(list) {
  settings.recentFiles = list.slice(0, RECENT_MAX);
  saveSettings();
  buildMenu();
  for (const win of windows) send(win, 'recent-files', recentFiles());
}

function addRecentFile(filePath) {
  app.addRecentDocument(filePath);
  setRecentFiles([filePath, ...recentFiles().filter((f) => !samePath(f, filePath))]);
}

function removeRecentFile(filePath) {
  setRecentFiles(recentFiles().filter((f) => !samePath(f, filePath)));
}

function clearRecentFiles() {
  app.clearRecentDocuments();
  setRecentFiles([]);
}

async function openFileInWindow(win, filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    send(win, 'file-opened', { filePath, text });
    addRecentFile(filePath);
  } catch (err) {
    // A recent file that was moved or deleted drops off the list.
    if (err.code === 'ENOENT') removeRecentFile(filePath);
    dialog.showErrorBox(tr('Could not open file'), `${filePath}\n\n${err.message}`);
  }
}

// Open in the focused window when it is an untouched empty diagram, otherwise a new window.
async function openFile(filePath) {
  const win = focusedWindow();
  if (win) {
    const isEmpty = await win.webContents.executeJavaScript('window.erdIsPristine?.() ?? false');
    if (isEmpty) return openFileInWindow(win, filePath);
  }
  createWindow(filePath);
}

async function showOpenDialog(win) {
  const res = await dialog.showOpenDialog(win, {
    title: tr('Open ERD'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'pgAdmin ERD', extensions: ['pgerd'] },
      { name: tr('All Files'), extensions: ['*'] },
    ],
  });
  if (!res.canceled) for (const f of res.filePaths) await openFile(f);
}

ipcMain.handle('open-dialog', (e) => showOpenDialog(BrowserWindow.fromWebContents(e.sender)));

ipcMain.handle('recent-files', () => recentFiles());
// Opens a file from the recent list in the asking window; the page asks about
// unsaved changes when the file arrives. Only listed paths are opened.
ipcMain.handle('recent-open', (e, filePath) => {
  const known = recentFiles().find((f) => samePath(f, String(filePath)));
  if (known) openFileInWindow(BrowserWindow.fromWebContents(e.sender), known);
});
ipcMain.handle('recent-remove', (e, filePath) => removeRecentFile(String(filePath)));
ipcMain.handle('recent-clear', () => clearRecentFiles());

// Pick a spreadsheet for "Import from Excel"; the renderer parses its bytes.
ipcMain.handle('open-spreadsheet', async (e) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: tr('Import tables from Excel / CSV'),
    properties: ['openFile'],
    filters: [
      { name: tr('Spreadsheets'), extensions: ['xlsx', 'xlsm', 'csv', 'tsv'] },
      { name: tr('All Files'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  return { filePath, data: new Uint8Array(await fs.readFile(filePath)) };
});

// Pick a .sql file for the query tab and return its text.
const MAX_SQL_FILE = 20 * 1024 * 1024;
ipcMain.handle('open-sql', async (e) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: tr('Open SQL File'),
    properties: ['openFile'],
    filters: [
      { name: 'SQL', extensions: ['sql', 'pgsql', 'psql'] },
      { name: tr('All Files'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  if ((await fs.stat(filePath)).size > MAX_SQL_FILE) throw new Error(tr('The file is too large for the query editor (over 20 MB).'));
  return { filePath, text: (await fs.readFile(filePath, 'utf8')).replace(/^﻿/, '') };
});

ipcMain.handle('save-file', async (e, { filePath, text, saveAs, defaultName, kind }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const filters = {
    pgerd: [{ name: 'pgAdmin ERD', extensions: ['pgerd'] }],
    sql: [{ name: 'SQL', extensions: ['sql'] }],
    svg: [{ name: tr('SVG Image'), extensions: ['svg'] }],
  }[kind ?? 'pgerd'];
  let target = saveAs ? null : filePath;
  if (!target) {
    const res = await dialog.showSaveDialog(win, {
      title: kind === 'pgerd' || !kind ? tr('Save ERD') : tr('Export'),
      defaultPath: defaultName,
      filters,
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  await fs.writeFile(target, text, 'utf8');
  if (!kind || kind === 'pgerd') addRecentFile(target);
  return target;
});

ipcMain.handle('save-binary', async (e, { defaultName, data, name, extensions }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showSaveDialog(win, {
    title: tr('Export'),
    defaultPath: defaultName,
    filters: [{ name, extensions }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data));
  return res.filePath;
});

// Database connections, scripts, the assistant and the audit log.
const workbench = registerWorkbench({ ipcMain, app, safeStorage, shell });

ipcMain.handle('confirm', (e, { message, detail, buttons }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  buttons ??= [tr('OK'), tr('Cancel')];
  return dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    message,
    detail,
  });
});

ipcMain.on('state', (e, { dirty, title }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.state.dirty = !!dirty;
  win.setDocumentEdited?.(!!dirty);
  if (title) win.setTitle(title);
});

ipcMain.on('close-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.state.forceClose = true;
  win.close();
});

// Menu item icons, rendered from src/renderer/icons.js by `npm run menu-icons`,
// in the variant that suits the menu's light or dark background.
function menuIcon(name) {
  const variant = nativeTheme.shouldUseDarkColors ? '-dark' : '';
  const image = nativeImage.createFromPath(path.join(__dirname, 'menu-icons', `${name}${variant}.png`));
  return image.isEmpty() ? undefined : image;
}

// View → Language: the system's language or a fixed one. Menus switch at
// once; open windows switch when the app restarts.
function languageMenu() {
  const choice = settings.locale ?? 'system';
  const item = (code, label) => ({
    label,
    type: 'radio',
    checked: choice === code,
    click: () => setLanguage(code),
  });
  return [
    item('system', tr('System default')),
    { type: 'separator' },
    ...Object.entries(i18n?.LOCALES ?? { en: 'English' }).map(([code, name]) => item(code, name)),
  ];
}

function setLanguage(code) {
  const before = i18n.getLocale();
  settings.locale = code;
  saveSettings();
  i18n.setLocale(i18n.resolveLocale(code, systemLocale()));
  buildMenu();
  if (i18n.getLocale() === before || !windows.size) return;
  const choice = dialog.showMessageBoxSync(focusedWindow(), {
    type: 'info',
    buttons: [tr('Restart now'), tr('Later')],
    defaultId: 0,
    cancelId: 1,
    message: tr('The language changes when pgsql-erd restarts.'),
    detail: tr('Open windows keep their language until then. You will be asked about unsaved changes.'),
  });
  if (choice === 0) {
    relaunchOnQuit = true;
    app.quit();
  }
}

function themeMenu() {
  const choice = themeChoice();
  return Object.entries(THEMES).flatMap(([name, t]) => [
    { label: t.label(), type: 'radio', checked: choice === name, click: () => setTheme(name) },
    ...(name === 'system' ? [{ type: 'separator' }] : []),
  ]);
}

// Applies at once in every window; the menu is rebuilt by nativeTheme's 'updated' event
// when the base changes, and here for the radio check.
function setTheme(name) {
  settings.theme = name;
  saveSettings();
  nativeTheme.themeSource = THEMES[name].base;
  buildMenu();
  for (const win of windows) {
    win.setBackgroundColor(themeBackground());
    send(win, 'theme', name);
  }
}

// File → Open Recent. Labels escape '&', which marks mnemonics on Windows/Linux.
function recentMenu() {
  const files = recentFiles();
  return [
    ...(files.length
      ? files.map((f, i) => ({
          label: `${i < 9 ? `&${i + 1} ` : ''}${f.replace(/&/g, '&&')}`,
          click: () => openFile(f),
        }))
      : [{ label: tr('No recent files'), enabled: false }]),
    { type: 'separator' },
    { label: tr('Clear Recently Opened'), enabled: files.length > 0, click: clearRecentFiles },
  ];
}

function buildMenu() {
  const cmd = (name) => () => send(focusedWindow(), 'menu', name);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: tr('&File'),
      submenu: [
        { label: tr('New Diagram'), icon: menuIcon('new'), accelerator: 'CmdOrCtrl+N', click: cmd('new') },
        { label: tr('New Window'), icon: menuIcon('new-window'), accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: tr('Open…'), icon: menuIcon('open'), accelerator: 'CmdOrCtrl+O', click: () => showOpenDialog(focusedWindow()) },
        { label: tr('Open Recent'), submenu: recentMenu() },
        { label: tr('Open SQL File…'), icon: menuIcon('open'), accelerator: 'CmdOrCtrl+Alt+O', click: cmd('query-open') },
        { type: 'separator' },
        { label: tr('Save'), icon: menuIcon('save'), accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: tr('Save As…'), icon: menuIcon('save-as'), accelerator: 'CmdOrCtrl+Shift+S', click: cmd('save-as') },
        { type: 'separator' },
        { label: tr('Import from Excel / CSV…'), icon: menuIcon('import-spreadsheet'), accelerator: 'CmdOrCtrl+Alt+E', click: cmd('import-spreadsheet') },
        { type: 'separator' },
        { label: tr('Export SQL…'), icon: menuIcon('export-sql'), accelerator: 'CmdOrCtrl+Alt+S', click: cmd('export-sql') },
        { label: tr('Export SVG…'), icon: menuIcon('export-svg'), click: cmd('export-svg') },
        { label: tr('Export PNG…'), icon: menuIcon('export-png'), click: cmd('export-png') },
        { type: 'separator' },
        isMac ? { role: 'close', label: tr('Close Window'), icon: menuIcon('close') } : { role: 'quit', label: tr('Quit'), icon: menuIcon('quit') },
      ],
    },
    {
      label: tr('&Edit'),
      submenu: [
        // Native roles keep text-field undo working; the renderer handles
        // diagram undo/redo when no text field is focused.
        { role: 'undo', label: tr('Undo'), icon: menuIcon('undo') },
        { role: 'redo', label: tr('Redo'), icon: menuIcon('redo') },
        { type: 'separator' },
        { role: 'cut', label: tr('Cut'), icon: menuIcon('cut') },
        { role: 'copy', label: tr('Copy'), icon: menuIcon('copy') },
        { role: 'paste', label: tr('Paste'), icon: menuIcon('paste') },
        { role: 'selectAll', label: tr('Select All'), icon: menuIcon('select-all') },
        { type: 'separator' },
        { label: tr('Add Table'), icon: menuIcon('add-table'), accelerator: 'CmdOrCtrl+Alt+T', click: cmd('add-table') },
        { label: tr('Add Relationship…'), icon: menuIcon('add-link'), accelerator: 'CmdOrCtrl+Alt+R', click: cmd('add-link') },
      ],
    },
    {
      label: tr('&Database'),
      submenu: [
        { label: tr('Connect…'), icon: menuIcon('db-connect'), click: cmd('db-connect') },
        { label: tr('Refresh Schema'), icon: menuIcon('db-refresh'), accelerator: 'CmdOrCtrl+Alt+F5', click: cmd('db-refresh') },
        { label: tr('Import Tables from Database…'), icon: menuIcon('db-import'), accelerator: 'CmdOrCtrl+Alt+I', click: cmd('db-import') },
        { label: tr('Compare with Database / Generate Migration…'), icon: menuIcon('db-compare'), accelerator: 'CmdOrCtrl+Alt+D', click: cmd('db-compare') },
        { label: tr('Browse Table Data…'), icon: menuIcon('toggle-tables'), accelerator: 'CmdOrCtrl+Alt+B', click: cmd('data-browse') },
        { label: tr('Query Analyzer'), icon: menuIcon('toggle-sql'), accelerator: 'CmdOrCtrl+Alt+Q', click: cmd('query-tab') },
        { label: tr('New Query Tab'), icon: menuIcon('toggle-sql'), click: cmd('query-new') },
        { label: tr('Query Builder'), icon: menuIcon('query-builder'), accelerator: 'CmdOrCtrl+Alt+U', click: cmd('query-builder') },
        { label: tr('Graphs (Apache AGE)'), icon: menuIcon('add-link'), accelerator: 'CmdOrCtrl+Alt+H', click: cmd('graph-tab') },
        { type: 'separator' },
        { label: tr('Open Audit Log'), icon: menuIcon('audit-log'), click: () => workbench.openAuditLog() },
      ],
    },
    {
      label: tr('&Scripts'),
      submenu: [
        { label: tr('Scripts Tab'), icon: menuIcon('toggle-workbench'), accelerator: 'CmdOrCtrl+Alt+J', click: cmd('toggle-workbench') },
        { label: tr('New Script…'), icon: menuIcon('script-new'), accelerator: 'CmdOrCtrl+Alt+N', click: cmd('script-new') },
        { label: tr('Save Script'), icon: menuIcon('script-save'), click: cmd('script-save') },
        { type: 'separator' },
        { label: tr('Dry Run'), icon: menuIcon('script-dry-run'), accelerator: 'F6', click: cmd('script-dry-run') },
        { label: tr('Run'), icon: menuIcon('script-run'), accelerator: 'F5', click: cmd('script-run') },
        { label: tr('Stop'), icon: menuIcon('script-stop'), accelerator: 'Shift+F5', click: cmd('script-stop') },
        { type: 'separator' },
        { label: tr('AI Assistant'), icon: menuIcon('ai-assistant'), accelerator: 'CmdOrCtrl+Alt+A', click: cmd('ai-assistant') },
        { label: tr('AI Providers…'), icon: menuIcon('ai-settings'), click: cmd('ai-settings') },
      ],
    },
    {
      label: tr('&View'),
      submenu: [
        { label: tr('Diagram Tab'), icon: menuIcon('toggle-tables'), accelerator: 'CmdOrCtrl+Alt+1', click: cmd('tab-erd') },
        { label: tr('Show Scripts in Diagram'), icon: menuIcon('toggle-workbench'), click: cmd('toggle-erd-scripts') },
        { type: 'separator' },
        { label: tr('Zoom In'), icon: menuIcon('zoom-in'), accelerator: 'CmdOrCtrl+=', click: cmd('zoom-in') },
        { label: tr('Zoom Out'), icon: menuIcon('zoom-out'), accelerator: 'CmdOrCtrl+-', click: cmd('zoom-out') },
        { label: tr('Fit to Window'), icon: menuIcon('fit'), accelerator: 'CmdOrCtrl+0', click: cmd('fit') },
        { label: tr('Auto Layout'), icon: menuIcon('auto-layout'), accelerator: 'CmdOrCtrl+L', click: cmd('auto-layout') },
        { label: tr('Show Grid'), icon: menuIcon('toggle-grid'), accelerator: 'CmdOrCtrl+Alt+G', click: cmd('toggle-grid') },
        { label: tr('Snap to Grid'), icon: menuIcon('toggle-snap'), accelerator: 'CmdOrCtrl+Shift+G', click: cmd('toggle-snap') },
        { label: tr('Show SQL Preview'), icon: menuIcon('toggle-sql'), accelerator: 'CmdOrCtrl+Alt+P', click: cmd('toggle-sql') },
        { type: 'separator' },
        { label: tr('Language'), icon: menuIcon('about'), submenu: languageMenu() },
        { label: tr('Theme'), submenu: themeMenu() },
        { type: 'separator' },
        { role: 'toggleDevTools', label: tr('Toggle Developer Tools'), icon: menuIcon('devtools') },
        { role: 'togglefullscreen', label: tr('Toggle Full Screen'), icon: menuIcon('fullscreen') },
      ],
    },
    {
      role: 'help',
      label: tr('&Help'),
      submenu: [
        {
          label: tr('About pgsql-erd'),
          icon: menuIcon('about'),
          click: () =>
            dialog.showMessageBox(focusedWindow(), {
              message: `pgsql-erd ${app.getVersion()}`,
              detail: tr('ERD tool for PostgreSQL. Opens and saves pgAdmin 4 .pgerd files.'),
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// macOS delivers files opened from Finder / the dock through this event.
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (app.isReady()) openFile(filePath);
  else pendingOpen.push(filePath);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const files = pgerdArgs(argv);
    if (files.length) files.forEach(openFile);
    else focusedWindow()?.focus();
  });

  // Restart after a language change, once every window has closed.
  app.on('will-quit', () => {
    if (relaunchOnQuit) app.relaunch();
  });

  app.whenReady().then(async () => {
    i18n = await import(pathToFileURL(path.join(sharedDir, 'i18n.js')).href);
    i18n.setLocale(i18n.resolveLocale(settings.locale, systemLocale()));
    // macOS ignores the window icon; the dock shows it instead.
    if (devIcon && process.platform === 'darwin') app.dock?.setIcon(devIcon);
    buildMenu();
    // Swap menu icons between the light and dark variants with the theme.
    nativeTheme.on('updated', buildMenu);
    const files = [...pendingOpen, ...pgerdArgs(process.argv)];
    pendingOpen = [];
    if (files.length) files.forEach((f) => createWindow(f));
    else createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
