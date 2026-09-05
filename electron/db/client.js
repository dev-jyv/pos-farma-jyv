const path = require('path');
const { app } = require('electron');
const { PrismaClient } = require('@prisma/client');
const { runMigrations } = require('./migrate');

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
    prismaPromise = runMigrations(prisma, { databasePath: dbPath }).then(() => prisma);
  }
  return prismaPromise;
}

module.exports = { getPrisma, resolveDatabasePath };
