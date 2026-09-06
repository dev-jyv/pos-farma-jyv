const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { PrismaClient } = require('@prisma/client');
const { runMigrations } = require('./migrate');
const salesDb = require('./sales');

let prismaPromise = null;

function resolveDatabasePath() {
  return path.join(app.getPath('userData'), 'farmajyv-pos.sqlite');
}

/**
 * Cliente Prisma único del proceso main, con las migraciones locales ya
 * aplicadas. El renderer nunca lo toca directo: todo pasa por IPC.
 */
function getPrisma() {
  if (!prismaPromise) {
    const dbPath = resolveDatabasePath();
    const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
    // Se le pasa la ruta para que respalde la base antes de aplicar cualquier
    // migración pendiente (ver `backupBeforeMigrating`).
    prismaPromise = runMigrations(prisma, { databasePath: dbPath })
      .then(() => healOrphanRemoteVoidsOnce(prisma))
      .then(() => prisma);
  }
  return prismaPromise;
}

/**
 * Heal puntual de la regresión del void con `pendingPush` viejo. Corre una
 * sola vez por equipo (flag en userData); no se reencola en cada arranque.
 */
async function healOrphanRemoteVoidsOnce(prisma) {
  const flagPath = path.join(app.getPath('userData'), '.heal-orphan-remote-voids-v1');
  if (fs.existsSync(flagPath)) {
    return;
  }
  try {
    await salesDb.requeueOrphanRemoteVoids(prisma);
    fs.writeFileSync(flagPath, new Date().toISOString());
  } catch (error) {
    console.error('[db] no se pudo reencolar voids huérfanos', error);
  }
}

module.exports = { getPrisma, resolveDatabasePath };
