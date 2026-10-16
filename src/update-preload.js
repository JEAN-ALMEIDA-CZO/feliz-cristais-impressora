const { contextBridge, ipcRenderer } = require('electron');

// Ponte segura da tela de atualização
contextBridge.exposeInMainWorld('upd', {
  get: () => ipcRenderer.invoke('upd:get'),
  download: () => ipcRenderer.invoke('upd:download'),
  later: () => ipcRenderer.invoke('upd:later'),
  restart: () => ipcRenderer.invoke('upd:restart'),
  check: () => ipcRenderer.invoke('upd:check'),
  close: () => ipcRenderer.invoke('upd:close'),
  on: (fn) => ipcRenderer.on('upd', (_e, data) => fn(data)),
});
