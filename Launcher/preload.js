'use strict';

// The only bridge between the window and the launcher's main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  state: () => ipcRenderer.invoke('state'),
  games: (centralUrl) => ipcRenderer.invoke('play:games', centralUrl),
  join: (options) => ipcRenderer.invoke('play:join', options),
  stopClient: () => ipcRenderer.invoke('play:stop'),
  startHosting: (config) => ipcRenderer.invoke('host:start', config),
  stopHosting: () => ipcRenderer.invoke('host:stop'),
  players: () => ipcRenderer.invoke('host:players'),
  startWeb: () => ipcRenderer.invoke('web:start'),
  stopWeb: () => ipcRenderer.invoke('web:stop'),
  checks: () => ipcRenderer.invoke('setup:checks'),
  runSetup: (action) => ipcRenderer.invoke('setup:run', action),
  openFolder: (which) => ipcRenderer.invoke('open:folder', which),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  avatar: (username) => ipcRenderer.invoke('avatar:image', username),
  gameThumbnail: (options) => ipcRenderer.invoke('games:thumbnail', options),
  openManage: (centralUrl) => ipcRenderer.invoke('open:manage', centralUrl),
  hostThumbnail: (options) => ipcRenderer.invoke('host:thumbnail', options),
  convertPlace: (options) => ipcRenderer.invoke('place:convert', options),
  installPlace: (file) => ipcRenderer.invoke('place:install', file),
  onLog: (callback) => ipcRenderer.on('log', (event, entry) => callback(entry)),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', () => callback()),
  downloadFiles: (centralUrl) => ipcRenderer.invoke('files:download', centralUrl),
  onFilesProgress: (callback) => ipcRenderer.on('files-progress', (event, info) => callback(info)),
});
