const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveAppEnvironment, userDataDirFor } = require('./app-environment');

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

/**
 * Carpeta de datos por entorno. Tiene que ir **antes** de cualquier
 * `app.getPath('userData')` —el cliente Prisma (`db/client.js`), `invoice-rag/`,
 * los flags de migración—, así que se resuelve aquí, antes de requerir la capa
 * de base de datos y antes de `app.whenReady()`. Ver `app-environment.js`.
 */
const APP_ENV = resolveAppEnvironment({
  envVar: process.env.FARMAJYV_ENV,
  bakedEnv: leerEntornoHorneado(),
  isDev,
});
const userDataPorEntorno = userDataDirFor(APP_ENV, app.getPath('appData'));
if (userDataPorEntorno) {
  app.setPath('userData', userDataPorEntorno);
}
console.log(`[env] entorno=${APP_ENV} userData=${app.getPath('userData')}`);

/** `farmajyvEnv` del `package.json` empaquetado (lo pone `release:dev:*`). */
function leerEntornoHorneado() {
  try {
    return require('../package.json').farmajyvEnv;
  } catch {
    return undefined;
  }
}

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
const { getPrisma, getPrismaIfOpen, resolveDatabasePath } = require('./db/client');
const { createRoutineBackups, routineBackupsDir } = require('./db/backup');
const { createLogger, sanitizeArgs } = require('./logger');
const { isAllowedNavigation, isSafePrinterTarget, isDevToolsShortcut } = require('./security');
const productsDb = require('./db/products');
const salesDb = require('./db/sales');
const syncRunsDb = require('./db/sync-runs');
const cashSessionsDb = require('./db/cash-sessions');
const cashMovementsDb = require('./db/cash-movements');
const pharmacyServicesDb = require('./db/pharmacy-services');
const promotionsDb = require('./db/promotions');
const couponsDb = require('./db/coupons');
const invoiceRagDb = require('./db/invoice-rag');
const syncLogDb = require('./db/sync-log');
const diagnosticsDb = require('./db/diagnostics');
const saleBlockers = require('./db/sale-blockers');

app.commandLine.appendSwitch('lang', 'es-MX');
app.commandLine.appendSwitch('accept-lang', 'es-MX,es;q=0.9');

const DEV_SERVER_URL = process.env.ELECTRON_DEV_SERVER_URL ?? 'http://localhost:4400';
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'farma-jyv-pos', 'browser', 'index.html');

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
    // En macOS la app sigue viva sin ventana y `activate` crea otra: sin este
    // reinicio la nueva ventana heredaría `cierreConfirmado` y cerraría sin preguntar.
    clearTimeout(cierreTimeout);
    cierreConfirmado = false;
    cierreSolicitadoEn = 0;
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

/** Canales de lectura pura: no se loguean (son miles por turno y no cambian nada). */
const CANALES_SILENCIOSOS = /^(catalog:(search|findByName|getByBarcode|getByIds|getBatchesByProduct|getProductById)|sales:(list|listMovements)|cashSessions:(getLiveSummary|getCashOnHand|listLocal|getOpenLocal.*)|promotions:listActive|coupons:findByCode|pharmacyServices:list.*|sync:getStatus|.*:(getPending\w*|getNeeding\w*|listBlocked\w*))$/;

let log = { info() {}, warn() {}, error() {}, prune() {} };

/** Cuánto puede retrasar el cierre de la app la copia de salida (SPEC 37). */
const QUIT_BACKUP_TIMEOUT_MS = 5_000;

/**
 * Copias de rutina de la base en `Documentos/FarmaJyV/respaldos`, tras cada
 * corte Z y al salir (ver `db/backup.js`). Nunca lanzan: un fallo se asienta en
 * el log de disco y en `SyncLog`, que viaja en el diagnóstico remoto.
 * Solo copian una base ya abierta (`getPrismaIfOpen`): salir sin haberla tocado
 * no la abre ni corre migraciones.
 */
const routineBackups = createRoutineBackups({
  getPrisma: getPrismaIfOpen,
  getDir: () => routineBackupsDir(app.getPath('documents'), APP_ENV),
  databasePath: resolveDatabasePath(),
  log: {
    info: (event, data) => log.info(event, data),
    error: (event, data) => log.error(event, data),
  },
  syncLog: syncLogDb,
});
/** La copia de salida ya se hizo (o se intentó) en este intento de cierre. */
let copiaDeSalidaHecha = false;

