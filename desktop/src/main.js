const {
  app, BrowserWindow, BrowserView, ipcMain, Tray, Menu,
  shell, nativeImage, Notification, session, dialog, protocol,
} = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const Store = require('./store');
const createWindowStateKeeper = require('./windowState');

// ── Config store ─────────────────────────────────────────────────────────────
const store = new Store({
  serverUrl: 'https://localhost:8443',
  launchMinimized: false,
  minimizeToTray: true,
  hardwareAcceleration: true,
  notifications: true,
});

const isDev = process.argv.includes('--dev');

let mainWindow = null;
let setupWindow = null;
let tray = null;
let preferredDesktopSourceId = null; // chosen by the renderer source picker

// ── Hardware acceleration ─────────────────────────────────────────────────────
if (!store.get('hardwareAcceleration')) {
  app.disableHardwareAcceleration();
}

// ── Single instance lock ──────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = argv.find(a => a.startsWith('watchsync://'));
    if (url) handleDeepLink(url);
  });
}

// ── Deep link protocol ────────────────────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('watchsync', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('watchsync');
}

function handleDeepLink(url) {
  if (mainWindow) mainWindow.webContents.send('deep-link', url);
}

// ── SSL: trust self-signed certs from configured server ──────────────────────
app.on('certificate-error', (event, webContents, url, error, cert, callback) => {
  const serverUrl = store.get('serverUrl', '');
  try {
    const serverHost = new URL(serverUrl).host;
    const certUrl = new URL(url).host;
    if (certUrl === serverHost || certUrl === 'localhost' || certUrl === '127.0.0.1') {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch { /* ignore parse errors */ }
  callback(false);
});

// ── Create main window ────────────────────────────────────────────────────────
function createMainWindow() {
  const wsKeeper = createWindowStateKeeper(store, 'windowState', {
    width: 1280,
    height: 800,
  });

  mainWindow = new BrowserWindow({
    x: wsKeeper.x,
    y: wsKeeper.y,
    width: wsKeeper.width,
    height: wsKeeper.height,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#09090f',
    icon: path.join(__dirname, '../assets/icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  wsKeeper.track(mainWindow);

  if (wsKeeper.isMaximized) mainWindow.maximize();

  const serverUrl = store.get('serverUrl');
  mainWindow.loadURL(serverUrl).catch(() => {
    mainWindow.loadFile(path.join(__dirname, 'error.html'));
  });

  mainWindow.once('ready-to-show', () => {
    if (!store.get('launchMinimized')) mainWindow.show();
  });

  // Sync maximize state to renderer for custom titlebar button
  mainWindow.on('maximize',   () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

  mainWindow.on('close', (e) => {
    if (!app.isQuiting && store.get('minimizeToTray') && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Internal URLs (same server origin) → new Electron window; external → system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const serverUrl = store.get('serverUrl', '');
    try {
      const serverOrigin = new URL(serverUrl).origin;
      // Resolve relative URLs (e.g. '/files?room=...') against the server origin
      const absoluteUrl = url.startsWith('/') ? `${serverOrigin}${url}` : url;
      const targetOrigin = new URL(absoluteUrl).origin;
      if (targetOrigin === serverOrigin) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            frame: false,
            backgroundColor: '#09090f',
            minWidth: 900,
            minHeight: 600,
            icon: path.join(__dirname, '../assets/icon.ico'),
            webPreferences: {
              preload: path.join(__dirname, 'preload.js'),
              nodeIntegration: false,
              contextIsolation: true,
              webSecurity: false,
              allowRunningInsecureContent: true,
            },
          },
        };
      }
    } catch { /* ignore */ }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Inject titlebar + permissions into any child window (e.g. file manager)
  mainWindow.webContents.on('did-create-window', (childWin) => {
    childWin.webContents.on('did-finish-load', () => {
      injectTitlebarInto(childWin);
    });
    childWin.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'notifications', 'fullscreen', 'loopback-desktop'];
      callback(allowed.includes(permission));
    });
    // Trust same self-signed cert in child windows
    childWin.webContents.on('certificate-error', (event, url, error, cert, callback) => {
      event.preventDefault();
      callback(true);
    });
  });

  // Inject custom titlebar CSS on every page load
  mainWindow.webContents.on('did-finish-load', () => {
    injectTitlebar();
  });

  // Allow camera, microphone, screen capture
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'notifications', 'fullscreen', 'loopback-desktop'];
    callback(allowed.includes(permission));
  });

  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'notifications', 'fullscreen', 'loopback-desktop'];
    return allowed.includes(permission);
  });

  // Electron 22+: handle getDisplayMedia (screen share)
  if (mainWindow.webContents.session.setDisplayMediaRequestHandler) {
    mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      // Audio-only request → WASAPI loopback (system sound sharing, no video track)
      if (request.audioRequested && !request.videoRequested) {
        callback({ audio: 'loopback' });
        return;
      }
      // Let the web app handle source selection via desktopCapturer
      const { desktopCapturer } = require('electron');
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
        // Use the renderer-selected source if set; otherwise the primary screen
        const chosen = preferredDesktopSourceId
          ? (sources.find(s => s.id === preferredDesktopSourceId) || sources[0])
          : sources[0];
        callback({ video: chosen, audio: 'loopback' });
      }).catch(() => callback({}));
    }, { useSystemPicker: true });
  }

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// ── Titlebar injection ────────────────────────────────────────────────────────
function injectTitlebarInto(win) {
  if (!win) return;
  win.webContents.insertCSS(`
    :root { --titlebar-height: 32px; }
    body { padding-top: var(--titlebar-height) !important; }
    #ws-titlebar {
      position: fixed; top: 0; left: 0; right: 0;
      height: var(--titlebar-height);
      background: rgba(9,9,15,0.95);
      backdrop-filter: blur(8px);
      display: flex; align-items: center;
      z-index: 999999;
      -webkit-app-region: drag;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      user-select: none;
    }
    #ws-titlebar .ws-tb-logo {
      display: flex; align-items: center; gap: 6px;
      padding: 0 12px;
      font-size: 12px; font-weight: 700;
      color: #7c6ff7;
      letter-spacing: 0.03em;
      flex: 1;
    }
    #ws-titlebar .ws-tb-logo img { width: 16px; height: 16px; }
    #ws-titlebar .ws-tb-controls {
      display: flex;
      -webkit-app-region: no-drag;
    }
    #ws-titlebar .ws-tb-btn {
      width: 46px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      background: none; border: none; cursor: pointer;
      color: rgba(255,255,255,0.6);
      font-size: 12px; transition: background 0.15s;
    }
    #ws-titlebar .ws-tb-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
    #ws-titlebar .ws-tb-btn.close:hover { background: #e81123; color: #fff; }
    #ws-titlebar .ws-tb-btn svg { pointer-events: none; }
  `).then(() => {
    win.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('ws-titlebar')) return;
        const bar = document.createElement('div');
        bar.id = 'ws-titlebar';
        bar.innerHTML = \`
          <div class="ws-tb-logo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="#7c6ff7" stroke-width="2"/>
              <polygon points="10,8 16,12 10,16" fill="#7c6ff7"/>
            </svg>
            WatchSync
          </div>
          <div class="ws-tb-controls">
            <button class="ws-tb-btn" id="ws-tb-min" title="Свернуть">
              <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
            </button>
            <button class="ws-tb-btn" id="ws-tb-max" title="Развернуть">
              <svg width="10" height="10" viewBox="0 0 10 10"><rect width="9" height="9" x="0.5" y="0.5" stroke="currentColor" fill="none"/></svg>
            </button>
            <button class="ws-tb-btn close" id="ws-tb-close" title="Закрыть">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/>
                <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/>
              </svg>
            </button>
          </div>
        \`;
        document.body.insertBefore(bar, document.body.firstChild);
        document.getElementById('ws-tb-min').onclick = () => window.electronAPI?.minimize();
        document.getElementById('ws-tb-max').onclick = () => window.electronAPI?.maximize();
        document.getElementById('ws-tb-close').onclick = () => window.electronAPI?.close();
      })();
    `).catch(() => {});
  }).catch(() => {});
}

