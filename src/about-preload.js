const { contextBridge, ipcRenderer } = require('electron');

// Ponte segura da tela Suporte/Sobre (os links ficam fixos no app)
contextBridge.exposeInMainWorld('about', {
  get: () => ipcRenderer.invoke('about:get'),
  open: (key) => ipcRenderer.invoke('about:open', key),
  update: () => ipcRenderer.invoke('upd:check'),
});
