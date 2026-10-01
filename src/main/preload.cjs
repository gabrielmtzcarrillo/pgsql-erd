// Narrow bridge between the sandboxed renderer and the main process.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The main process passes the language as --pgsql-erd-locale=<code>.
const locale = process.argv.find((a) => a.startsWith('--pgsql-erd-locale='))?.split('=')[1] ?? 'en';

contextBridge.exposeInMainWorld('erdHost', {
  locale,
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  openSpreadsheet: () => ipcRenderer.invoke('open-spreadsheet'),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveBinary: (opts) => ipcRenderer.invoke('save-binary', opts),
  confirm: (opts) => ipcRenderer.invoke('confirm', opts),
  setState: (state) => ipcRenderer.send('state', state),
  closeWindow: () => ipcRenderer.send('close-window'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  // Recently opened diagrams, newest first; onChange gets the new list.
  recent: {
    list: () => ipcRenderer.invoke('recent-files'),
    open: (filePath) => ipcRenderer.invoke('recent-open', filePath),
    remove: (filePath) => ipcRenderer.invoke('recent-remove', filePath),
    clear: () => ipcRenderer.invoke('recent-clear'),
    onChange: (cb) => ipcRenderer.on('recent-files', (_e, list) => cb(list)),
  },
  // Database access happens in the main process. The password is sent once,
  // with connect(); afterwards the window's connection is used implicitly.
  db: {
    test: (conn, instanceId) => ipcRenderer.invoke('db-test', conn, instanceId),
    connect: (conn, profile, opts) => ipcRenderer.invoke('db-connect', conn, profile, opts),
    // Saved instances: passwords go in with connect() and never come back out.
    instances: () => ipcRenderer.invoke('db-instances'),
    connectInstance: (id) => ipcRenderer.invoke('db-connect-instance', id),
    deleteInstance: (id) => ipcRenderer.invoke('db-instance-delete', id),
    forgetPassword: (id) => ipcRenderer.invoke('db-instance-forget-password', id),
    setReconnect: (on) => ipcRenderer.invoke('db-instances-reconnect', on),
    startupInstance: () => ipcRenderer.invoke('db-startup-instance'),
    disconnect: () => ipcRenderer.invoke('db-disconnect'),
    info: () => ipcRenderer.invoke('db-info'),
    introspect: () => ipcRenderer.invoke('db-introspect'),
    schema: () => ipcRenderer.invoke('db-schema'),
    execute: (sql) => ipcRenderer.invoke('db-execute', sql),
    row: (req) => ipcRenderer.invoke('db-row', req),
  },
  data: {
    tables: () => ipcRenderer.invoke('data-tables'),
    browse: (req) => ipcRenderer.invoke('data-browse', req),
    distinct: (req) => ipcRenderer.invoke('data-distinct', req),
  },
  query: {
    run: (req) => ipcRenderer.invoke('query-run', req),
  },
  // Apache AGE graphs.
  age: {
    status: () => ipcRenderer.invoke('age-status'),
    edges: (req) => ipcRenderer.invoke('age-edges', req),
    vertices: (req) => ipcRenderer.invoke('age-vertices', req),
    cypher: (req) => ipcRenderer.invoke('age-cypher', req),
    change: (op, args) => ipcRenderer.invoke('age-change', op, args),
  },
  project: {
    set: (diagramPath) => ipcRenderer.invoke('project-set', diagramPath),
    saveSettings: (settings) => ipcRenderer.invoke('project-settings-save', settings),
  },
  scripts: {
    list: () => ipcRenderer.invoke('scripts-list'),
    read: (rel) => ipcRenderer.invoke('script-read', rel),
    write: (script) => ipcRenderer.invoke('script-write', script),
    move: (rel, type, name) => ipcRenderer.invoke('script-move', rel, type, name),
    remove: (rel) => ipcRenderer.invoke('script-delete', rel),
    check: (req) => ipcRenderer.invoke('script-check', req),
    run: (req) => ipcRenderer.invoke('script-run', req),
    stop: () => ipcRenderer.invoke('script-stop'),
    commit: (runId) => ipcRenderer.invoke('script-commit', runId),
    discard: (runId) => ipcRenderer.invoke('script-discard', runId),
    onEvent: (cb) => ipcRenderer.on('script-event', (_e, payload) => cb(payload)),
  },
  // API keys go in with saveProvider() and never come back out.
  ai: {
    providers: () => ipcRenderer.invoke('ai-providers'),
    saveProvider: (config, apiKey) => ipcRenderer.invoke('ai-provider-save', config, apiKey),
    deleteProvider: (id) => ipcRenderer.invoke('ai-provider-delete', id),
    models: (providerId) => ipcRenderer.invoke('ai-models', providerId),
    chat: (req) => ipcRenderer.invoke('ai-chat', req),
    cancel: () => ipcRenderer.invoke('ai-cancel'),
    onEvent: (cb) => ipcRenderer.on('ai-event', (_e, payload) => cb(payload)),
  },
  audit: {
    recent: (limit) => ipcRenderer.invoke('audit-recent', limit),
  },
  onFileOpened: (cb) => ipcRenderer.on('file-opened', (_e, payload) => cb(payload)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, name) => cb(name)),
});
