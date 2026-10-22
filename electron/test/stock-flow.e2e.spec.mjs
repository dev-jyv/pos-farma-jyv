import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import cashSessions from '../db/cash-sessions.js';
import productos from '../db/products.js';
import ventas from '../db/sales.js';

/**
 * Flujo repetido venta → push → pull con **SQLite real** y un servidor falso en
 * memoria, sin red. Vigila que el stock local nunca cuente de más ni de menos
 * mientras una venta está pendiente, sincronizada o rechazada ("No conciliada").
 *
 * Reporte del usuario: "tenía 6 en existencia, vendí 3, deben quedar 3" y una
 * venta marcada "No conciliada: Stock insuficiente para BIOBEND".
 */

const CAJERO = 'uid-cajero';
const REPETICIONES = 25;

let tmpDir;
let prisma;
let sesion;

/** Servidor mínimo: stock por producto remoto, que rechaza si no alcanza. */
function crearServidor() {
  const stock = new Map();
  return {
    stock,
    snapshot: () =>
      [...stock.entries()].map(([id, cantidad]) => ({
        id,
        sku: `SKU-${id}`,
        name: `Producto ${id}`,
        salePrice: 50,
        stock: cantidad,
      })),
    /** `true` si aceptó la venta; `false` si respondió "Stock insuficiente". */
    vender(remoteProductId, cantidad) {
      const actual = stock.get(remoteProductId) ?? 0;
      if (actual < cantidad) return false;
      stock.set(remoteProductId, actual - cantidad);
      return true;
    },
  };
}

/** Un ciclo de push: sube lo pendiente y marca cada venta según responda el servidor. */
async function push(servidor) {
  const pendientes = await ventas.getPendingPush(prisma, { ownerUid: CAJERO });
  for (const venta of pendientes) {
    // El payload ya viaja con el id REMOTO del producto.
    const ok = venta.payload.items.every((item) => servidor.vender(item.productId, item.quantity));
    if (ok) {
      await ventas.markSynced(prisma, venta.id, `r-${venta.id}`, `F-${venta.id}`);
    } else {
      await ventas.markUnreconciled(prisma, venta.id, 'Stock insuficiente para BIOBEND');
    }
  }
}

async function stockLocal(id) {
  return (await prisma.product.findUnique({ where: { id } })).totalStock;
}

async function sembrar(servidor, { id = 'p-bio', remoteId = 'r-bio', stock = 6 } = {}) {
  servidor.stock.set(remoteId, stock);
  await prisma.product.create({
    data: { id, remoteId, sku: `SKU-${id}`, name: 'BIOBEND', salePrice: 50, totalStock: stock },
  });
}

async function vender(productId, cantidad) {
  return ventas.createLocal(prisma, {
    folio: `PENDIENTE-${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: `k-${Math.random().toString(36).slice(2, 12)}`,
    subtotal: 50 * cantidad,
    discountTotal: 0,
    total: 50 * cantidad,
    taxSummary: null,
    paymentMethod: 'cash',
    amountReceived: 50 * cantidad,
    change: 0,
    cashAmount: 50 * cantidad,
    cardAmount: null,
    cardPaymentReference: null,
    cashierId: CAJERO,
    customerId: null,
    customerName: null,
    prescription: null,
    prescriptionRetained: false,
    controlledGroups: [],
    billing: null,
    invoiceStatus: null,
    cashSessionId: sesion.id,
    items: [
      {
        kind: 'product',
        productId,
        productName: 'BIOBEND',
        unitPrice: 50,
        discountAmount: 0,
        quantity: cantidad,
        subtotal: 50 * cantidad,
      },
    ],
    pharmacyTotal: 50 * cantidad,
    servicesTotal: 0,
    servicesCashAmount: 0,
    pharmacyCashAmount: 50 * cantidad,
    commissionTotal: 0,
    payload: { items: [{ productId, quantity: cantidad }] },
  });
}

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-stock-'));
  const dbPath = path.join(tmpDir, 'farmajyv-pos.sqlite');
  prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  await migrate.runMigrations(prisma, { databasePath: dbPath });
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await prisma.saleMovement.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.cashMovement.deleteMany();
  await prisma.cashSession.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.product.deleteMany();
  sesion = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
});

describe('stock local en el ciclo venta → push → pull', () => {
  it('6 en existencia, se venden 3: quedan 3 antes del push, después y tras el pull', async () => {
    const servidor = crearServidor();
    await sembrar(servidor);

    await vender('p-bio', 3);
    expect(await stockLocal('p-bio')).toBe(3);

    // Pull con la foto vieja del servidor (la venta aún no sube).
    await productos.upsertMany(prisma, servidor.snapshot());
    expect(await stockLocal('p-bio')).toBe(3);

    await push(servidor);
    await productos.upsertMany(prisma, servidor.snapshot());
    expect(await stockLocal('p-bio')).toBe(3);
  });

  it('repetido muchas veces el stock local sigue al del servidor', async () => {
    const servidor = crearServidor();
    await sembrar(servidor, { stock: REPETICIONES * 3 });

    for (let i = 1; i <= REPETICIONES; i += 1) {
      await vender('p-bio', 3);
      // Intercala pull antes y después del push, como el horario real.
      await productos.upsertMany(prisma, servidor.snapshot());
      await push(servidor);
      await productos.upsertMany(prisma, servidor.snapshot());
      expect(await stockLocal('p-bio')).toBe(REPETICIONES * 3 - i * 3);
    }
  });

  it('una venta rechazada por el servidor ("No conciliada") no devuelve el stock vendido', async () => {
    const servidor = crearServidor();
    await sembrar(servidor, { stock: 6 });
    // El servidor cree tener menos de lo que la caja ve (p. ej. lotes vencidos).
    servidor.stock.set('r-bio', 2);

    await vender('p-bio', 3);
    await push(servidor);
    const venta = (await prisma.sale.findMany())[0];
    expect(venta.unreconciledAt).not.toBeNull();

    await productos.upsertMany(prisma, servidor.snapshot());
    // La mercancía ya salió del mostrador: no puede volver a "6" ni subir de 3.
    expect(await stockLocal('p-bio')).toBeLessThanOrEqual(3);
  });

  // BUG conocido, pendiente de decidir el arreglo. Quitar `.fails` al corregir.
  it.fails('rechazo con stock 6 reportado por el servidor (lotes vencidos): local queda en 3, no vuelve a 6', async () => {
    const servidor = crearServidor();
    await sembrar(servidor, { stock: 6 });
    // El servidor reporta 6 pero rechaza el descuento: no consumió nada.
    servidor.vender = () => false;

    await vender('p-bio', 3);
    await push(servidor);
    expect((await prisma.sale.findMany())[0].unreconciledAt).not.toBeNull();

    await productos.upsertMany(prisma, servidor.snapshot());
    expect(await stockLocal('p-bio')).toBe(3);
  });
});