function injectTitlebar() {
  injectTitlebarInto(mainWindow);
}

// ── Setup window ──────────────────────────────────────────────────────────────
function createSetupWindow() {
  if (setupWindow) { setupWindow.focus(); return; }

  setupWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    frame: false,
    backgroundColor: '#09090f',
    icon: path.join(__dirname, '../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    parent: mainWindow || undefined,
    modal: false,
  });

  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

// ── System Tray ───────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '../assets/tray.png');
  tray = new Tray(iconPath);
  tray.setToolTip('WatchSync');

  const buildMenu = () => Menu.buildFromTemplate([
    { label: 'WatchSync', enabled: false },
    { type: 'separator' },
    {
      label: 'Показать',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    },
    {
      label: 'Настройки сервера',
      click: () => createSetupWindow(),
    },
    { type: 'separator' },
    {
      label: 'Завершить',
      click: () => { app.isQuiting = true; app.quit(); },
    },
  ]);

  tray.setContextMenu(buildMenu());

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

ipcMain.handle('config:getServerUrl', () => store.get('serverUrl'));
ipcMain.handle('config:setServerUrl', (_, url) => {
  store.set('serverUrl', url);
  if (setupWindow) setupWindow.close();
  if (mainWindow) {
    mainWindow.loadURL(url).catch(() => {});
    mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus(); });
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('settings:get', (_, key) => store.get(key));
ipcMain.handle('settings:set', (_, key, val) => {
  store.set(key, val);
  if (key === 'autostart') {
    app.setLoginItemSettings({ openAtLogin: !!val });
  } else if (key === 'hardwareAcceleration') {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'Требуется перезапуск',
      detail: 'Изменение вступит в силу после перезапуска WatchSync.',
      buttons: ['OK'],
    });
  }
});

