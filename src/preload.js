'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('darky', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => { ipcRenderer.on('state', (_e, s) => cb(s)); },
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickCloudflared: () => ipcRenderer.invoke('pick-cloudflared'),
  start: (cfg) => ipcRenderer.invoke('start', cfg),
  stop: () => ipcRenderer.invoke('stop'),
  copyUrl: (u) => ipcRenderer.invoke('copy-url', u),
  openUrl: (u) => ipcRenderer.invoke('open-url', u),
  openLocal: (p) => ipcRenderer.invoke('open-local', p),
});
