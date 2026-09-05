const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations');

/**
 * Respaldos que se conservan. Son copias completas de la base de una caja, así
 * que guardar todos llenaría el disco; cinco cubren varias actualizaciones
 * seguidas, que es cuando de verdad se necesita volver atrás.
 */
const MAX_BACKUPS = 5;

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function backupsDir(databasePath) {
  return path.join(path.dirname(databasePath), 'backups');
}

/**
 * Copia la base **antes** de aplicar migraciones pendientes.
 *
 * Existe porque una migración puede reconstruir una tabla entera (crear-copiar-
 * borrar-renombrar, que es lo que hace la de servicios con `SaleItem`): si algo
 * se corta a media pasada en una caja con años de historial, sin respaldo no
 * hay a dónde volver. Y en la caja no hay quien corra un `sqlite3 .backup` a
 * mano: tiene que pasar solo.
 *
 * Se usa `VACUUM INTO` y no una copia de archivo porque la base está abierta y
 * puede estar en modo WAL: copiar solo el `.sqlite` dejaría fuera el `-wal` y
 * el respaldo podría quedar inconsistente. `VACUUM INTO` escribe un archivo ya
 * consistente. Si el motor no lo soporta, se cae a la copia de archivo, que es
 * mejor que no tener nada.
 */
async function backupBeforeMigrating(prisma, databasePath) {
  const dir = backupsDir(databasePath);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(databasePath).replace(/\.sqlite$/i, '');
  const target = path.join(dir, `${base}-${stamp}.sqlite`);

  try {
    await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (error) {
    console.warn('[migrate] VACUUM INTO no disponible, se copia el archivo', error);
    fs.copyFileSync(databasePath, target);
  }

  pruneOldBackups(dir, base);
  return target;
}

/**
 * `true` si la base ya tiene tablas propias (algo que perder). Se excluye
 * `_local_migrations` porque `runMigrations` la crea siempre antes de mirar.
 */
async function hasUserTables(prisma) {
  try {
    const filas = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_local_migrations'",
    );
    return filas.length > 0;
  } catch {
    // Si no se puede saber, se respalda: equivocarse hacia el respaldo es barato.
    return true;
  }
}

/** Deja solo los `MAX_BACKUPS` más recientes; los nombres ordenan por fecha. */
function pruneOldBackups(dir, base) {
  const propios = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}-`) && name.endsWith('.sqlite'))
    .sort();
  for (const viejo of propios.slice(0, Math.max(0, propios.length - MAX_BACKUPS))) {
    try {
      fs.unlinkSync(path.join(dir, viejo));
    } catch {
      // Un respaldo que no se puede borrar no debe impedir la actualización.
    }
  }
}

/**
 * Aplica los `.sql` de `prisma/migrations` que falten, en orden por nombre de
 * carpeta (timestamp), llevando el registro en una tabla propia. No usa
 * `prisma migrate deploy` a propósito: así solo hay que empaquetar el motor de
 * consultas de Prisma (ya necesario para que corra el cliente) y no además el
 * motor de esquema/migraciones.
 *
 * Con `databasePath`, respalda la base antes de tocarla — solo si hay algo
 * pendiente, para no dejar una copia en cada arranque.
 */
async function runMigrations(prisma, { databasePath } = {}) {
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_local_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" TEXT NOT NULL)',
  );

  const appliedRows = await prisma.$queryRawUnsafe('SELECT "name" FROM "_local_migrations"');
  const applied = new Set(appliedRows.map((row) => row.name));

  const folders = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const pending = folders.filter((folder) => !applied.has(folder));
  if (!pending.length) {
    return { applied: [], backupPath: null };
  }

  let backupPath = null;
  // Se le pregunta a la base si tiene algo dentro, en vez de deducirlo del
  // registro de migraciones: `applied` vacío también ocurre en una base ANTERIOR
  // a este sistema de migraciones, y esa sí tiene datos que perder. Lo que no
  // hay que respaldar es una instalación nueva, donde Prisma ya creó el archivo
  // al conectarse pero todavía no hay ni una tabla.
  if (databasePath && fs.existsSync(databasePath) && (await hasUserTables(prisma))) {
    try {
      backupPath = await backupBeforeMigrating(prisma, databasePath);
      console.info(`[migrate] respaldo previo en ${backupPath}`);
    } catch (error) {
      // Se avisa y se sigue: negarse a migrar dejaría la caja inservible, que
      // es peor que migrar sin respaldo.
      console.error('[migrate] no se pudo respaldar la base antes de migrar', error);
    }
  }

  for (const folder of pending) {
    const sqlPath = path.join(MIGRATIONS_DIR, folder, 'migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const statements = splitStatements(sql);

    await prisma.$transaction([
      ...statements.map((statement) => prisma.$executeRawUnsafe(statement)),
      prisma.$executeRawUnsafe(
        'INSERT INTO "_local_migrations" ("name", "appliedAt") VALUES (?, ?)',
        folder,
        new Date().toISOString(),
      ),
    ]);
  }

  return { applied: pending, backupPath };
}

module.exports = { runMigrations, backupsDir, MAX_BACKUPS };
