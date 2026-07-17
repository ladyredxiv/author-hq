const { app, BrowserWindow, Menu, Tray, shell } = require('electron');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');

let mainWindow;
let serverHandle;
let tray;
let isQuitting = false;

const preferredPort = Number(process.env.PORT || 3131);

app.setName('Author HQ');
app.setAppUserModelId('com.authorhq.desktop');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  showMainWindow();
});

process.on('uncaughtException', (error) => {
  writeStartupLog(error);
  app.quit();
});

process.on('unhandledRejection', (error) => {
  writeStartupLog(error);
  app.quit();
});

app.whenReady().then(async () => {
  try {
    const userData = app.getPath('userData');
    process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(userData, 'author-hq.sqlite');
    process.env.AUTHOR_HQ_SETTINGS_PATH = process.env.AUTHOR_HQ_SETTINGS_PATH || path.join(userData, 'local-settings.json');

    if (process.argv.includes('--init-db')) {
      const { initializeDatabase } = await import(pathToFileUrl(path.join(__dirname, '..', 'src', 'db', 'index.js')));
      initializeDatabase();
      app.exit(0);
      return;
    }

    const port = await findOpenPort(preferredPort, new Set([3000, 3127]));
    process.env.PORT = String(port);

    const { startServer } = await import(pathToFileUrl(path.join(__dirname, '..', 'src', 'server.js')));
    serverHandle = await startServer({ port, host: '127.0.0.1' });

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 920,
      minHeight: 640,
      title: 'Author HQ',
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      backgroundColor: '#faf8f5',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith(serverHandle.url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    wireTrayBehavior();
    createTray();
    await mainWindow.loadURL(serverHandle.url);
  } catch (error) {
    writeStartupLog(error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Keep the local server alive in the tray unless the user explicitly quits.
  if (isQuitting && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverHandle?.close) serverHandle.close().catch((error) => writeStartupLog(error));
  else if (serverHandle?.server) serverHandle.server.close();
});

app.on('activate', () => {
  showMainWindow();
});

function wireTrayBehavior() {
  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.ico'));
  tray.setToolTip('Author HQ');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Author HQ', click: showMainWindow },
    { label: 'Hide Author HQ', click: () => mainWindow?.hide() },
    { type: 'separator' },
    {
      label: 'Quit Author HQ',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.maximize();
  mainWindow.focus();
}

async function findOpenPort(start, banned) {
  let port = start;
  while (banned.has(port) || !(await isPortOpen(port))) {
    port += 1;
  }
  return port;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function pathToFileUrl(filePath) {
  return `file://${filePath.replace(/\\/g, '/')}`;
}

function writeStartupLog(error) {
  try {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    const message = error?.stack || error?.message || String(error);
    fs.writeFileSync(path.join(userData, 'startup-error.log'), `${new Date().toISOString()}\n${message}\n`);
  } catch {
    // If logging fails, there is nowhere safer to report from the main process.
  }
}
