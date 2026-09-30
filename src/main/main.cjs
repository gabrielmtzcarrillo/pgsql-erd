// Electron main process: windows, menus, native file dialogs and file I/O.

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, nativeTheme, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('./db.cjs');

const windows = new Set();
let pendingOpen = []; // files requested before the app was ready (macOS open-file)

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
    backgroundColor: '#f4f5f7',
    icon: devIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save the changes to this diagram?',
      detail: "Your changes will be lost if you don't save them.",
    });
    if (choice === 2) {
      e.preventDefault();
    } else if (choice === 0) {
      e.preventDefault();
      send(win, 'menu', 'save-and-close');
    }
  });
  win.on('closed', () => windows.delete(win));
  return win;
}

function send(win, channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function focusedWindow() {
  return BrowserWindow.getFocusedWindow() ?? [...windows][0] ?? null;
}

async function openFileInWindow(win, filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    send(win, 'file-opened', { filePath, text });
    app.addRecentDocument(filePath);
  } catch (err) {
    dialog.showErrorBox('Could not open file', `${filePath}\n\n${err.message}`);
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
    title: 'Open ERD',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'pgAdmin ERD', extensions: ['pgerd'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (!res.canceled) for (const f of res.filePaths) await openFile(f);
}

ipcMain.handle('open-dialog', (e) => showOpenDialog(BrowserWindow.fromWebContents(e.sender)));

// Pick a spreadsheet for "Import from Excel"; the renderer parses its bytes.
ipcMain.handle('open-spreadsheet', async (e) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Import tables from Excel / CSV',
    properties: ['openFile'],
    filters: [
      { name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'csv', 'tsv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  return { filePath, data: new Uint8Array(await fs.readFile(filePath)) };
});

ipcMain.handle('save-file', async (e, { filePath, text, saveAs, defaultName, kind }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const filters = {
    pgerd: [{ name: 'pgAdmin ERD', extensions: ['pgerd'] }],
    sql: [{ name: 'SQL', extensions: ['sql'] }],
    svg: [{ name: 'SVG Image', extensions: ['svg'] }],
  }[kind ?? 'pgerd'];
  let target = saveAs ? null : filePath;
  if (!target) {
    const res = await dialog.showSaveDialog(win, {
      title: kind === 'pgerd' || !kind ? 'Save ERD' : 'Export',
      defaultPath: defaultName,
      filters,
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  await fs.writeFile(target, text, 'utf8');
  if (!kind || kind === 'pgerd') app.addRecentDocument(target);
  return target;
});

ipcMain.handle('save-binary', async (e, { defaultName, data, name, extensions }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: defaultName,
    filters: [{ name, extensions }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data));
  return res.filePath;
});

// Database access. Errors are returned as values so the renderer can show
// the server's message instead of Electron's wrapped IPC error.
const dbCall = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, result: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
};
ipcMain.handle('db-test', dbCall((conn) => db.testConnection(conn)));
ipcMain.handle('db-introspect', dbCall((conn) => db.introspect(conn)));
ipcMain.handle('db-execute', dbCall((conn, sql) => db.execute(conn, sql)));

ipcMain.handle('confirm', (e, { message, detail, buttons }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: buttons ?? ['OK', 'Cancel'],
    defaultId: 0,
    cancelId: (buttons ?? ['OK', 'Cancel']).length - 1,
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

function buildMenu() {
  const cmd = (name) => () => send(focusedWindow(), 'menu', name);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'New Diagram', icon: menuIcon('new'), accelerator: 'CmdOrCtrl+N', click: cmd('new') },
        { label: 'New Window', icon: menuIcon('new-window'), accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: 'Open…', icon: menuIcon('open'), accelerator: 'CmdOrCtrl+O', click: () => showOpenDialog(focusedWindow()) },
        ...(isMac ? [{ role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] }] : []),
        { type: 'separator' },
        { label: 'Save', icon: menuIcon('save'), accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'Save As…', icon: menuIcon('save-as'), accelerator: 'CmdOrCtrl+Shift+S', click: cmd('save-as') },
        { type: 'separator' },
        { label: 'Import from Excel / CSV…', icon: menuIcon('import-spreadsheet'), accelerator: 'CmdOrCtrl+Alt+E', click: cmd('import-spreadsheet') },
        { type: 'separator' },
        { label: 'Export SQL…', icon: menuIcon('export-sql'), accelerator: 'CmdOrCtrl+Alt+S', click: cmd('export-sql') },
        { label: 'Export SVG…', icon: menuIcon('export-svg'), click: cmd('export-svg') },
        { label: 'Export PNG…', icon: menuIcon('export-png'), click: cmd('export-png') },
        { type: 'separator' },
        isMac ? { role: 'close', icon: menuIcon('close') } : { role: 'quit', icon: menuIcon('quit') },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        // Native roles keep text-field undo working; the renderer handles
        // diagram undo/redo when no text field is focused.
        { role: 'undo', icon: menuIcon('undo') },
        { role: 'redo', icon: menuIcon('redo') },
        { type: 'separator' },
        { role: 'cut', icon: menuIcon('cut') },
        { role: 'copy', icon: menuIcon('copy') },
        { role: 'paste', icon: menuIcon('paste') },
        { role: 'selectAll', icon: menuIcon('select-all') },
        { type: 'separator' },
        { label: 'Add Table', icon: menuIcon('add-table'), accelerator: 'CmdOrCtrl+Alt+T', click: cmd('add-table') },
        { label: 'Add Relationship…', icon: menuIcon('add-link'), accelerator: 'CmdOrCtrl+Alt+R', click: cmd('add-link') },
      ],
    },
    {
      label: '&Database',
      submenu: [
        { label: 'Connect…', icon: menuIcon('db-connect'), click: cmd('db-connect') },
        { label: 'Import Tables from Database…', icon: menuIcon('db-import'), accelerator: 'CmdOrCtrl+Alt+I', click: cmd('db-import') },
        { label: 'Compare with Database / Generate Migration…', icon: menuIcon('db-compare'), accelerator: 'CmdOrCtrl+Alt+D', click: cmd('db-compare') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom In', icon: menuIcon('zoom-in'), accelerator: 'CmdOrCtrl+=', click: cmd('zoom-in') },
        { label: 'Zoom Out', icon: menuIcon('zoom-out'), accelerator: 'CmdOrCtrl+-', click: cmd('zoom-out') },
        { label: 'Fit to Window', icon: menuIcon('fit'), accelerator: 'CmdOrCtrl+0', click: cmd('fit') },
        { label: 'Auto Layout', icon: menuIcon('auto-layout'), accelerator: 'CmdOrCtrl+L', click: cmd('auto-layout') },
        { label: 'Show Grid', icon: menuIcon('toggle-grid'), accelerator: 'CmdOrCtrl+Alt+G', click: cmd('toggle-grid') },
        { label: 'Snap to Grid', icon: menuIcon('toggle-snap'), accelerator: 'CmdOrCtrl+Shift+G', click: cmd('toggle-snap') },
        { label: 'Show SQL Preview', icon: menuIcon('toggle-sql'), accelerator: 'CmdOrCtrl+Alt+P', click: cmd('toggle-sql') },
        { type: 'separator' },
        { role: 'toggleDevTools', icon: menuIcon('devtools') },
        { role: 'togglefullscreen', icon: menuIcon('fullscreen') },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About pgsql-erd',
          icon: menuIcon('about'),
          click: () =>
            dialog.showMessageBox(focusedWindow(), {
              message: `pgsql-erd ${app.getVersion()}`,
              detail: 'ERD tool for PostgreSQL. Opens and saves pgAdmin 4 .pgerd files.',
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

  app.whenReady().then(() => {
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
