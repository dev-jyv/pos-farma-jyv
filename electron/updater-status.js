/**
 * Estado de la actualización automática de la caja (SPEC 67, E4).
 *
 * En macOS sin firma (`identity: null`) el actualizador falla en silencio: el
 * error solo iba a `console` y nadie se enteraba de que la caja seguía en una
 * versión vieja. Aquí se guarda el último resultado (`updateError`,
 * `updateCheckedAt`) para que viaje en el diagnóstico remoto, y cada error
 * nuevo se asienta en la bitácora local (`SyncLog`, `entity: 'actualizacion'`).
 *
 * Vive en memoria a propósito: el actualizador consulta en cada arranque, así
 * que tras reiniciar el estado se vuelve a llenar con el resultado de hoy.
 */

const ENTITY = 'actualizacion';
/** Un error de red puede traer un HTML entero; el diagnóstico solo necesita la causa. */
const MAX_ERROR_LENGTH = 500;

function messageOf(error) {
  const raw = error?.message ?? error;
  const text = String(raw ?? '').trim() || 'Error desconocido del actualizador';
  return text.slice(0, MAX_ERROR_LENGTH);
}

/**
 * `log(entry)` escribe en `SyncLog` (en main: `syncLogDb.appendSafe`). Nunca
 * debe romper al actualizador, así que sus fallos se tragan aquí también.
 */
function createUpdaterStatus({ log = null, now = () => new Date() } = {}) {
  let updateError = null;
  let updateCheckedAt = null;
  /** Último error asentado: el evento `error` y la promesa rechazada traen el mismo. */
  let lastLogged = null;

  async function writeLog(entry) {
    if (!log) return;
    try {
      await log(entry);
    } catch {
      // La bitácora es de apoyo.
    }
  }

  return {
    /** La consulta respondió (haya o no versión nueva): ya no hay error vigente. */
    recordSuccess() {
      updateCheckedAt = now().toISOString();
      updateError = null;
      lastLogged = null;
    },

    async recordError(error) {
      const message = messageOf(error);
      updateCheckedAt = now().toISOString();
      updateError = message;
      if (lastLogged === message) {
        return;
      }
      lastLogged = message;
      await writeLog({
        level: 'error',
        entity: ENTITY,
        message: `La actualización automática falló: ${message}`,
        ref: null,
      });
    },

    /** Lo que viaja en el diagnóstico; `null` = sin dato. */
    snapshot() {
      return { updateError, updateCheckedAt };
    },
  };
}

/**
 * Conecta los eventos de `electron-updater` con el estado. `checkForUpdates`
 * se lanza aparte (quien llama decide cuándo); su rechazo también va a
 * `recordError` (si es el mismo error que el evento, no se asienta dos veces).
 */
function attachUpdater(autoUpdater, status, { info = () => undefined } = {}) {
  autoUpdater.on('error', (error) => {
    info(`[updater] error: ${messageOf(error)}`);
    void status.recordError(error);
  });
  autoUpdater.on('update-not-available', () => {
    status.recordSuccess();
  });
  autoUpdater.on('update-available', (update) => {
    info(`[updater] actualización disponible: ${update?.version}`);
    status.recordSuccess();
  });
  autoUpdater.on('update-downloaded', (update) => {
    info(`[updater] descargada ${update?.version}; se instalará al cerrar la app`);
    status.recordSuccess();
  });
}

module.exports = { createUpdaterStatus, attachUpdater, ENTITY, MAX_ERROR_LENGTH };
