const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

app.commandLine.appendSwitch('lang', 'es-MX');
app.commandLine.appendSwitch('accept-lang', 'es-MX,es;q=0.9');

const DEV_SERVER_URL = process.env.ELECTRON_DEV_SERVER_URL ?? 'http://localhost:4200';
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'farma-jyv-pos', 'browser', 'index.html');
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

let mainWindow;

function createWindow() {
  const windowOptions = {
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };

  const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  if (fs.existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else if (fs.existsSync(DIST_INDEX)) {
    mainWindow.loadFile(DIST_INDEX);
  } else {
    console.error(`No se encontró el build en ${DIST_INDEX}. Ejecuta "npm run electron:build" primero.`);
    app.quit();
    return;
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  configurarPermisos();
  registrarIPCHandlers();
  createWindow();
  verificarActualizaciones();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

function verificarActualizaciones() {
  if (isDev) return;

  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;

    const updateUrl = process.env.UPDATE_URL?.trim();
    if (updateUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
    }

    autoUpdater.on('error', (error) => {
      console.log('[updater] error (no-op):', error?.message ?? error);
    });
    autoUpdater.on('update-available', (info) => {
      console.log(`[updater] actualización disponible: ${info.version}`);
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[updater] descargada ${info.version}; se instalará al cerrar la app`);
    });

    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.log('[updater] sin feed de actualizaciones (no-op):', error?.message ?? error);
    });
  } catch (error) {
    console.log('[updater] no disponible (no-op):', error?.message ?? error);
  }
}

function configurarPermisos() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['geolocation'].includes(permission));
  });
}

function registrarIPCHandlers() {
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-device-info', () => obtenerInfoDispositivo());
  ipcMain.handle('open-cash-drawer', (_event, printerName) => abrirCajon(printerName));
}

function abrirCajon(printerName) {
  const name = typeof printerName === 'string' ? printerName.trim() : '';
  if (!name) {
    console.log('[cash-drawer] printerName vacío — no-op');
    return false;
  }

  const kick = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  const tempFile = path.join(os.tmpdir(), `farma-jyv-drawer-${Date.now()}.bin`);

  try {
    fs.writeFileSync(tempFile, kick);
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', `copy /b "${tempFile}" "${name}"`], { stdio: 'ignore' });
    } else {
      execFileSync('lp', ['-d', name, '-o', 'raw', tempFile], { stdio: 'ignore' });
    }
    return true;
  } catch (error) {
    console.error('[cash-drawer] error', error);
    return false;
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // ignore
    }
  }
}

function obtenerMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const nombre of Object.keys(interfaces)) {
    for (const iface of interfaces[nombre]) {
      if (!iface.internal && iface.family === 'IPv4' && iface.mac !== '00:00:00:00:00:00') {
        return { interfaz: nombre, mac: iface.mac, ip: iface.address };
      }
    }
  }
  return null;
}

function obtenerInfoDispositivo() {
  const mac = obtenerMacAddress();
  const id = mac ? `${os.hostname()}-${mac.mac.replace(/:/g, '')}` : os.hostname();
  return {
    mac: mac?.mac ?? null,
    hostname: os.hostname(),
    plataforma: os.platform(),
    arquitectura: os.arch(),
    id,
  };
}
