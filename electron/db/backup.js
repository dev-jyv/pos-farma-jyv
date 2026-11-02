const fs = require('fs');
const path = require('path');

/**
 * Copias de la base SQLite de la caja.
 *
 * Hay dos tipos y viven en carpetas distintas:
 *
 * - **Previas a migración** (`pre-migracion`): en `userData/backups`, las hace
 *   `runMigrations` antes de tocar el esquema (ver `migrate.js`). No cuentan en
 *   la rotación de rutina ni se mueven de lugar.
 * - **De rutina** (`corte-z`, `cierre`): en `Documentos/FarmaJyV/respaldos`, tras
 *   cada corte Z y al salir de la app (SPEC 37). Existen porque las ventas sin
 *   sincronizar solo viven en `userData/farmajyv-pos.sqlite`: si se borra el
 *   perfil de la app antes del siguiente envío, ese dinero cobrado no queda en
 *   ningún lado. Por eso van **fuera** de `userData`. Se conservan las últimas 7.
 *
 * No protegen contra una falla del disco (misma unidad) ni se suben a la nube.
 */

const DEFAULT_BASE = 'farmajyv-pos';
const MIGRATION_REASON = 'pre-migracion';
/** Motivos de las copias de rutina: son los únicos que entran en la rotación. */
const ROUTINE_REASONS = Object.freeze(['corte-z', 'cierre']);
const MAX_ROUTINE_BACKUPS = 7;
/** Sufijo del archivo mientras se escribe: una copia cortada a media pasada no se confunde con una buena. */
const PARTIAL_SUFFIX = '.partial';

const STAMP_RE = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `2026-11-02T20:39:30.695Z` → `2026-11-02T20-39-30-695Z` (válido en Windows). */
function stampOf(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Inverso de `stampOf`. */
function isoOfStamp(stamp) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : null;
}

/**
 * Interpreta un nombre `<base>-<reason>-<timestamp>[-n].sqlite`. También acepta
 * el formato anterior de las copias previas a migración, sin motivo
 * (`<base>-<timestamp>.sqlite`), que devuelve `reason: null`.
 * El motivo empieza con letra, así que nunca se come la fecha.
 */
function parseBackupName(name, base = DEFAULT_BASE) {
  const re = new RegExp(
    `^${escapeRegExp(base)}-(?:([a-z][a-z0-9-]*?)-)?${STAMP_RE}(?:-(\\d+))?\\.sqlite$`,
  );
  const match = re.exec(name);
  if (!match) return null;
  const createdAt = isoOfStamp(match[2]);
  if (!createdAt) return null;
  return { name, reason: match[1] ?? null, stamp: match[2], seq: Number(match[3] ?? 0), createdAt };
}

function compareParsed(a, b) {
  if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1;
  return a.seq - b.seq;
}

function listParsed(dir, base) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => parseBackupName(name, base))
    .filter(Boolean)
    .sort(compareParsed);
}

/**
 * Ruta libre para la copia. El timestamp con milisegundos ya evita colisiones
 * (Windows bloquea un archivo abierto por el antivirus o por quien lo copia);
 * el sufijo `-n` cubre dos copias en el mismo milisegundo.
 */
function freeTarget(dir, base, reason, date) {
  const stem = `${base}-${reason}-${stampOf(date)}`;
  let candidate = path.join(dir, `${stem}.sqlite`);
  for (let n = 1; fs.existsSync(candidate) || fs.existsSync(candidate + PARTIAL_SUFFIX); n += 1) {
    candidate = path.join(dir, `${stem}-${n}.sqlite`);
  }
  return candidate;
}

function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Ya no está o está bloqueado: no es motivo para fallar.
  }
}

