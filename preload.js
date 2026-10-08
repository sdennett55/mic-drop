const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('micdrop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  importSounds: () => ipcRenderer.invoke('sounds:import'),
  importDroppedSounds: (files) => {
    const sourcePaths = Array.from(files, (file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke('sounds:import-dropped', sourcePaths);
  },
  removeSound: (id) => ipcRenderer.invoke('sounds:remove', id),
  readAudio: (filePath) => ipcRenderer.invoke('file:read-audio', filePath),
  windowAction: (action) => ipcRenderer.invoke('app:window', action),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onPlaySound: (callback) => ipcRenderer.on('play-sound', (_event, id) => callback(id)),
  onOverlayMode: (callback) => ipcRenderer.on('overlay-mode', (_event, enabled) => callback(enabled)),
  onHotkeyStatus: (callback) => ipcRenderer.on('hotkey-status', (_event, errors) => callback(errors))
});