/** Envuelve `ipcMain.handle` para asentar canal, duración y resultado de cada escritura. */
function instrumentarIPC() {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) =>
    original(channel, async (event, ...args) => {
      const silencioso = CANALES_SILENCIOSOS.test(channel);
      const inicio = Date.now();
      try {
        const result = await handler(event, ...args);
        if (!silencioso) {
          log.info('ipc', { channel, ms: Date.now() - inicio, args: sanitizeArgs(args) });
        }
        return result;
      } catch (error) {
        log.error('ipc-error', {
          channel,
          ms: Date.now() - inicio,
          args: sanitizeArgs(args),
          message: error?.message ?? String(error),
          code: error?.code,
        });
        throw error;
      }
    });
}

app.whenReady().then(() => {
  log = createLogger(path.join(app.getPath('userData'), 'logs'));
  log.prune();
  log.info('app-start', { version: app.getVersion(), env: APP_ENV, platform: process.platform });
  process.on('uncaughtException', (error) => log.error('uncaughtException', { message: error?.message, stack: error?.stack }));
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', { message: String(reason?.message ?? reason) }));
  app.on('render-process-gone', (_e, _wc, details) => log.error('render-process-gone', { ...details }));
  instrumentarIPC();
  configurarPermisos();
  instalarMenu();
  registrarIPCHandlers();
  // Arranca migraciones ya (no bloquea la ventana): las llamadas IPC que
  // lleguen antes de terminar esperan la misma promesa dentro de `getPrisma()`.
  getPrisma()
    .then((prisma) =>
      // Limpieza best-effort de promociones cerradas hace más de 30 días y de la
      // bitácora de sync de más de 30 días. Va encadenada a las migraciones (las
      // tablas pueden no existir antes) y nunca se espera: un fallo aquí no debe
      // retrasar ni tumbar la caja.
      Promise.all([
        promotionsDb
          .purgeStale(prisma, new Date())
          .catch((error) => console.error('[db] no se pudieron purgar promociones viejas', error)),
        couponsDb
          .purgeStale(prisma, new Date())
          .catch((error) => console.error('[db] no se pudieron purgar cupones viejos', error)),
        syncLogDb
          .purgeOld(prisma, new Date())
          .catch((error) => console.error('[db] no se pudo purgar la bitácora de sync', error)),
      ]),
    )
    .catch((error) => console.error('[db] error al migrar', error));
  createWindow();
  verificarActualizaciones();
});

/**
 * Al salir: primero la copia de rutina (como mucho `QUIT_BACKUP_TIMEOUT_MS`),
 * luego se reanuda la salida. Electron no espera a un handler `async`, así que
 * se detiene la salida con `preventDefault` y se vuelve a pedir al terminar; en
 * esa segunda pasada ya no se copia. Si la copia falla o tarda, se sale igual:
 * una caja que no se deja cerrar es peor que una copia de menos (queda la del
 * último corte Z). Cerrar con el administrador de tareas no pasa por aquí.
 */
