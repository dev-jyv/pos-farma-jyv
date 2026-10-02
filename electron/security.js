const path = require('path');

/**
 * Política de seguridad del proceso principal, aparte de `main.js` para poder
 * probarla sin arrancar Electron.
 *
 * Todo lo de aquí es defensa en profundidad: asume que el renderer YA está
 * comprometido (un XSS, una dependencia envenenada) y limita lo que puede
 * conseguir desde ahí. Con `contextIsolation` y `nodeIntegration: false` el
 * renderer no tiene `require`, pero sí puede navegar la ventana a donde quiera
 * y llamar a cualquier canal IPC con cualquier argumento.
 */

/** Nombres de dispositivo de impresión de Windows que `copyFile` sí puede usar. */
const WINDOWS_DEVICE_NAMES = /^(?:LPT[1-9]|COM[1-9]|PRN)$/i;
/** `\\host\cola`: la forma real de dirigirse a una impresora compartida. */
const WINDOWS_PRINTER_SHARE = /^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+$/;
/** Un nombre de impresora larguísimo no es un nombre de impresora. */
const MAX_PRINTER_NAME = 255;

/**
 * Orígenes extra que solo existen en desarrollo: el dev server del renderer del
 * POS (4400, ver `angular.json`) y los emuladores del backend (functions 5001,
 * auth 9099). Nada de esto se consulta con `isDev: false`: la app empaquetada
 * sigue sin poder salir de su `index.html`.
 */
const DEV_ONLY_ORIGINS = Object.freeze([
  'http://localhost:4400',
  'http://127.0.0.1:5001',
  'http://127.0.0.1:9099',
]);

/**
 * ¿La ventana puede navegar a `targetUrl`?
 *
 * El POS es una sola pantalla: en producción vive en el `index.html` del bundle
 * y en desarrollo en el dev server. Cualquier otro destino es o un error o un
 * intento de llevarse la ventana (y con ella el `preload` y todo su IPC) a una
 * página ajena, así que se bloquea.
 *
 * `will-navigate` no se dispara con el enrutado de Angular (history API), solo
 * con navegaciones de verdad — así que esto no estorba a las rutas del POS.
 */
function isAllowedNavigation(targetUrl, { isDev = false, devServerUrl = '', appIndexPath = '' } = {}) {
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }

  if (url.protocol === 'file:') {
    if (!appIndexPath) {
      return false;
    }
    const appDir = path.dirname(path.resolve(appIndexPath));
    return isInside(appDir, fileUrlToPath(url));
  }

  if (isDev) {
    return devOrigins(devServerUrl).includes(url.origin);
  }

  return false;
}

/** Origen del dev server configurado (si es una URL válida) más `DEV_ONLY_ORIGINS`. */
function devOrigins(devServerUrl) {
  const origins = [...DEV_ONLY_ORIGINS];
  if (devServerUrl) {
    try {
      origins.push(new URL(devServerUrl).origin);
    } catch {
      // URL inválida: se ignora, quedan solo los orígenes fijos de desarrollo.
    }
  }
  return origins;
}

/** `file:///C:/x/y` → `C:\x\y`; `file:///x/y` → `/x/y`. */
function fileUrlToPath(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // Un `%` suelto hace estallar `decodeURIComponent`; sin poder normalizar la
    // ruta no hay forma de compararla, así que no se autoriza.
    return null;
  }
  return path.normalize(pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

/** ¿`target` cae dentro de `dir`? Compara rutas normalizadas, no cadenas. */
function isInside(dir, target) {
  if (!target) {
    return false;
  }
  const relative = path.relative(dir, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * ¿`name` es un destino de impresión aceptable?
 *
 * En Windows el pulso al cajón se manda con `fs.copyFile(tmp, name)`: si `name`
 * fuera una ruta (`C:\...\algo.dll`, `..\..\algo`), ese `copyFile` sobreescribe
 * el archivo que diga la ruta. El nombre sale de la configuración de build, no
 * de la pantalla, pero un renderer comprometido puede llamar al canal IPC con
 * lo que quiera — así que se valida aquí, del lado del proceso principal.
 *
 * Se aceptan las formas que de verdad llegan a una impresora (`\\host\cola`,
 * `LPT1`, `PRN`) y los nombres a secas —que es lo que hay configurado hoy—, y
 * se rechaza cualquier cosa con separadores de ruta, unidad o `..`.
 *
 * En macOS/Linux va por `execFile('lp', ['-d', name, ...])`: es argv, no un
 * shell, así que no hay inyección de comandos; solo se descarta lo que `lp`
 * confundiría con una opción y los caracteres de control.
 */
function isSafePrinterTarget(name, platform = process.platform) {
  if (typeof name !== 'string') {
    return false;
  }
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_PRINTER_NAME) {
    return false;
  }
  // NUL y saltos de línea: cortan rutas en las syscalls y ensucian argv.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return false;
  }
  // `lp` leería `-o` como opción, no como nombre de cola.
  if (trimmed.startsWith('-')) {
    return false;
  }

  if (platform !== 'win32') {
    return true;
  }

  if (WINDOWS_DEVICE_NAMES.test(trimmed) || WINDOWS_PRINTER_SHARE.test(trimmed)) {
    return true;
  }
  return !/[\\/:]/.test(trimmed) && !trimmed.includes('..');
}

/**
 * Atajos que abren las herramientas de desarrollo.
 *
 * Con DevTools abierto, la consola del renderer llama `window.electronAPI` a
 * mano, y ningún handler de IPC comprueba quién es el usuario: desde ahí se
 * listan los cortes de todo el equipo, se firma una anulación con el uid de
 * otro o se reescribe el precio de un producto. Es decir, se salta **todos** los
 * guards de rol de la caja. En un equipo de mostrador, al alcance de cualquiera.
 */
function isDevToolsShortcut(input) {
  if (!input || input.type !== 'keyDown') {
    return false;
  }
  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  if (key === 'f12') {
    return true;
  }
  // ⌘⌥I (macOS) y Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C (Windows y Linux).
  const conModificador = input.meta ? input.alt : input.control && input.shift;
  return Boolean(conModificador) && ['i', 'j', 'c'].includes(key);
}

module.exports = { DEV_ONLY_ORIGINS, isAllowedNavigation, isSafePrinterTarget, isDevToolsShortcut };
