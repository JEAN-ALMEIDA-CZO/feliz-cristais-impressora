const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Ponte segura entre a janela de configurações e o aplicativo
contextBridge.exposeInMainWorld('fc', {
  get: () => ipcRenderer.invoke('get'),
  printers: () => ipcRenderer.invoke('printers'),
  save: (c) => ipcRenderer.invoke('save', c),
  test: () => ipcRenderer.invoke('test'),
  importFile: (file) => ipcRenderer.invoke('import', file),
  pathFor: (file) => webUtils.getPathForFile(file),
  update: () => ipcRenderer.invoke('update'),
  open: (url) => ipcRenderer.invoke('open', url),
  on: (channel, fn) => {
    if (['state', 'log', 'config'].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
