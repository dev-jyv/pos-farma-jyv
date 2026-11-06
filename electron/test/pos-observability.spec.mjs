import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import diagnostics from '../db/diagnostics.js';
import syncLog from '../db/sync-log.js';
import updater from '../updater-status.js';

/**
 * Observabilidad de cajas (SPEC 67, lado POS), contra SQLite de verdad: la
 * muestra diaria de stock y el error del actualizador que viajan en el
 * diagnóstico remoto.
 */

let tmpDir;
let dbPath;
let prisma;

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-observabilidad-'));
  dbPath = path.join(tmpDir, 'farmajyv-pos.sqlite');
  prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  await migrate.runMigrations(prisma, { databasePath: dbPath });
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.product.deleteMany();
  await prisma.syncLog.deleteMany();
});

const AHORA = new Date('2026-11-06T15:00:00.000Z');
const DEVICE = {
  deviceId: 'caja-1-aabb',
  deviceName: 'caja-1',
  appVersion: '1.4.0',
  platform: 'darwin-arm64',
};

async function producto(id, extra = {}) {
  return prisma.product.create({
    data: {
      id,
      remoteId: `Rmt${id.padEnd(17, '0')}`,
      sku: `SKU-${id}`,
      name: `Producto ${id}`,
      salePrice: 10,
      totalStock: 20,
      ...extra,
    },
  });
}

let folio = 0;
async function venta(productId, quantity, { createdAt = AHORA, pendingPush = false, voidedAt = null } = {}) {
  folio += 1;
  await prisma.sale.create({
    data: {
      folio: `V-${folio}`,
      idempotencyKey: `k-${folio}-${Math.random()}`,
      subtotal: 10 * quantity,
      discountTotal: 0,
      total: 10 * quantity,
      paymentMethod: 'cash',
      cashSessionId: 'cs-1',
      cashierId: 'uid-cajero',
      payloadJson: '{}',
      pendingPush,
      voidedAt,
      createdAt,
      items: {
        create: [
          {
            kind: 'product',
            productId,
            productName: 'x',
            unitPrice: 10,
            discountAmount: 0,
            quantity,
            subtotal: 10 * quantity,
          },
        ],
      },
    },
  });
}

describe('muestra diaria de stock (SPEC 67, E3)', () => {
  it('prioriza los más vendidos de 7 días y excluye lo que tiene pendientes de subida', async () => {
    await producto('a', { totalStock: 7 });
    await producto('b');
    await producto('c');
    await producto('ventaPendiente');
    await producto('lotePendiente');
    await producto('catalogoPendiente', { pendingCatalogPush: true });
    await producto('sinRemoto', { remoteId: null });
    await prisma.product.create({ data: { id: 'local', sku: 'L', name: 'Local', salePrice: 1 } });

    await venta('b', 1);
    await venta('a', 3);
    await venta('a', 2, { createdAt: new Date('2026-11-05T15:00:00.000Z') });
    // Fuera de la ventana de 7 días, o anulada: no cuenta para priorizar.
    await venta('c', 50, { createdAt: new Date('2026-10-20T15:00:00.000Z') });
    await venta('c', 50, { voidedAt: AHORA });
    await venta('ventaPendiente', 1, { pendingPush: true });
    await prisma.batch.create({
      data: { productId: 'lotePendiente', quantity: 5, pendingPush: true, payloadJson: '{}' },
    });

    const muestra = await diagnostics.stockSampleOf(prisma, AHORA);

    expect(muestra).toEqual([
      { productId: 'Rmta0000000000000000', localStock: 7 },
      { productId: 'Rmtb0000000000000000', localStock: 20 },
      { productId: 'Rmtc0000000000000000', localStock: 20 },
    ]);
  });

  it('manda como máximo 300 productos', async () => {
    for (let i = 0; i < diagnostics.LIMITS.stockSample + 5; i += 1) {
      await producto(`p${String(i).padStart(3, '0')}`);
    }

    const muestra = await diagnostics.stockSampleOf(prisma, AHORA);
    expect(muestra).toHaveLength(300);
  });

  it('solo viaja en el diagnóstico cuando se pide', async () => {
    await producto('a');

    const normal = await diagnostics.buildSnapshot(prisma, DEVICE, AHORA);
    expect(normal).not.toHaveProperty('stockSample');

    const diaria = await diagnostics.buildSnapshot(prisma, DEVICE, AHORA, { includeStockSample: true });
    expect(diaria.stockSample).toEqual([{ productId: 'Rmta0000000000000000', localStock: 20 }]);
  });
});

describe('error del actualizador (SPEC 67, E4)', () => {
  function conectar() {
    const autoUpdater = new EventEmitter();
    let reloj = new Date('2026-11-06T14:00:00.000Z');
    const status = updater.createUpdaterStatus({
      log: (entry) => syncLog.appendSafe(prisma, entry),
      now: () => reloj,
    });
    updater.attachUpdater(autoUpdater, status);
    return { autoUpdater, status, avanzar: (iso) => (reloj = new Date(iso)) };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('queda en SyncLog (entity actualizacion) y en el diagnóstico', async () => {
    const { autoUpdater, status } = conectar();

    autoUpdater.emit('error', new Error('Code signature at URL did not pass validation'));

    // El evento no se espera (el actualizador no sabe de promesas): se espera a la bitácora.
    const bitacora = await vi.waitFor(async () => {
      const filas = await syncLog.listRecent(prisma);
      expect(filas).toHaveLength(1);
      return filas;
    });
    expect(bitacora[0]).toMatchObject({
      level: 'error',
      entity: 'actualizacion',
      message: 'La actualización automática falló: Code signature at URL did not pass validation',
    });

    const foto = await diagnostics.buildSnapshot(prisma, { ...DEVICE, ...status.snapshot() }, AHORA);
    expect(foto.updateError).toBe('Code signature at URL did not pass validation');
    expect(foto.updateCheckedAt).toBe('2026-11-06T14:00:00.000Z');
  });

  it('el mismo error (evento y promesa rechazada) se asienta una sola vez', async () => {
    const { autoUpdater, status } = conectar();
    const error = new Error('net::ERR_INTERNET_DISCONNECTED');

    autoUpdater.emit('error', error);
    await status.recordError(error);
    await vi.waitFor(async () => expect(await syncLog.listRecent(prisma)).toHaveLength(1));
    await tick();
    expect(await syncLog.listRecent(prisma)).toHaveLength(1);
  });

  it('una consulta que sale bien limpia el error y deja la hora', async () => {
    const { autoUpdater, status, avanzar } = conectar();
    autoUpdater.emit('error', new Error('timeout'));
    await vi.waitFor(async () => expect(await syncLog.listRecent(prisma)).toHaveLength(1));

    avanzar('2026-11-07T14:00:00.000Z');
    autoUpdater.emit('update-not-available', { version: '1.4.0' });

    const foto = await diagnostics.buildSnapshot(prisma, { ...DEVICE, ...status.snapshot() }, AHORA);
    expect(foto).not.toHaveProperty('updateError');
    expect(foto.updateCheckedAt).toBe('2026-11-07T14:00:00.000Z');
  });

  it('sin actualizador (desarrollo) el diagnóstico no lleva esos campos', async () => {
    const foto = await diagnostics.buildSnapshot(prisma, DEVICE, AHORA);
    expect(foto).not.toHaveProperty('updateError');
    expect(foto).not.toHaveProperty('updateCheckedAt');
  });
});
