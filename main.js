const { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);

const DEFAULT_SETTINGS = {
  overlayHotkey: 'CommandOrControl+Shift+Space',
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  monitorDeviceId: 'default',
  routingInitialized: false,
  monitorEnabled: true,
  micGain: 1,
  soundGain: 0.85,
  micMuted: true,
  sounds: []
};

let mainWindow;
let settings;
let overlayOpen = false;
let hotkeyErrors = [];

// Audio routing must remain active while the window is minimized or covered by a game.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

function userDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function loadSettings() {
  try {
    const storedSettings = JSON.parse(fs.readFileSync(userDataPath('settings.json'), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...storedSettings };
    if (typeof storedSettings.routingInitialized !== 'boolean') {
      settings.routingInitialized = Boolean(storedSettings.outputDeviceId && storedSettings.outputDeviceId !== 'default');
    }
    if (!Array.isArray(settings.sounds)) settings.sounds = [];
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }
  return settings;
}

function saveSettings(nextSettings = settings) {
  settings = nextSettings;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userDataPath('settings.json'), JSON.stringify(settings, null, 2));
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = [];

  const register = (accelerator, action, label) => {
    if (!accelerator) return;
    try {
      const ok = globalShortcut.register(accelerator, action);
      if (!ok) hotkeyErrors.push(`${label}: ${accelerator}`);
    } catch {
      hotkeyErrors.push(`${label}: ${accelerator}`);
    }
  };

  register(settings.overlayHotkey, toggleOverlay, 'Open overlay');
  for (const sound of settings.sounds) {
    register(sound.hotkey, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('play-sound', sound.id);
      }
    }, sound.name);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hotkey-status', hotkeyErrors);
  }
}

function setOverlayMode(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  overlayOpen = enabled;
  if (enabled) {
    const display = require('electron').screen.getDisplayNearestPoint(require('electron').screen.getCursorScreenPoint());
    const width = Math.min(760, display.workAreaSize.width - 40);
    const height = Math.min(590, display.workAreaSize.height - 40);
    const x = Math.round(display.workArea.x + (display.workAreaSize.width - width) / 2);
    const y = Math.round(display.workArea.y + Math.max(24, display.workAreaSize.height * 0.08));
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setBounds({ x, y, width, height }, false);
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setSize(1120, 760, true);
    mainWindow.center();
  }
  mainWindow.webContents.send('overlay-mode', enabled);
}

function toggleOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (overlayOpen && mainWindow.isVisible()) {
    mainWindow.hide();
    overlayOpen = false;
    mainWindow.webContents.send('overlay-mode', false);
  } else {
    setOverlayMode(true);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: '#080b10',
    title: 'MicDrop Soundboard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Development-only visual regression capture. This never runs in normal use.
  if (process.argv.includes('--qa-capture')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const outputDir = path.join(__dirname, 'qa-output');
      fs.mkdirSync(outputDir, { recursive: true });
      await delay(900);
      const emptyLibraryImage = await mainWindow.capturePage();
      fs.writeFileSync(path.join(outputDir, 'library-empty.png'), emptyLibraryImage.toPNG());
      await mainWindow.webContents.executeJavaScript(`
        settings.sounds = [
          { id: 'qa-1', name: 'Air horn', path: '', hotkey: 'CommandOrControl+1', volume: 1, color: 'violet' },
          { id: 'qa-2', name: 'Perfect timing', path: '', hotkey: 'Alt+2', volume: .9, color: 'cyan' },
          { id: 'qa-3', name: 'Mission failed', path: '', hotkey: '', volume: 1, color: 'rose' },
          { id: 'qa-4', name: 'Achievement unlocked', path: '', hotkey: 'CommandOrControl+Shift+4', volume: .8, color: 'amber' },
          { id: 'qa-5', name: 'Bruh', path: '', hotkey: 'Alt+B', volume: 1, color: 'lime' },
          { id: 'qa-6', name: 'Round of applause', path: '', hotkey: '', volume: .75, color: 'violet' }
        ];
        renderAll();
      `);
      for (const page of ['library', 'audio', 'hotkeys', 'help']) {
        await mainWindow.webContents.executeJavaScript(`switchPage('${page}')`);
        await delay(180);
        const image = await mainWindow.capturePage();
        fs.writeFileSync(path.join(outputDir, `${page}.png`), image.toPNG());
      }
      setOverlayMode(true);
      await delay(220);
      const overlayImage = await mainWindow.capturePage();
      fs.writeFileSync(path.join(outputDir, 'overlay.png'), overlayImage.toPNG());
      app.quit();
    });
  }

  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'speaker-selection');
  });
  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'speaker-selection';
  });
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  registerHotkeys();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());

