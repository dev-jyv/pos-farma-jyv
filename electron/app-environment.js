const path = require('path');

/**
 * Entorno del proceso principal y carpeta de datos (`userData`) que le toca.
 *
 * Aparte de `main.js` para poder probarlo sin arrancar Electron.
 *
 * Por qué existe: `userData` guarda la base SQLite (`farmajyv-pos.sqlite`), las
 * facturas de `invoice-rag/` y los flags de migración. Antes, `electron:dev`
 * caía en `~/Library/Application Support/Electron/` —la misma carpeta que usa
 * `electron:start` contra producción—, así que una venta de prueba contra el
 * emulador podía quedar en una base con datos sincronizados de la farmacia real,
 * y al revés. Ahora cada entorno que no es producción tiene su propia carpeta.
 *
 * Valores:
 * - `emulator` — backend local (`demo-farmajyv`), default con `--dev`.
 * - `prod`     — producción; default de la app empaquetada. **No** cambia la
 *                ruta: una caja instalada sigue leyendo su base de siempre.
 *
 * Hubo un tercero, `dev` (nube de pruebas `farma-jyv-dev`, binario
 * "FarmaJyV Venta DEV"). El proyecto se borró el 2026-11-18 y el valor se
 * retiró: ver `RETIRED_ENVIRONMENTS`.
 */
const APP_ENVIRONMENTS = ['emulator', 'prod'];

/**
 * Entornos que existieron y ya no. Se tratan como cualquier valor inválido
 * (se avisa, se ignora y se pasa a la siguiente fuente), pero con un aviso que
 * dice qué pasó en vez de un genérico "no es válido".
 */
const RETIRED_ENVIRONMENTS = {
  dev: 'el proyecto farma-jyv-dev se borró el 2026-11-18; usa `emulator` (emuladores locales) o `prod`',
};

/**
 * Orden de precedencia:
 * 1. `FARMAJYV_ENV` del proceso (lo ponen los scripts de npm).
 * 2. `farmajyvEnv` horneado en el `package.json` empaquetado
 *    (`-c.extraMetadata.farmajyvEnv=<entorno>`). Ningún script lo pone hoy:
 *    lo usaba el binario DEV, que ya no se compila.
 * 3. `emulator` con `--dev`, `prod` en cualquier otro caso.
 *
 * Un valor desconocido no se adivina: se avisa, se ignora y se consulta la
 * siguiente fuente. Si ninguna es válida se usa el default, que en la app
 * empaquetada es `prod` (la ruta de siempre).
 */
function resolveAppEnvironment({ envVar, bakedEnv, isDev = false, warn = console.warn } = {}) {
  const fallback = isDev ? 'emulator' : 'prod';
  for (const [origen, valor] of [['FARMAJYV_ENV', envVar], ['package.json#farmajyvEnv', bakedEnv]]) {
    const limpio = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
    if (!limpio) {
      continue;
    }
    if (APP_ENVIRONMENTS.includes(limpio)) {
      return limpio;
    }
    // Un valor inválido no corta la cadena: si no, un typo en `FARMAJYV_ENV`
    // haría que un binario ignore su `farmajyvEnv` horneado.
    const motivo = Object.hasOwn(RETIRED_ENVIRONMENTS, limpio)
      ? RETIRED_ENVIRONMENTS[limpio]
      : `no es válido (${APP_ENVIRONMENTS.join(' | ')})`;
    warn(`[env] ${origen}="${valor}" ${motivo}; se ignora`);
  }
  return fallback;
}

/**
 * Carpeta `userData` para `env`, o `null` si se deja la default de Electron
 * (producción).
 */
function userDataDirFor(env, appDataDir) {
  if (env === 'prod') {
    return null;
  }
  return path.join(appDataDir, `FarmaJyV Venta (${env})`);
}

module.exports = { APP_ENVIRONMENTS, RETIRED_ENVIRONMENTS, resolveAppEnvironment, userDataDirFor };
