const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (cb) => {
    ipcRenderer.on('window:maximized', (_, v) => cb(v));
    return () => ipcRenderer.removeAllListeners('window:maximized');
  },

  // Server config
  getServerUrl: () => ipcRenderer.invoke('config:getServerUrl'),
  setServerUrl: (url) => ipcRenderer.invoke('config:setServerUrl', url),

  // Notifications
  notify: (title, body, opts) => ipcRenderer.send('notify', { title, body, ...opts }),

  // Deep link
  onDeepLink: (cb) => {
    ipcRenderer.on('deep-link', (_, url) => cb(url));
    return () => ipcRenderer.removeAllListeners('deep-link');
  },

  // App info
  getVersion: () => ipcRenderer.invoke('app:version'),
  platform: process.platform,

  // Settings
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, val) => ipcRenderer.invoke('settings:set', key, val),

  // Open setup window
  openSetup: () => ipcRenderer.send('open:setup'),

  // Screen capture sources for getDisplayMedia fallback
  getScreenSources: () => ipcRenderer.invoke('screen:getSources'),
  setPreferredSource: (id) => ipcRenderer.invoke('desktop:setPreferredSource', id),

  // System audio (WASAPI loopback) — chromeMediaSourceId of the primary screen
  getSystemAudioSourceId: () => ipcRenderer.invoke('audio:getSystemSourceId'),

  // Explicit flag so the frontend can gate desktop-only features (e.g. system audio button)
  isElectron: true,

  // Autostart (reads actual system registry state)
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
});