ipcMain.handle('settings:get', () => ({ settings, hotkeyErrors }));

ipcMain.handle('settings:save', (_event, nextSettings) => {
  const clean = {
    ...DEFAULT_SETTINGS,
    ...nextSettings,
    sounds: Array.isArray(nextSettings.sounds) ? nextSettings.sounds : []
  };
  saveSettings(clean);
  registerHotkeys();
  return { settings, hotkeyErrors };
});

function importSoundFiles(sourcePaths) {
  const soundsDir = userDataPath('sounds');
  fs.mkdirSync(soundsDir, { recursive: true });
  const imported = [];
  let skipped = Math.max(0, sourcePaths.length - 100);

  for (const sourcePath of sourcePaths.slice(0, 100)) {
    try {
      if (typeof sourcePath !== 'string' || !AUDIO_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
        skipped += 1;
        continue;
      }
      if (!fs.statSync(sourcePath).isFile()) {
        skipped += 1;
        continue;
      }

      const id = crypto.randomUUID();
      const extension = path.extname(sourcePath).toLowerCase();
      const targetPath = path.join(soundsDir, `${id}${extension}`);
      fs.copyFileSync(sourcePath, targetPath);
      imported.push({
        id,
        name: path.basename(sourcePath, extension),
        path: targetPath,
        hotkey: '',
        volume: 1,
        color: ['violet', 'cyan', 'amber', 'rose', 'lime'][(settings.sounds.length + imported.length) % 5]
      });
    } catch (error) {
      skipped += 1;
      console.error('Could not import sound:', sourcePath, error);
    }
  }
  settings.sounds.push(...imported);
  saveSettings();
  registerHotkeys();
  return { imported, skipped };
}

ipcMain.handle('sounds:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add sounds to MicDrop',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio files', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled) return { imported: [], skipped: 0 };
  return importSoundFiles(result.filePaths);
});

ipcMain.handle('sounds:import-dropped', (_event, sourcePaths) => {
  if (!Array.isArray(sourcePaths)) return { imported: [], skipped: 0 };
  return importSoundFiles(sourcePaths);
});

ipcMain.handle('sounds:remove', (_event, id) => {
  const sound = settings.sounds.find((item) => item.id === id);
  settings.sounds = settings.sounds.filter((item) => item.id !== id);
  saveSettings();
  registerHotkeys();
  if (sound?.path?.startsWith(userDataPath('sounds'))) {
    try { fs.unlinkSync(sound.path); } catch { /* file is already gone */ }
  }
  return { settings, hotkeyErrors };
});

ipcMain.handle('file:read-audio', (_event, filePath) => {
  const sound = settings.sounds.find((item) => item.path === filePath);
  if (!sound) throw new Error('That sound is not in the library.');
  return fs.readFileSync(sound.path);
});

ipcMain.handle('app:window', (_event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'close') mainWindow.close();
  if (action === 'hide') mainWindow.hide();
  if (action === 'exit-overlay') setOverlayMode(false);
});

ipcMain.handle('app:open-external', (_event, url) => {
  const allowed = ['https://vb-audio.com/Cable/', 'ms-settings:sound'];
  if (allowed.includes(url)) return shell.openExternal(url);
  return false;
});
