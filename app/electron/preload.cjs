// Sandboxed preload: the only bridge between the editor UI and Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vdmDesktop', {
  isDesktop: true,
  restart: (dir) => ipcRenderer.invoke('vdm:restart', dir || null),
  openProject: (dir) => ipcRenderer.invoke('vdm:open-project', dir),
  pickFolder: () => ipcRenderer.invoke('vdm:pick-folder'),
  current: () => ipcRenderer.invoke('vdm:current'),
  onOpenPicker: (cb) => { ipcRenderer.on('vdm:open-picker', () => cb()); },
});