app.on('before-quit', (event) => {
  if (!copiaDeSalidaHecha) {
    copiaDeSalidaHecha = true;
    event.preventDefault();
    routineBackups
      .runWithTimeout('cierre', QUIT_BACKUP_TIMEOUT_MS)
      .catch(() => undefined)
      .finally(() => app.quit());
    return;
  }
  getPrismaIfOpen()
    .then((prisma) => prisma?.$disconnect())
    .catch(() => {
      // ya sin conexión o nunca se abrió; nada que cerrar.
    });
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

/**
 * Asienta en la bitácora local un fallo de subida que el renderer acaba de
 * marcar. Se hace aquí, en el único punto por donde pasan todos los
 * `markPushFailed`, en vez de repetirlo en cada servicio de Angular. Nunca
 * lanza: la bitácora es para diagnosticar, no puede romper el marcado.
 */
async function bitacoraFallo(prisma, entity, ref, message) {
  await syncLogDb.appendSafe(prisma, { level: 'error', entity, ref, message: String(message ?? '') });
}

function registrarIPCHandlers() {
  // Log del renderer (errores de UI, ventas rechazadas, sync). Solo escritura.
  ipcMain.handle('log:write', (_event, level, event, data) => {
    const fn = ['info', 'warn', 'error'].includes(level) ? level : 'info';
    log[fn](`ui:${String(event).slice(0, 60)}`, data && typeof data === 'object' ? data : { value: data });
  });
  ipcMain.handle('log:getDir', () => path.join(app.getPath('userData'), 'logs'));
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-device-info', () => obtenerInfoDispositivo());
  ipcMain.handle('open-cash-drawer', async (_event, printerName) => abrirCajon(printerName));

  // Catálogo local (Prisma/SQLite). El renderer nunca toca la DB directo.
  ipcMain.handle('catalog:search', async (_event, term) => productsDb.search(await getPrisma(), term));
  ipcMain.handle('catalog:findByName', async (_event, name, excludeId) =>
    productsDb.findByName(await getPrisma(), name, excludeId));
  ipcMain.handle('catalog:getByBarcode', async (_event, code) =>
    productsDb.getByBarcode(await getPrisma(), code));
  ipcMain.handle('catalog:getByIds', async (_event, ids) =>
    productsDb.getByIds(await getPrisma(), ids));
  ipcMain.handle('catalog:recordStockEntry', async (_event, payload) =>
    productsDb.recordStockEntry(await getPrisma(), payload));
  ipcMain.handle('catalog:upsertMany', async (_event, products) =>
    productsDb.upsertMany(await getPrisma(), products));
  ipcMain.handle('catalog:getBatchesByProduct', async (_event, productId) =>
    productsDb.getBatchesByProduct(await getPrisma(), productId));
  ipcMain.handle('catalog:getPendingStockEntries', async (_event, options) =>
    productsDb.getPendingStockEntries(await getPrisma(), options));
  ipcMain.handle('catalog:listBlockedStockEntries', async () =>
    productsDb.listBlockedStockEntries(await getPrisma()));
  ipcMain.handle('catalog:clearStockEntryPushError', async (_event, batchLocalId) =>
    productsDb.clearStockEntryPushError(await getPrisma(), batchLocalId));
  ipcMain.handle('catalog:discardStockEntry', async (_event, batchLocalId) =>
    productsDb.discardStockEntry(await getPrisma(), batchLocalId));
  ipcMain.handle('catalog:listBlockedProducts', async () =>
    productsDb.listBlockedProducts(await getPrisma()));
  ipcMain.handle('catalog:markStockEntrySynced', async (_event, batchLocalId, remoteProductId) =>
    productsDb.markStockEntrySynced(await getPrisma(), batchLocalId, remoteProductId));
  ipcMain.handle('catalog:markStockEntryPushFailed', async (_event, batchLocalId, message) => {
    const prisma = await getPrisma();
    await productsDb.markStockEntryPushFailed(prisma, batchLocalId, message);
    await bitacoraFallo(prisma, 'stockEntry', batchLocalId, `Entrada de stock rechazada: ${message}`);
  });

  // Edición de catálogo (`/pos/productos`): alta/edición de producto sin lote.
  ipcMain.handle('catalog:getProductById', async (_event, id) =>
    productsDb.getProductById(await getPrisma(), id));
  ipcMain.handle('catalog:createCatalogProduct', async (_event, fields) =>
    productsDb.createCatalogProduct(await getPrisma(), fields));
  ipcMain.handle('catalog:updateCatalogProduct', async (_event, id, fields) =>
    productsDb.updateCatalogProduct(await getPrisma(), id, fields));
  ipcMain.handle('catalog:getPendingCatalogPush', async () =>
    productsDb.getPendingCatalogPush(await getPrisma()));
  ipcMain.handle('catalog:markCatalogSynced', async (_event, localId, remoteId, pushedVersion) =>
    productsDb.markCatalogSynced(await getPrisma(), localId, remoteId, pushedVersion));
  ipcMain.handle('catalog:markCatalogPushFailed', async (_event, localId, message) => {
    const prisma = await getPrisma();
    await productsDb.markCatalogPushFailed(prisma, localId, message);
    await bitacoraFallo(prisma, 'product', localId, `Alta/edición de producto rechazada: ${message}`);
  });
  ipcMain.handle('catalog:retryProductPush', async (_event, localId) =>
    productsDb.retryProductPush(await getPrisma(), localId));
  ipcMain.handle('catalog:clearCatalogPushError', async (_event, localId) =>
    productsDb.clearCatalogPushError(await getPrisma(), localId));

  // Ventas locales.
  ipcMain.handle('sales:createLocal', async (_event, sale) => salesDb.createLocal(await getPrisma(), sale));
  ipcMain.handle('sales:list', async (_event, filters) => salesDb.list(await getPrisma(), filters));
  ipcMain.handle('sales:getPendingPush', async (_event, filters) =>
    salesDb.getPendingPush(await getPrisma(), filters));
  ipcMain.handle('sales:listBlocked', async (_event, filters) =>
    salesDb.listBlocked(await getPrisma(), filters));
  ipcMain.handle('sales:markSynced', async (_event, localId, remoteId, remoteFolio) =>
    salesDb.markSynced(await getPrisma(), localId, remoteId, remoteFolio));
  ipcMain.handle('sales:markUnreconciled', async (_event, localId, reason) =>
    salesDb.markUnreconciled(await getPrisma(), localId, reason),
  );
  ipcMain.handle('sales:markPushFailed', async (_event, localId, message) => {
    const prisma = await getPrisma();
    await salesDb.markPushFailed(prisma, localId, message);
    await bitacoraFallo(prisma, 'sale', localId, `Venta rechazada por el servidor: ${message}`);
  });
  ipcMain.handle('sales:diagnose', async (_event, saleId) =>
    saleBlockers.diagnoseSale(await getPrisma(), saleId));
  ipcMain.handle('sales:prepareUnreconciled', async (_event, localId) =>
    salesDb.prepareUnreconciled(await getPrisma(), localId));
  ipcMain.handle('sales:listMovements', async (_event, saleId) =>
    salesDb.listMovements(await getPrisma(), saleId),
  );
  ipcMain.handle('sales:voidLocal', async (_event, localId, voidedBy, voidedByLabel, reason) =>
    salesDb.voidLocal(await getPrisma(), localId, voidedBy, voidedByLabel, reason));
  ipcMain.handle('sales:clearPushError', async (_event, localId) =>
    salesDb.clearPushError(await getPrisma(), localId));
  ipcMain.handle('sales:discard', async (_event, localId) => salesDb.discard(await getPrisma(), localId));
  ipcMain.handle('sales:getPendingVoided', async (_event, filters) =>
    salesDb.getPendingVoided(await getPrisma(), filters));
  ipcMain.handle('sales:getNeedingRemoteVoid', async (_event, filters) =>
    salesDb.getNeedingRemoteVoid(await getPrisma(), filters));
  ipcMain.handle('sales:markNeedsRemoteVoid', async (_event, localId) =>
    salesDb.markNeedsRemoteVoid(await getPrisma(), localId),
  );
  ipcMain.handle('sales:markRemoteVoided', async (_event, localId) =>
    salesDb.markRemoteVoided(await getPrisma(), localId));

  // Bitácora de sincronización.
  ipcMain.handle('sync:getStatus', async () => syncRunsDb.getStatus(await getPrisma()));
  ipcMain.handle('sync:recordRun', async (_event, run) => {
    const prisma = await getPrisma();
    const result = await syncRunsDb.recordRun(prisma, run);
    if (run?.status === 'error') {
      await syncLogDb.appendSafe(prisma, {
        level: 'error',
        entity: 'sync',
        ref: run.entity ?? null,
        message: `Sync ${run.direction ?? ''} de ${run.entity ?? '?'} falló: ${run.errorMessage ?? 'sin detalle'}`,
      });
    }
    return result;
  });
  ipcMain.handle('syncLog:append', async (_event, entry) => syncLogDb.appendSafe(await getPrisma(), entry));
  ipcMain.handle('syncLog:list', async (_event, limit) => syncLogDb.listRecent(await getPrisma(), limit));
  // Foto para `POST /pos/diagnostics`. La identidad del equipo la pone main,
  // que es quien la conoce: el mismo `id` que `get-device-info` (hostname + MAC).
  ipcMain.handle('diagnostics:buildSnapshot', async () => {
    const info = obtenerInfoDispositivo();
    return diagnosticsDb.buildSnapshot(await getPrisma(), {
      deviceId: info.id,
      deviceName: info.hostname,
      appVersion: app.getVersion(),
      platform: `${info.plataforma}-${info.arquitectura}`,
      lastLocalBackupAt: routineBackups.lastBackupAt(),
    });
  });

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
  // Tras un corte Z exitoso, copia de rutina de la base. No se espera: el corte
  // ya quedó guardado y la copia no puede retrasarlo ni hacerlo fallar.
  ipcMain.handle('cashSessions:closeLocal', async (_event, sessionId, input) => {
    const closed = await cashSessionsDb.closeLocal(await getPrisma(), sessionId, input);
    void routineBackups.run('corte-z');
    return closed;
  });
  ipcMain.handle('cashSessions:getPendingPush', async (_event, filters) =>
    cashSessionsDb.getPendingPush(await getPrisma(), filters));
  ipcMain.handle('cashSessions:getPendingClosePush', async (_event, filters) =>
    cashSessionsDb.getPendingClosePush(await getPrisma(), filters));
  ipcMain.handle('cashSessions:markCreateSynced', async (_event, localId, remoteId) =>
    cashSessionsDb.markCreateSynced(await getPrisma(), localId, remoteId));
  ipcMain.handle('cashSessions:markCloseSynced', async (_event, localId, values) =>
    cashSessionsDb.markCloseSynced(await getPrisma(), localId, values));
  ipcMain.handle('cashSessions:markPushFailed', async (_event, localId, message) => {
    const prisma = await getPrisma();
    await cashSessionsDb.markPushFailed(prisma, localId, message);
    await bitacoraFallo(prisma, 'cashSession', localId, `Apertura de turno rechazada: ${message}`);
  });
  ipcMain.handle('cashSessions:markClosePushFailed', async (_event, localId, message) => {
    const prisma = await getPrisma();
    await cashSessionsDb.markClosePushFailed(prisma, localId, message);
    await bitacoraFallo(prisma, 'cashSession', localId, `Cierre de turno rechazado: ${message}`);
  });
  ipcMain.handle('cashSessions:retryPush', async (_event, localId) =>
    cashSessionsDb.retryPush(await getPrisma(), localId));
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
  ipcMain.handle('coupons:findByCode', async (_event, code) =>
    couponsDb.findByCode(await getPrisma(), code));
  ipcMain.handle('coupons:upsertMany', async (_event, coupons) =>
    couponsDb.upsertMany(await getPrisma(), coupons));

  const invoiceRagDir = path.join(app.getPath('userData'), 'invoice-rag');
  ipcMain.handle('invoiceRag:register', async (_event, input) =>
    invoiceRagDb.register(await getPrisma(), invoiceRagDir, input));
  ipcMain.handle('invoiceRag:readFile', async (_event, id) =>
    invoiceRagDb.readFile(await getPrisma(), id));
  ipcMain.handle('invoiceRag:list', async (_event, filters) =>
    invoiceRagDb.list(await getPrisma(), filters));
  ipcMain.handle('invoiceRag:getById', async (_event, id) =>
    invoiceRagDb.getById(await getPrisma(), id));
  ipcMain.handle('invoiceRag:saveExtraction', async (_event, id, input) =>
    invoiceRagDb.saveExtraction(await getPrisma(), id, input));
  ipcMain.handle('invoiceRag:markFailed', async (_event, id, message) =>
    invoiceRagDb.markFailed(await getPrisma(), id, message));
  ipcMain.handle('invoiceRag:confirm', async (_event, id, input) =>
    invoiceRagDb.confirm(await getPrisma(), id, input));
  ipcMain.handle('invoiceRag:search', async (_event, input) =>
    invoiceRagDb.search(await getPrisma(), input));
  ipcMain.handle('invoiceRag:markUploaded', async (_event, id, storagePath) =>
    invoiceRagDb.markUploaded(await getPrisma(), id, storagePath));
  ipcMain.handle('invoiceRag:applyStock', async (_event, id, input) =>
    invoiceRagDb.applyStock(await getPrisma(), id, input));
  ipcMain.handle('invoiceRag:remove', async (_event, id) =>
    invoiceRagDb.remove(await getPrisma(), id));

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
    // En macOS ⌘Q pasa por `before-quit` antes de preguntar; si se cancela, el
    // siguiente intento de salida vuelve a copiar.
    copiaDeSalidaHecha = false;
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
  ipcMain.handle('cashMovements:markPushFailed', async (_event, localId, message) => {
    const prisma = await getPrisma();
    await cashMovementsDb.markPushFailed(prisma, localId, message);
    await bitacoraFallo(prisma, 'cashMovement', localId, `Movimiento de caja rechazado: ${message}`);
  });
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
