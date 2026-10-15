const { contextBridge, ipcRenderer } = require('electron');

// Ponte segura entre a janela de configurações e o aplicativo
contextBridge.exposeInMainWorld('fc', {
  get: () => ipcRenderer.invoke('get'),
  printers: () => ipcRenderer.invoke('printers'),
  save: (c) => ipcRenderer.invoke('save', c),
  test: () => ipcRenderer.invoke('test'),
  update: () => ipcRenderer.invoke('update'),
  open: (url) => ipcRenderer.invoke('open', url),
  on: (channel, fn) => {
    if (['state', 'log'].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
