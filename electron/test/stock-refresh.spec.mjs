import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import productos from '../db/products.js';
import caducidad from '../db/expiry.js';

/**
 * Stock fresco de un producto y caducidad por día de México (SPEC 57), contra
 * SQLite de verdad: `refreshOne` guarda lo que respondió `GET /products/:id/stock`
 * con la misma regla que el pull (servidor + pendiente).
 */

let tmpDir;
let dbPath;
let prisma;

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-stock-fresco-'));
  dbPath = path.join(tmpDir, 'farmajyv-pos.sqlite');
  prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  await migrate.runMigrations(prisma, { databasePath: dbPath });
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useRealTimers();
  await prisma.saleMovement.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.product.deleteMany();
});

const REMOTO = 'RmtPrd0000000000000A';

async function productoSincronizado({ stock = 0, lotes = [] } = {}) {
  await productos.upsertMany(prisma, [
    {
      id: REMOTO,
      sku: 'SKU-1',
      name: 'Paracetamol 500',
      concentration: '500 mg',
      salePrice: 50,
      isActive: true,
      stock,
      updatedAt: '2026-11-06T10:00:00.000Z',
      batches: lotes,
    },
  ]);
  return prisma.product.findUnique({ where: { remoteId: REMOTO } });
}

async function ventaPendiente(productId, quantity) {
  await prisma.sale.create({
    data: {
      id: `venta-${quantity}`,
      folio: `PENDIENTE-${quantity}`,
      idempotencyKey: `k-${quantity}`,
      subtotal: 50 * quantity,
      discountTotal: 0,
      total: 50 * quantity,
      paymentMethod: 'cash',
      cashSessionId: 'cs-1',
      cashierId: 'uid-cajero',
      payloadJson: JSON.stringify({ items: [{ productId, quantity }] }),
      items: {
        create: [
          {
            kind: 'product',
            productId,
            productName: 'Paracetamol 500',
            unitPrice: 50,
            discountAmount: 0,
            quantity,
            subtotal: 50 * quantity,
          },
        ],
      },
    },
  });
  await prisma.product.update({ where: { id: productId }, data: { totalStock: { decrement: quantity } } });
}

const LOTE_SERVIDOR = { id: 'b-1', lotNumber: 'L1', expiryDate: '2027-01-31T00:00:00.000Z', quantity: 5 };

describe('products:refreshOne (SPEC 57)', () => {
  it('stock local 0 y servidor 5: queda en 5 con el lote del servidor', async () => {
    const local = await productoSincronizado({ stock: 0 });

    const result = await productos.refreshOne(prisma, REMOTO, {
      id: REMOTO,
      totalStock: 5,
      updatedAt: '2026-11-06T18:00:00.000Z',
      batches: [LOTE_SERVIDOR],
    });

    expect(result.product.id).toBe(local.id);
    expect(result.product.stock).toBe(5);
    expect(result.batches).toEqual([
      expect.objectContaining({ lotNumber: 'L1', quantity: 5 }),
    ]);
    const fila = await prisma.product.findUnique({ where: { id: local.id } });
    expect(fila.totalStock).toBe(5);
  });

  it('respeta lo pendiente: una venta sin subir se descuenta de lo que dice el servidor', async () => {
    const local = await productoSincronizado({ stock: 2, lotes: [{ ...LOTE_SERVIDOR, quantity: 2 }] });
    await ventaPendiente(local.id, 2);

    const result = await productos.refreshOne(prisma, REMOTO, {
      id: REMOTO,
      totalStock: 7,
      batches: [{ ...LOTE_SERVIDOR, quantity: 7 }],
    });

    expect(result.product.stock).toBe(5);
    // El lote también descuenta lo vendido sin subir.
    expect(result.batches[0].quantity).toBe(5);
  });

  it('con menos stock en el servidor que en la caja, se actualiza igual (gana el servidor)', async () => {
    const local = await productoSincronizado({ stock: 9, lotes: [{ ...LOTE_SERVIDOR, quantity: 9 }] });

    const result = await productos.refreshOne(prisma, REMOTO, {
      id: REMOTO,
      totalStock: 1,
      batches: [{ ...LOTE_SERVIDOR, quantity: 1 }],
    });

    expect(result.product.stock).toBe(1);
    const lotes = await prisma.batch.findMany({ where: { productId: local.id } });
    expect(lotes).toHaveLength(1);
    expect(lotes[0].quantity).toBe(1);
  });

  it('no toca el catálogo ni la foto del pull: solo stock y lotes', async () => {
    const local = await productoSincronizado({ stock: 0 });

    await productos.refreshOne(prisma, REMOTO, { id: REMOTO, totalStock: 3, batches: [] });

    const fila = await prisma.product.findUnique({ where: { id: local.id } });
    expect(fila.remoteUpdatedAt?.toISOString()).toBe(local.remoteUpdatedAt?.toISOString());
    expect(fila.baseFields).toBe(local.baseFields);
    expect(fila.salePrice).toBe(50);
  });

  it('un lote local aún sin subir no se borra', async () => {
    const local = await productoSincronizado({ stock: 0 });
    await productos.recordStockEntry(prisma, {
      invoiceId: 'inv-1',
      productId: REMOTO,
      lotNumber: 'LOCAL-1',
      expiryDate: '2027-03-31',
      quantity: 4,
    });

    const result = await productos.refreshOne(prisma, REMOTO, {
      id: REMOTO,
      totalStock: 5,
      batches: [LOTE_SERVIDOR],
    });

    // 5 del servidor + 4 de la entrada que aún no sube.
    expect(result.product.stock).toBe(9);
    const lotes = await prisma.batch.findMany({ where: { productId: local.id } });
    expect(lotes.map((lote) => lote.lotNumber).sort()).toEqual(['L1', 'LOCAL-1']);
  });

  it('producto que no está en la caja o respuesta inválida: null y nada cambia', async () => {
    expect(await productos.refreshOne(prisma, 'NoExiste000000000000', { totalStock: 3, batches: [] })).toBeNull();
    expect(await productos.refreshOne(prisma, REMOTO, { batches: [] })).toBeNull();
    expect(await productos.refreshOne(prisma, null, { totalStock: 3 })).toBeNull();
  });
});

describe('caducidad por día de México en los lotes (SPEC 57)', () => {
  it('isExpiredLocal: caducidad de hoy a las 20:00 de México no está caducada', () => {
    const caduca = new Date('2026-11-06T00:00:00Z');
    expect(caducidad.isExpiredLocal(caduca, new Date('2026-11-07T02:00:00Z'))).toBe(false);
    expect(caducidad.isExpiredLocal(caduca, new Date('2026-11-07T06:00:00Z'))).toBe(true);
    expect(caducidad.zonedTodayYmd(new Date('2026-11-07T02:00:00Z'))).toBe('2026-11-06');
    expect(caducidad.daysUntilExpiryLocal('2026-11-10', new Date('2026-11-07T02:00:00Z'))).toBe(4);
  });

  it('una venta pendiente se descuenta del lote que caduca hoy (aún vendible a las 20:00)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T02:00:00Z'));
    const local = await productoSincronizado({
      stock: 5,
      lotes: [{ ...LOTE_SERVIDOR, expiryDate: '2026-11-06T00:00:00.000Z', quantity: 5 }],
    });
    await ventaPendiente(local.id, 2);

    const lotes = await productos.getBatchesByProduct(prisma, local.id);

    expect(lotes[0].quantity).toBe(3);
  });
});