ipcMain.on('notify', (_, { title, body, tag }) => {
  if (!store.get('notifications')) return;
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
});

ipcMain.on('open:setup', () => createSetupWindow());

ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('screen:getSources', async () => {
  const { desktopCapturer } = require('electron');
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// System audio (WASAPI loopback): return the primary screen's chromeMediaSourceId.
// The renderer uses it as `chromeMediaSourceId` in getUserMedia constraints to capture
// whatever is playing through the speakers/headphones.
ipcMain.handle('audio:getSystemSourceId', async () => {
  const { desktopCapturer } = require('electron');
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources[0]?.id || null;
});

// Renderer source picker: remember the chosen screen/window for getDisplayMedia
ipcMain.handle('desktop:setPreferredSource', (_, id) => { preferredDesktopSourceId = id; return true; });

// ── Auto-updater ──────────────────────────────────────────────────────────────
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(resolve); });
      file.on('error', reject);
    });
    req.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function checkForUpdates() {
  const serverUrl = store.get('serverUrl', '');
  if (!serverUrl) return;
  try {
    const info = await fetchJSON(`${serverUrl}/downloads/latest.json`);
    const currentVersion = app.getVersion();
    if (!info.version || compareVersions(info.version, currentVersion) <= 0) return;

    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Доступно обновление',
      message: `Доступна новая версия WatchSync ${info.version}`,
      detail: info.release_notes || '',
      buttons: ['Скачать и установить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return;

    const tmpZip = path.join(app.getPath('temp'), `WatchSync-${info.version}-win64.zip`);
    const downloadUrl = info.download_url.startsWith('http')
      ? info.download_url
      : `${serverUrl}${info.download_url}`;

    mainWindow?.webContents.send('update:progress', { status: 'downloading' });
    await downloadFile(downloadUrl, tmpZip);

    const appDir = path.dirname(app.getPath('exe'));
    const scriptPath = path.join(app.getPath('temp'), 'watchsync-update.ps1');
    const psScript = `
Start-Sleep -Seconds 2
Expand-Archive -Path '${tmpZip.replace(/\\/g, '\\\\')}' -DestinationPath '${appDir.replace(/\\/g, '\\\\')}' -Force
Start-Process '${path.join(appDir, 'WatchSync.exe').replace(/\\/g, '\\\\')}'
`;
    fs.writeFileSync(scriptPath, psScript, 'utf8');

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Обновление загружено',
      message: `Версия ${info.version} загружена. Приложение перезапустится для установки.`,
      buttons: ['Установить сейчас', 'Отмена'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;

    const { spawn } = require('child_process');
    spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    app.isQuiting = true;
    app.quit();
  } catch (err) {
    // Silent fail — auto-update is best-effort
    if (isDev) console.error('Auto-update check failed:', err.message);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Sync autostart: apply stored setting → system (first run) or read system → store (subsequent)
  const storedAutostart = store.get('autostart', false);
  const systemAutostart = app.getLoginItemSettings().openAtLogin;
  if (storedAutostart !== systemAutostart) {
    app.setLoginItemSettings({ openAtLogin: !!storedAutostart });
  }

  createTray();

  const serverUrl = store.get('serverUrl');
  const isFirstRun = !store.get('__initialized');

  if (isFirstRun || serverUrl === 'https://localhost') {
    store.set('__initialized', true);
    createSetupWindow();
    // Also create (but hide) main window so setup can navigate to it
    createMainWindow();
    mainWindow.hide();
  } else {
    createMainWindow();
    // Check for updates 8 seconds after launch (non-blocking)
    setTimeout(checkForUpdates, 8000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (app.isQuiting) app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
  else mainWindow.show();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Cleanup on quit
app.on('before-quit', () => { app.isQuiting = true; });
