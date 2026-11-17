'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const path = require('node:path');
const { DarkyController } = require('./controller');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const controller = new DarkyController({
  extraDirs: [path.join(process.resourcesPath || '', 'bin'), path.join(__dirname, '..', 'bin')],
});
let win = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 980, height: 820, minWidth: 760, minHeight: 640,
    title: 'DarkyDesk', icon: ICON, backgroundColor: '#050505',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  // The admin panel is a local file, never served over HTTP or through the tunnel.
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

controller.on('state', (s) => { if (win && !win.isDestroyed()) win.webContents.send('state', s); });

const isTunnelUrl = (u) => /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/i.test(String(u));

ipcMain.handle('get-state', () => controller.getState());
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Select website folder', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-cloudflared', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Locate cloudflared.exe', properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('start', (_e, cfg) => controller.start({
  folder: String(cfg?.folder || ''), port: cfg?.port,
  cloudflaredPath: cfg?.cloudflaredPath ? String(cfg.cloudflaredPath) : null,
}));
ipcMain.handle('stop', () => controller.stop());
ipcMain.handle('copy-url', (_e, url) => { if (isTunnelUrl(url)) { clipboard.writeText(url); return true; } return false; });
ipcMain.handle('open-url', (_e, url) => { if (isTunnelUrl(url)) { shell.openExternal(url); return true; } return false; });
ipcMain.handle('open-local', (_e, port) => {
  const p = Number(port);
  if (Number.isInteger(p) && p >= 1024 && p <= 65535) { shell.openExternal(`http://127.0.0.1:${p}/`); return true; }
  return false;
});

app.whenReady().then(createWindow);

// Stop the website server and the cloudflared process started by this app, then quit.
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const t = setTimeout(() => app.exit(0), 5000);
  controller.stop().finally(() => { clearTimeout(t); app.exit(0); });
});
app.on('window-all-closed', () => app.quit());
process.on('exit', () => controller.killNow());
