const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const CASH_DRAWER_TIMEOUT_MS = 5000;

/** Rechaza si `promise` no resuelve dentro de `ms` — no cancela el trabajo real (Node no puede matar una syscall en curso), pero libera el proceso principal para seguir atendiendo IPC en vez de congelarse. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tiempo de espera agotado (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const { getPrisma } = require('./db/client');
const { isAllowedNavigation, isSafePrinterTarget, isDevToolsShortcut } = require('./security');
const productsDb = require('./db/products');
const salesDb = require('./db/sales');
const syncRunsDb = require('./db/sync-runs');
const cashSessionsDb = require('./db/cash-sessions');
const cashMovementsDb = require('./db/cash-movements');
const pharmacyServicesDb = require('./db/pharmacy-services');
const promotionsDb = require('./db/promotions');

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
      // El renderer corre en el sandbox del sistema operativo: un fallo de
      // memoria en Chromium ya no basta para tocar el disco de la caja. El
      // `preload` sigue funcionando — solo usa `contextBridge` e `ipcRenderer`,
      // que sí están disponibles en un preload sandboxeado.
      sandbox: true,
      nodeIntegrationInSubframes: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  };

  const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  if (fs.existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);
  blindarNavegacion(mainWindow.webContents);
  blindarDevTools(mainWindow.webContents);

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

  /**
   * La X no cierra en seco: se le pregunta al renderer, que sabe si hay turno
   * abierto o ventas sin sincronizar y muestra el mismo diálogo que "Cerrar
   * sesión". Cerrar con un turno a medias se lleva por delante el corte.
   *
   * Dos válvulas de escape para no dejar la app incerrable: si el renderer no
   * contesta en `CLOSE_CONFIRM_TIMEOUT_MS` (colgado, pantalla en blanco) o si se
   * insiste con la X, se cierra igual. Bloquear la salida de un equipo de caja
   * es peor que perder el aviso.
   */
  mainWindow.on('close', (event) => {
    if (cierreConfirmado) {
      return;
    }
    event.preventDefault();

    if (cierreSolicitadoEn && Date.now() - cierreSolicitadoEn < INSIST_CLOSE_MS) {
      cerrarVentana();
      return;
    }
    cierreSolicitadoEn = Date.now();
    mainWindow.webContents.send('app:close-requested');

    clearTimeout(cierreTimeout);
    cierreTimeout = setTimeout(() => {
      if (!cierreConfirmado) {
        console.warn('[app] el renderer no respondió al cierre; se cierra de todos modos');
        cerrarVentana();
      }
    }, CLOSE_CONFIRM_TIMEOUT_MS);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** El renderer ya decidió: el siguiente `close` pasa sin preguntar. */
let cierreConfirmado = false;
/** Momento del último intento de cierre, para detectar que se insiste con la X. */
let cierreSolicitadoEn = 0;
let cierreTimeout = null;

/** Cuánto se espera la respuesta del renderer antes de cerrar por las malas. */
const CLOSE_CONFIRM_TIMEOUT_MS = 10_000;
/** Segunda X dentro de esta ventana de tiempo = "ciérrate ya". */
const INSIST_CLOSE_MS = 3_000;

function cerrarVentana() {
  clearTimeout(cierreTimeout);
  cierreConfirmado = true;
  mainWindow?.close();
}

app.whenReady().then(() => {
  configurarPermisos();
  instalarMenu();
  registrarIPCHandlers();
  // Arranca migraciones ya (no bloquea la ventana): las llamadas IPC que
  // lleguen antes de terminar esperan la misma promesa dentro de `getPrisma()`.
  getPrisma()
    .then((prisma) =>
      // Limpieza best-effort de promociones cerradas hace más de 30 días. Va
      // encadenada a las migraciones (la tabla puede no existir antes) y nunca
      // se espera: un fallo aquí no debe retrasar ni tumbar la caja.
      promotionsDb
        .purgeStale(prisma, new Date())
        .catch((error) => console.error('[db] no se pudieron purgar promociones viejas', error)),
    )
    .catch((error) => console.error('[db] error al migrar', error));
  createWindow();
  verificarActualizaciones();
});

app.on('before-quit', async () => {
  try {
    const prisma = await getPrisma();
    await prisma.$disconnect();
  } catch {
    // ya sin conexión o nunca se abrió; nada que cerrar.
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

/**
 * En producción, DevTools queda fuera de alcance.
 *
 * No es paranoia de configuración: la consola del renderer puede llamar
 * `window.electronAPI` directo, y los handlers de IPC reciben el `userId` como
 * argumento sin verificarlo. Un cajero con DevTools lista los cortes de todo el
 * equipo (reservados a admin por `permissionGuard('cashSessions','read')`),
 * firma una anulación con el uid de otro o pone un producto a $0.01.
 *
 * Se cierran las tres vías: el atajo de teclado, la reapertura por cualquier
 * otro camino, y el menú "View → Toggle Developer Tools" (ver `instalarMenu`).
 */
function blindarDevTools(webContents) {
  if (isDev) {
    return;
  }
  webContents.on('before-input-event', (event, input) => {
    if (isDevToolsShortcut(input)) {
      event.preventDefault();
    }
  });
  // Cinturón y tirantes: si algo más lo abre (menú del sistema, extensión), se
  // cierra en el acto.
  webContents.on('devtools-opened', () => webContents.closeDevTools());
}

/**
 * Menú propio en producción. El de Electron trae "View → Toggle Developer
 * Tools", así que no basta con bloquear el atajo.
 *
 * No se quita el menú entero: sin él, macOS se queda sin ⌘Q, ⌘C y ⌘V, y el
 * cajero no podría ni pegar un código ni cerrar la app. Se conservan esos
 * elementos y se elimina todo lo de desarrollo.
 */
function instalarMenu() {
  if (isDev) {
    return;
  }
  const esMac = process.platform === 'darwin';
  const plantilla = [
    ...(esMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Edición',
      submenu: [
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    {
      label: 'Ventana',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Zoom' },
        ...(esMac ? [] : [{ role: 'quit', label: 'Salir' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(plantilla));
}

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

/**
 * La ventana del POS no navega a ningún sitio y no abre ventanas.
 *
 * Sin esto, un XSS en el renderer podía apuntar `window.location` a una página
 * suya y quedarse con el `preload` cargado: mismo `window.electronAPI`, mismo
 * IPC, pero el código ya no es el nuestro. Y `window.open` levantaba una
 * BrowserWindow hija sin ninguna de estas restricciones.
 *
 * Los enlaces http(s) legítimos (soporte, comprobante en línea) se abren en el
 * navegador del sistema, fuera del proceso con acceso a la caja.
 */
function blindarNavegacion(webContents) {
  const politica = { isDev, devServerUrl: DEV_SERVER_URL, appIndexPath: DIST_INDEX };

  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(protocoloDe(url))) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, politica)) {
      console.warn(`[security] navegación bloqueada a ${url}`);
      event.preventDefault();
    }
  });

  // Nada en el POS usa `<webview>`; si aparece uno es que el renderer no es el
  // nuestro.
  webContents.on('will-attach-webview', (event) => {
    console.warn('[security] webview bloqueado');
    event.preventDefault();
  });
}

function protocoloDe(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

function configurarPermisos() {
  // El POS no usa cámara, micrófono, ubicación ni notificaciones del navegador:
  // se deniega todo en bloque en vez de mantener una lista blanca que envejece.
  // `geolocation` estaba permitido y no lo pedía nadie.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function registrarIPCHandlers() {
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-device-info', () => obtenerInfoDispositivo());
  ipcMain.handle('open-cash-drawer', async (_event, printerName) => abrirCajon(printerName));

  // Catálogo local (Prisma/SQLite). El renderer nunca toca la DB directo.
  ipcMain.handle('catalog:search', async (_event, term) => productsDb.search(await getPrisma(), term));
  ipcMain.handle('catalog:getByBarcode', async (_event, code) =>
    productsDb.getByBarcode(await getPrisma(), code));
  ipcMain.handle('catalog:recordStockEntry', async (_event, payload) =>
    productsDb.recordStockEntry(await getPrisma(), payload));
  ipcMain.handle('catalog:upsertMany', async (_event, products) =>
    productsDb.upsertMany(await getPrisma(), products));
  ipcMain.handle('catalog:getBatchesByProduct', async (_event, productId) =>
    productsDb.getBatchesByProduct(await getPrisma(), productId));
  ipcMain.handle('catalog:getPendingStockEntries', async () =>
    productsDb.getPendingStockEntries(await getPrisma()));
  ipcMain.handle('catalog:markStockEntrySynced', async (_event, batchLocalId, remoteProductId) =>
    productsDb.markStockEntrySynced(await getPrisma(), batchLocalId, remoteProductId));
  ipcMain.handle('catalog:markStockEntryPushFailed', async (_event, batchLocalId, message) =>
    productsDb.markStockEntryPushFailed(await getPrisma(), batchLocalId, message));

  // Edición de catálogo (`/pos/productos`): alta/edición de producto sin lote.
  ipcMain.handle('catalog:getProductById', async (_event, id) =>
    productsDb.getProductById(await getPrisma(), id));
  ipcMain.handle('catalog:createCatalogProduct', async (_event, fields) =>
    productsDb.createCatalogProduct(await getPrisma(), fields));
  ipcMain.handle('catalog:updateCatalogProduct', async (_event, id, fields) =>
    productsDb.updateCatalogProduct(await getPrisma(), id, fields));
  ipcMain.handle('catalog:getPendingCatalogPush', async () =>
    productsDb.getPendingCatalogPush(await getPrisma()));
  ipcMain.handle('catalog:markCatalogSynced', async (_event, localId, remoteId) =>
    productsDb.markCatalogSynced(await getPrisma(), localId, remoteId));
  ipcMain.handle('catalog:markCatalogPushFailed', async (_event, localId, message) =>
    productsDb.markCatalogPushFailed(await getPrisma(), localId, message));
  ipcMain.handle('catalog:clearCatalogPushError', async (_event, localId) =>
    productsDb.clearCatalogPushError(await getPrisma(), localId));

  // Ventas locales.
  ipcMain.handle('sales:createLocal', async (_event, sale) => salesDb.createLocal(await getPrisma(), sale));
  ipcMain.handle('sales:list', async (_event, filters) => salesDb.list(await getPrisma(), filters));
  ipcMain.handle('sales:getPendingPush', async (_event, filters) =>
    salesDb.getPendingPush(await getPrisma(), filters));
  ipcMain.handle('sales:listBlocked', async () => salesDb.listBlocked(await getPrisma()));
  ipcMain.handle('sales:markSynced', async (_event, localId, remoteId, remoteFolio) =>
    salesDb.markSynced(await getPrisma(), localId, remoteId, remoteFolio));
  ipcMain.handle('sales:markUnreconciled', async (_event, localId, reason) =>
    salesDb.markUnreconciled(await getPrisma(), localId, reason),
  );
  ipcMain.handle('sales:markPushFailed', async (_event, localId, message) =>
    salesDb.markPushFailed(await getPrisma(), localId, message));
  ipcMain.handle('sales:listMovements', async (_event, saleId) =>
    salesDb.listMovements(await getPrisma(), saleId),
  );
  ipcMain.handle('sales:voidLocal', async (_event, localId, voidedBy, voidedByLabel, reason) =>
    salesDb.voidLocal(await getPrisma(), localId, voidedBy, voidedByLabel, reason));
  ipcMain.handle('sales:clearPushError', async (_event, localId) =>
    salesDb.clearPushError(await getPrisma(), localId));
  ipcMain.handle('sales:discard', async (_event, localId) => salesDb.discard(await getPrisma(), localId));
  ipcMain.handle('sales:getPendingVoided', async () => salesDb.getPendingVoided(await getPrisma()));
  ipcMain.handle('sales:getNeedingRemoteVoid', async () => salesDb.getNeedingRemoteVoid(await getPrisma()));
  ipcMain.handle('sales:markNeedsRemoteVoid', async (_event, localId) =>
    salesDb.markNeedsRemoteVoid(await getPrisma(), localId),
  );
  ipcMain.handle('sales:markRemoteVoided', async (_event, localId) =>
    salesDb.markRemoteVoided(await getPrisma(), localId));

  // Bitácora de sincronización.
  ipcMain.handle('sync:getStatus', async () => syncRunsDb.getStatus(await getPrisma()));
  ipcMain.handle('sync:recordRun', async (_event, run) => syncRunsDb.recordRun(await getPrisma(), run));

  // Turnos de caja locales.
  ipcMain.handle('cashSessions:listBlocked', async () =>
    cashSessionsDb.listBlocked(await getPrisma()));
  ipcMain.handle('cashSessions:getOpenLocalAnyUser', async () =>
    cashSessionsDb.getOpenLocalAnyUser(await getPrisma()));
  ipcMain.handle('cashSessions:getOpenLocal', async (_event, userId) =>
    cashSessionsDb.getOpenLocal(await getPrisma(), userId));
  ipcMain.handle('cashSessions:createLocal', async (_event, input) =>
    cashSessionsDb.createLocal(await getPrisma(), input));
  ipcMain.handle('cashSessions:getLiveSummary', async (_event, sessionId) =>
    cashSessionsDb.getLiveSummary(await getPrisma(), sessionId));
  ipcMain.handle('cashSessions:getCashOnHand', async () =>
    cashSessionsDb.getCashOnHand(await getPrisma()));
  ipcMain.handle('cashSessions:closeLocal', async (_event, sessionId, input) =>
    cashSessionsDb.closeLocal(await getPrisma(), sessionId, input));
  ipcMain.handle('cashSessions:getPendingPush', async (_event, filters) =>
    cashSessionsDb.getPendingPush(await getPrisma(), filters));
  ipcMain.handle('cashSessions:getPendingClosePush', async (_event, filters) =>
    cashSessionsDb.getPendingClosePush(await getPrisma(), filters));
  ipcMain.handle('cashSessions:markCreateSynced', async (_event, localId, remoteId) =>
    cashSessionsDb.markCreateSynced(await getPrisma(), localId, remoteId));
  ipcMain.handle('cashSessions:markCloseSynced', async (_event, localId, values) =>
    cashSessionsDb.markCloseSynced(await getPrisma(), localId, values));
  ipcMain.handle('cashSessions:markPushFailed', async (_event, localId, message) =>
    cashSessionsDb.markPushFailed(await getPrisma(), localId, message));
  ipcMain.handle('cashSessions:markClosePushFailed', async (_event, localId, message) =>
    cashSessionsDb.markClosePushFailed(await getPrisma(), localId, message));
  ipcMain.handle('cashSessions:clearPushError', async (_event, localId) =>
    cashSessionsDb.clearPushError(await getPrisma(), localId));
  ipcMain.handle('cashSessions:clearClosePushError', async (_event, localId) =>
    cashSessionsDb.clearClosePushError(await getPrisma(), localId));
  ipcMain.handle('cashSessions:listLocal', async (_event, filters) =>
    cashSessionsDb.listLocal(await getPrisma(), filters));
  ipcMain.handle('cashSessions:updateAdjustmentStatus', async (_event, localId, values) =>
    cashSessionsDb.updateAdjustmentStatus(await getPrisma(), localId, values));

  // Movimientos de caja: depósitos, retiros y gastos (con categoría) de un turno.
  // Catálogos de servicios y doctores: solo lectura y pull. No hay `create` ni
  // cola de push a propósito — los administra el admin web.
  ipcMain.handle('pharmacyServices:list', async (_event, term) =>
    pharmacyServicesDb.listServices(await getPrisma(), term ?? ''));
  ipcMain.handle('pharmacyServices:listProviders', async () =>
    pharmacyServicesDb.listProviders(await getPrisma()));
  ipcMain.handle('pharmacyServices:upsertMany', async (_event, services) =>
    pharmacyServicesDb.upsertServices(await getPrisma(), services));
  ipcMain.handle('pharmacyServices:upsertProviders', async (_event, providers) =>
    pharmacyServicesDb.upsertProviders(await getPrisma(), providers));
  ipcMain.handle('promotions:listActive', async () =>
    promotionsDb.listActive(await getPrisma(), new Date()));
  ipcMain.handle('promotions:upsertMany', async (_event, promotions) =>
    promotionsDb.upsertMany(await getPrisma(), promotions));

  /**
   * El renderer recibió el aviso y va a decidir (puede tardar: cerrar un turno es
   * contar el efectivo). Se cancela el timeout de emergencia, que solo existe para
   * el caso de que NADIE conteste.
   */
  ipcMain.handle('app:close-pending', () => {
    clearTimeout(cierreTimeout);
  });
  // El renderer terminó su flujo de salida (turno resuelto o nada pendiente).
  ipcMain.handle('app:confirm-close', () => {
    cerrarVentana();
  });
  // "Cancelar": se olvida el intento para que la próxima X vuelva a preguntar.
  ipcMain.handle('app:cancel-close', () => {
    clearTimeout(cierreTimeout);
    cierreSolicitadoEn = 0;
  });

  ipcMain.handle('cashMovements:add', async (_event, cashSessionId, input) =>
    cashMovementsDb.addMovement(await getPrisma(), cashSessionId, input));
  ipcMain.handle('cashMovements:discard', async (_event, id) =>
    cashMovementsDb.discard(await getPrisma(), id));
  ipcMain.handle('cashMovements:listBlocked', async () =>
    cashMovementsDb.listBlocked(await getPrisma()));
  ipcMain.handle('cashMovements:updateExpense', async (_event, id, patch) =>
    cashMovementsDb.updateExpense(await getPrisma(), id, patch));
  ipcMain.handle('cashMovements:listForSession', async (_event, cashSessionId) =>
    cashMovementsDb.listForSession(await getPrisma(), cashSessionId));
  ipcMain.handle('cashMovements:listAllLocal', async (_event, filters) =>
    cashMovementsDb.listAllLocal(await getPrisma(), filters));
  ipcMain.handle('cashMovements:countAllLocal', async (_event, filters) =>
    cashMovementsDb.countAllLocal(await getPrisma(), filters));
  // Cerrojo consultado justo antes de emitir el POST de un movimiento: un turno
  // ya cerrado en el servidor no admite movimientos, y la petición saldría
  // condenada a 400.
  ipcMain.handle('cashMovements:assertPushable', async (_event, id) =>
    cashMovementsDb.assertPushable(await getPrisma(), id));
  ipcMain.handle('cashMovements:getPendingPush', async (_event, filters) =>
    cashMovementsDb.getPendingPush(await getPrisma(), filters));
  ipcMain.handle('cashMovements:markSynced', async (_event, localId, remoteId) =>
    cashMovementsDb.markSynced(await getPrisma(), localId, remoteId));
  ipcMain.handle('cashMovements:markPushFailed', async (_event, localId, message) =>
    cashMovementsDb.markPushFailed(await getPrisma(), localId, message));
  ipcMain.handle('cashMovements:clearPushError', async (_event, localId) =>
    cashMovementsDb.clearPushError(await getPrisma(), localId));
}

async function abrirCajon(printerName) {
  const name = typeof printerName === 'string' ? printerName.trim() : '';
  if (!name) {
    console.log('[cash-drawer] printerName vacío — no-op');
    return false;
  }
  // En Windows el pulso va por `copyFile(tmp, name)`: un `name` con ruta
  // escribiría el archivo donde diga esa ruta. Ver `security.js`.
  if (!isSafePrinterTarget(name)) {
    console.warn('[cash-drawer] printerName rechazado por la política de seguridad');
    return false;
  }

  const kick = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  const tempFile = path.join(os.tmpdir(), `farma-jyv-drawer-${Date.now()}.bin`);

  try {
    await fs.promises.writeFile(tempFile, kick);
    // Variantes async con timeout: una impresora/cajón que no responde (apagado,
    // atascado, recurso de red caído en Windows) ya no congela el proceso
    // principal —y con él todo el IPC— mientras el cobro espera.
    const io = process.platform === 'win32'
      ? fs.promises.copyFile(tempFile, name)
      : // `execFile` sin `shell:true` pasa `name` como argv aparte (execve), no
        // por un shell — no interpreta `&`/`|`/etc.
        execFileAsync('lp', ['-d', name, '-o', 'raw', tempFile]);
    await withTimeout(io, CASH_DRAWER_TIMEOUT_MS);
    return true;
  } catch (error) {
    console.error('[cash-drawer] error', error);
    return false;
  } finally {
    try {
      await fs.promises.unlink(tempFile);
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