/**
 * Copia la base abierta a `dir/<base>-<reason>-<timestamp>.sqlite`.
 *
 * Se usa `VACUUM INTO` y no una copia de archivo porque la base está abierta y
 * puede estar en modo WAL: copiar solo el `.sqlite` dejaría fuera el `-wal` y la
 * copia podría quedar inconsistente. `VACUUM INTO` lee una foto ya confirmada:
 * una venta que se esté escribiendo en ese momento (transacción abierta) no
 * entra a medias, entra completa en la siguiente copia.
 *
 * Se escribe primero a `<nombre>.partial` y se renombra al terminar, para que
 * una copia cortada (la app se cerró a los 5 s, disco lleno) nunca cuente como
 * buena ni en la rotación ni en `lastLocalBackupAt`.
 *
 * `fileCopyFallback`: si `VACUUM INTO` falla, copia el archivo. Solo lo usa la
 * copia previa a migración (nadie más escribe en ese momento y es mejor algo
 * que nada); en una copia de rutina con la caja viva, un archivo copiado a
 * media escritura sería peor que admitir el fallo.
 *
 * Lanza si no se pudo copiar; quien llama decide si eso importa.
 */
async function backupDatabase(prisma, {
  dir,
  reason,
  databasePath = null,
  base = DEFAULT_BASE,
  now = new Date(),
  fileCopyFallback = false,
} = {}) {
  if (!dir) throw new Error('backupDatabase: falta la carpeta destino');
  if (!/^[a-z][a-z0-9-]*$/.test(String(reason ?? ''))) {
    throw new Error(`backupDatabase: motivo inválido "${reason}"`);
  }
  // Se crea siempre: alguien pudo borrar la carpeta a mano desde la última copia.
  fs.mkdirSync(dir, { recursive: true });

  const target = freeTarget(dir, base, reason, now);
  const partial = target + PARTIAL_SUFFIX;
  try {
    try {
      await prisma.$executeRawUnsafe(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
    } catch (error) {
      if (!fileCopyFallback || !databasePath) throw error;
      console.warn('[backup] VACUUM INTO no disponible, se copia el archivo', error);
      unlinkQuiet(partial);
      fs.copyFileSync(databasePath, partial);
    }
    fs.renameSync(partial, target);
  } catch (error) {
    unlinkQuiet(partial);
    throw error;
  }
  return { path: target, reason, createdAt: now.toISOString() };
}

/**
 * Deja solo las `keep` copias de rutina más recientes de `dir`. No toca nada que
 * no sea una copia de rutina con nombre reconocible: ni las previas a migración
 * (aunque alguien las pusiera en la misma carpeta) ni archivos ajenos.
 * Además borra los `.partial` que dejó una copia cortada.
 */
function pruneRoutineBackups(dir, { base = DEFAULT_BASE, keep = MAX_ROUTINE_BACKUPS } = {}) {
  if (!fs.existsSync(dir)) return [];
  const routine = listParsed(dir, base).filter((item) => ROUTINE_REASONS.includes(item.reason));
  const removed = [];
  for (const old of routine.slice(0, Math.max(0, routine.length - keep))) {
    try {
      fs.unlinkSync(path.join(dir, old.name));
      removed.push(old.name);
    } catch {
      // Una copia que no se puede borrar (bloqueada) no debe tumbar la siguiente.
    }
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(PARTIAL_SUFFIX) && parseBackupName(name.slice(0, -PARTIAL_SUFFIX.length), base)) {
      unlinkQuiet(path.join(dir, name));
    }
  }
  return removed;
}

/**
 * Para las copias previas a migración (`userData/backups`): conserva las `keep`
 * más recientes, con motivo `pre-migracion` o con el nombre anterior sin motivo.
 */
function pruneMigrationBackups(dir, { base = DEFAULT_BASE, keep }) {
  if (!fs.existsSync(dir)) return [];
  const own = listParsed(dir, base).filter((item) => item.reason === null || item.reason === MIGRATION_REASON);
  const removed = [];
  for (const old of own.slice(0, Math.max(0, own.length - keep))) {
    try {
      fs.unlinkSync(path.join(dir, old.name));
      removed.push(old.name);
    } catch {
      // Un respaldo que no se puede borrar no debe impedir la actualización.
    }
  }
  return removed;
}

/** ISO de la copia de rutina más reciente que hay en `dir`, o `null`. */
function lastRoutineBackupAt(dir, { base = DEFAULT_BASE } = {}) {
  try {
    const routine = listParsed(dir, base).filter((item) => ROUTINE_REASONS.includes(item.reason));
    return routine.length ? routine[routine.length - 1].createdAt : null;
  } catch {
    return null;
  }
}

