import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import productos from '../db/products.js';

/**
 * Entradas de stock sin atascos (SPEC 55, lado POS), contra SQLite de verdad:
 * lo que `getPendingStockEntries` manda al servidor y lo que deja guardado.
 */

let tmpDir;
let dbPath;
let prisma;

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-entradas-'));
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
  await prisma.batch.deleteMany();
  await prisma.product.deleteMany();
});

const REMOTO = 'RmtPrd0000000000000A';

describe('entradas: alta embebida de un producto que ya subió (SPEC 55, B5)', () => {
  it('se manda con productId y sin product, y se guarda así', async () => {
    const { product } = await productos.recordStockEntry(prisma, {
      invoiceId: 'inv-1',
      lotNumber: 'L-1',
      expiryDate: '2027-12-31',
      quantity: 6,
      product: { sku: 'SKU-1', name: 'Paracetamol 500', salePrice: 50, minStock: 0 },
      idempotencyKey: 'llave-1',
    });
    // El catálogo subió el producto antes que la entrada.
    await prisma.product.update({ where: { id: product.id }, data: { remoteId: REMOTO } });

    const [entrada] = await productos.getPendingStockEntries(prisma);

    expect(entrada.payload.productId).toBe(REMOTO);
    expect(entrada.payload).not.toHaveProperty('product');
    // La llave no cambia: si un intento anterior sí se aplicó, el servidor lo reconoce.
    expect(entrada.payload.idempotencyKey).toBe('llave-1');
    const guardado = JSON.parse((await prisma.batch.findUnique({ where: { id: entrada.id } })).payloadJson);
    expect(guardado).not.toHaveProperty('product');
    expect(guardado.productId).toBe(REMOTO);
  });

  it('sin remoteId el alta embebida viaja tal cual', async () => {
    await productos.recordStockEntry(prisma, {
      invoiceId: 'inv-1',
      lotNumber: 'L-1',
      expiryDate: '2027-12-31',
      quantity: 6,
      product: { sku: 'SKU-1', name: 'Paracetamol 500', salePrice: 50, minStock: 0 },
    });

    const [entrada] = await productos.getPendingStockEntries(prisma);
    expect(entrada.payload.product).toMatchObject({ sku: 'SKU-1' });
    expect(entrada.payload.productId).toBeUndefined();
  });

  it('una entrada bloqueada (ENTRY_AMBIGUOUS) sigue fuera de la cola y visible', async () => {
    await productos.recordStockEntry(prisma, {
      invoiceId: 'inv-1',
      lotNumber: 'L-1',
      expiryDate: '2027-12-31',
      quantity: 6,
      product: { sku: 'SKU-1', name: 'Paracetamol 500', salePrice: 50, minStock: 0 },
    });
    const [entrada] = await productos.getPendingStockEntries(prisma);
    await productos.markStockEntryPushFailed(
      prisma,
      entrada.id,
      'Esta entrada quedó a medio registrar en un intento anterior. [ENTRY_AMBIGUOUS]',
    );

    expect(await productos.getPendingStockEntries(prisma)).toEqual([]);
    const [bloqueada] = await productos.listBlockedStockEntries(prisma);
    expect(bloqueada.diagnosis).toEqual({ code: 'entrada-a-medias', syncCode: 'ENTRY_AMBIGUOUS' });
  });
});
