'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { DownloadManager } = require('./src/manager');

let win = null;
let manager = null;
let quitting = false;

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 780,
    minHeight: 480,
    title: 'Blitzload',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => (win = null));
}

function registerIpc() {
  const taskOf = (id) => manager.tasks.get(id);

  ipcMain.handle('dm:list', () => manager.list());
  ipcMain.handle('dm:getSettings', () => ({ ...manager.settings }));
  ipcMain.handle('dm:setSettings', (_e, patch) => manager.setSettings(patch || {}));

  ipcMain.handle('dm:add', (_e, { urls, dir, checksum }) => {
    const list = Array.isArray(urls) ? urls : [];
    return list.map((url) => {
      try {
        manager.add({ url, dir, checksum: list.length === 1 ? checksum : '' });
        return { url, ok: true };
      } catch (err) {
        return { url, ok: false, error: err.message };
      }
    });
  });

  ipcMain.handle('dm:pause', (_e, id) => manager.pause(id));
  ipcMain.handle('dm:resume', (_e, id) => manager.resume(id));
  ipcMain.handle('dm:pauseAll', () => manager.pauseAll());
  ipcMain.handle('dm:resumeAll', () => manager.resumeAll());
  ipcMain.handle('dm:clearCompleted', () => manager.clearCompleted());
  ipcMain.handle('dm:remove', (_e, id, opts) => manager.remove(id, opts || {}));

  ipcMain.handle('dm:openFile', async (_e, id) => {
    const t = taskOf(id);
    if (!t || t.status !== 'completed' || !fs.existsSync(t.finalPath)) return 'The file is no longer in that folder.';
    return (await shell.openPath(t.finalPath)) || null;
  });

  ipcMain.handle('dm:showInFolder', async (_e, id) => {
    const t = taskOf(id);
    if (!t) return null;
    const target = t.status === 'completed' ? t.finalPath : t.partPath;
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    else await shell.openPath(t.dir);
    return null;
  });

  ipcMain.handle('dm:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: manager.settings.downloadDir,
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dm:clipboard', () => clipboard.readText().slice(0, 4000));
}

function init() {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  manager = new DownloadManager({
    dataDir: app.getPath('userData'),
    defaultDownloadDir: app.getPath('downloads'),
  });
  manager.load();
  registerIpc();

  manager.on('update', (snap) => send('dm:update', snap));
  manager.on('removed', (id) => send('dm:removed', id));
  manager.on('settings', (s) => send('dm:settings', s));
  manager.on('completed', (snap) => {
    if (Notification.isSupported()) {
      new Notification({ title: 'Download complete', body: snap.filename }).show();
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(init);
}

// Save progress before exiting so downloads can pick up where they left off.
app.on('before-quit', (e) => {
  if (quitting || !manager) return;
  e.preventDefault();
  quitting = true;
  manager.shutdown().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