/**
 * Carpeta de las copias de rutina: `Documentos/FarmaJyV/respaldos`. Fuera de
 * producción se separa por entorno (`respaldos (dev)`), igual que `userData`
 * (ver `app-environment.js`): sin eso, abrir la app de pruebas en una caja
 * rotaría y borraría las copias de la base real.
 */
function routineBackupsDir(documentsPath, env = 'prod') {
  const folder = !env || env === 'prod' ? 'respaldos' : `respaldos (${env})`;
  return path.join(documentsPath, 'FarmaJyV', folder);
}

/**
 * Orquestador de las copias de rutina del proceso main. Nunca lanza: una copia
 * fallida (disco lleno, sin permiso en Documentos) se asienta en el log de disco
 * y en `SyncLog` —que viaja en el diagnóstico remoto— y la caja sigue.
 *
 * Serializa: si ya hay una copia en curso (corte Z y salir enseguida), quien
 * llega espera esa misma en vez de lanzar otro `VACUUM INTO` encima.
 */
function createRoutineBackups({
  getPrisma,
  getDir,
  databasePath = null,
  base = DEFAULT_BASE,
  keep = MAX_ROUTINE_BACKUPS,
  log = console,
  syncLog = null,
  now = () => new Date(),
}) {
  let inFlight = null;
  /** Cliente de la copia en curso, para asentar un timeout sin volver a pedirlo. */
  let currentPrisma = null;
  /** Tope para escribir en `SyncLog` al salir: la bitácora no puede alargar el cierre. */
  const RECORD_ON_QUIT_MS = 500;

  async function record(prisma, reason, error) {
    const message = error?.message ?? String(error);
    try {
      log.error?.('local-backup-failed', { reason, message });
    } catch {
      /* el log nunca rompe */
    }
    if (syncLog && prisma) {
      await syncLog.appendSafe(prisma, {
        level: 'error',
        entity: 'respaldo',
        ref: reason,
        message: `No se pudo hacer la copia local (${reason}): ${message}`,
      });
    }
  }

  async function doRun(reason) {
    let prisma = null;
    const started = Date.now();
    try {
      prisma = await getPrisma();
      if (!prisma) return { ok: false, skipped: true };
      currentPrisma = prisma;
      if (databasePath && !fs.existsSync(databasePath)) return { ok: false, skipped: true };
      const dir = getDir();
      const result = await backupDatabase(prisma, { dir, reason, databasePath, base, now: now() });
      const removed = pruneRoutineBackups(dir, { base, keep });
      try {
        log.info?.('local-backup', { reason, file: path.basename(result.path), ms: Date.now() - started, removed: removed.length });
      } catch {
        /* el log nunca rompe */
      }
      return { ok: true, ...result };
    } catch (error) {
      await record(prisma, reason, error);
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  function run(reason) {
    if (inFlight) return inFlight;
    inFlight = doRun(reason).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /**
   * Para `before-quit`: espera la copia como mucho `timeoutMs`. Si se pasa, se
   * sale igual (el `.partial` que quede se limpia en la siguiente copia y no
   * cuenta como copia buena) y se asienta en la bitácora.
   */
  async function runWithTimeout(reason, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
    });
    const result = await Promise.race([run(reason), timeout]).finally(() => clearTimeout(timer));
    if (result?.timedOut) {
      const error = new Error(`la copia tardó más de ${Math.round(timeoutMs / 1000)} s; se omitió`);
      let recordTimer;
      await Promise.race([
        record(currentPrisma, reason, error),
        new Promise((resolve) => {
          recordTimer = setTimeout(resolve, RECORD_ON_QUIT_MS);
        }),
      ]).finally(() => clearTimeout(recordTimer));
    }
    return result;
  }

  function lastBackupAt() {
    try {
      return lastRoutineBackupAt(getDir(), { base });
    } catch {
      return null;
    }
  }

  return { run, runWithTimeout, lastBackupAt };
}

module.exports = {
  backupDatabase,
  pruneRoutineBackups,
  pruneMigrationBackups,
  lastRoutineBackupAt,
  routineBackupsDir,
  parseBackupName,
  createRoutineBackups,
  ROUTINE_REASONS,
  MIGRATION_REASON,
  MAX_ROUTINE_BACKUPS,
  PARTIAL_SUFFIX,
};
