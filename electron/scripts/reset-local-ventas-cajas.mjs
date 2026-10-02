/**
 * Borra ventas y turnos de caja de la base **local** de este equipo.
 *
 * Solo toca el SQLite del POS (`farmajyv-pos.sqlite`). No borra nada del
 * servidor: lo que ya sincronizó sigue allá, y volverá a verse en el historial
 * en cuanto la app lo consulte. Es una herramienta de desarrollo para dejar el
 * equipo en limpio, no una forma de anular ventas.
 *
 * Uso:
 *   node electron/scripts/reset-local-ventas-cajas.mjs            # simulacro
 *   node electron/scripts/reset-local-ventas-cajas.mjs --si       # borra
 *
 * Requiere la app cerrada: la base está en `journal_mode = delete`, así que
 * escribir con Electron abierto la deja bloqueada para el proceso principal.
 *
 * El stock no se recalcula aquí a propósito: `products.js` repuebla
 * `totalStock` desde el servidor en cada sincronización de catálogo, así que se
 * recompone solo y tocarlo aquí solo añadiría una fuente de verdad más.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

/** Mismo criterio que `resolveDatabasePath()` en `electron/db/client.js`. */
function resolveDatabasePath() {
  const appName = process.env.POS_APP_NAME ?? 'Electron';
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', appName, 'farmajyv-pos.sqlite');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? '', appName, 'farmajyv-pos.sqlite');
  }
  return path.join(homedir(), '.config', appName, 'farmajyv-pos.sqlite');
}

function appEstaCorriendo() {
  try {
    execSync('pgrep -f "electron/main.js"', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Orden de borrado: primero los hijos. Sin esto, las claves foráneas rechazan.
const TABLAS = [
  ['saleMovement', 'Movimientos de venta'],
  ['saleItem', 'Partidas de venta'],
  ['sale', 'Ventas'],
  ['cashMovement', 'Movimientos de caja (gastos, depósitos, retiros)'],
  ['cashSession', 'Turnos de caja'],
];

async function main() {
  const ejecutar = process.argv.includes('--si');
  const dbPath = resolveDatabasePath();

  if (!existsSync(dbPath)) {
    console.error(`No existe la base local en:\n  ${dbPath}`);
    process.exit(1);
  }
  if (ejecutar && appEstaCorriendo()) {
    console.error(
      'La app está abierta. Ciérrala antes de borrar: escribir con Electron\n' +
        'corriendo deja la base bloqueada para el proceso principal.',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  console.log(`Base: ${dbPath}\n`);

  const antes = {};
  for (const [modelo, etiqueta] of TABLAS) {
    antes[modelo] = await prisma[modelo].count();
    console.log(`  ${etiqueta.padEnd(48)} ${antes[modelo]}`);
  }

  const total = Object.values(antes).reduce((suma, n) => suma + n, 0);
  if (total === 0) {
    console.log('\nNo hay nada que borrar.');
    await prisma.$disconnect();
    return;
  }

  if (!ejecutar) {
    console.log(`\nSimulacro: se borrarían ${total} filas. Repite con --si para hacerlo.`);
    await prisma.$disconnect();
    return;
  }

  // Respaldo antes de tocar nada: es la única vuelta atrás.
  const respaldo = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(dbPath, respaldo);
  console.log(`\nRespaldo: ${respaldo}`);

  for (const [modelo, etiqueta] of TABLAS) {
    const { count } = await prisma[modelo].deleteMany({});
    console.log(`  Borrados ${String(count).padStart(4)}  ${etiqueta}`);
  }

  console.log('\nListo. El stock se repuebla del servidor en la próxima sincronización.');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('Falló el borrado:', error.message);
  process.exit(1);
});
