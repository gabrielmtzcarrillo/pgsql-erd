// Narrow bridge between the sandboxed renderer and the main process.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('erdHost', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  openSpreadsheet: () => ipcRenderer.invoke('open-spreadsheet'),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveBinary: (opts) => ipcRenderer.invoke('save-binary', opts),
  confirm: (opts) => ipcRenderer.invoke('confirm', opts),
  setState: (state) => ipcRenderer.send('state', state),
  closeWindow: () => ipcRenderer.send('close-window'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  db: {
    test: (conn) => ipcRenderer.invoke('db-test', conn),
    introspect: (conn) => ipcRenderer.invoke('db-introspect', conn),
    execute: (conn, sql) => ipcRenderer.invoke('db-execute', conn, sql),
  },
  onFileOpened: (cb) => ipcRenderer.on('file-opened', (_e, payload) => cb(payload)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, name) => cb(name)),
});
