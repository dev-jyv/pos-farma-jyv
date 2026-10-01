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
 * - `dev`      — nube de pruebas `farma-jyv-dev`.
 * - `prod`     — producción; default de la app empaquetada. **No** cambia la
 *                ruta: una caja instalada sigue leyendo su base de siempre.
 */
const APP_ENVIRONMENTS = ['emulator', 'dev', 'prod'];

/**
 * Orden de precedencia:
 * 1. `FARMAJYV_ENV` del proceso (lo ponen los scripts de npm).
 * 2. `farmajyvEnv` horneado en el `package.json` empaquetado
 *    (`-c.extraMetadata.farmajyvEnv=dev` en `release:dev:*`), para que un
 *    binario de dev-cloud nunca arranque sobre la carpeta de producción.
 * 3. `emulator` con `--dev`, `prod` en cualquier otro caso.
 *
 * Un valor desconocido no se adivina: se avisa y se usa el default, que en la
 * app empaquetada es `prod` (la ruta de siempre).
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
    warn(`[env] ${origen}="${valor}" no es válido (${APP_ENVIRONMENTS.join(' | ')}); se usa "${fallback}"`);
    return fallback;
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

module.exports = { APP_ENVIRONMENTS, resolveAppEnvironment, userDataDirFor };
