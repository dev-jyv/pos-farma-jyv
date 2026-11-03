import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import productos from '../db/products.js';
import ventas from '../db/sales.js';
import cupones from '../db/coupons.js';

/**
 * Las migraciones de SPEC 46 (caja) y SPEC 47 (cupones) sobre una base que **ya
 * existe con datos**, con SQLite y Prisma de verdad: así es como llegan a una
 * caja en producción. Se aplica a mano todo lo anterior, se siembran una venta
 * y un producto, y luego `runMigrations` debe aplicar solo lo nuevo, respaldar
 * antes y no perder nada.
 */

const NUEVAS = ['20261103000000_box_sale', '20261103010000_coupons'];
const MIGRATIONS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'prisma', 'migrations');

let tmpDir;
let dbPath;
let prisma;
let resultado;

function sentencias(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-mig-46-47-'));
  dbPath = path.join(tmpDir, 'farmajyv-pos.sqlite');
  prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });

  // 1) La base "de ayer": todas las migraciones anteriores, registradas igual
  //    que lo hace `runMigrations`.
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_local_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" TEXT NOT NULL)',
  );
  const anteriores = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NUEVAS.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const folder of anteriores) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8');
    for (const statement of sentencias(sql)) {
      await prisma.$executeRawUnsafe(statement);
    }
    await prisma.$executeRawUnsafe(
      'INSERT INTO "_local_migrations" ("name", "appliedAt") VALUES (?, ?)',
      folder,
      new Date().toISOString(),
    );
  }

  // 2) Datos de ayer, con SQL crudo: el cliente generado ya conoce las columnas
  //    nuevas y las pediría al leer o escribir.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Product" ("id","remoteId","sku","name","salePrice","totalStock","updatedAt")
     VALUES ('p-1','r-1','SKU-1','Paracetamol',50,20,CURRENT_TIMESTAMP)`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Sale" ("id","folio","idempotencyKey","subtotal","discountTotal","total","paymentMethod",
       "cashSessionId","cashierId","payloadJson","updatedAt")
     VALUES ('s-1','PENDIENTE-1','k-1',100,0,100,'cash','cs-1','uid-cajero','{"items":[]}',CURRENT_TIMESTAMP)`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "SaleItem" ("id","saleId","kind","productId","productName","unitPrice","discountAmount","quantity","subtotal")
     VALUES ('i-1','s-1','product','p-1','Paracetamol',50,0,2,100)`,
  );

  // 3) La actualización: arranca la app nueva.
  resultado = await migrate.runMigrations(prisma, { databasePath: dbPath });
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('migración de caja y cupones sobre una base existente', () => {
  it('aplica solo las dos migraciones nuevas y respalda antes', () => {
    expect(resultado.applied).toEqual(NUEVAS);
    expect(resultado.backupPath).toBeTruthy();
    expect(fs.existsSync(resultado.backupPath)).toBe(true);
  });

  it('no pierde el producto ni la venta de antes, y las columnas nuevas quedan vacías', async () => {
    const producto = await prisma.product.findUnique({ where: { id: 'p-1' } });
    expect(producto).toMatchObject({ name: 'Paracetamol', totalStock: 20, boxQuantity: null, boxPrice: null, boxBarcode: null });

    const venta = await prisma.sale.findUnique({ where: { id: 's-1' }, include: { items: true } });
    expect(venta).toMatchObject({ total: 100, couponJson: null });
    expect(venta.items[0]).toMatchObject({ quantity: 2, saleUnit: null, couponDiscount: null });
  });

  it('la venta vieja se sigue leyendo sin caja ni cupón', async () => {
    const [venta] = await ventas.list(prisma, {});
    expect(venta.coupon).toBeNull();
    expect(venta.items[0].saleUnit).toBeUndefined();
  });

  it('una venta por caja se guarda en piezas, y el pull no pisa lo vendido sin subir', async () => {
    await productos.upsertMany(prisma, [
      { id: 'r-1', sku: 'SKU-1', name: 'Paracetamol', salePrice: 50, stock: 20, boxQuantity: 10, boxPrice: 450, boxBarcode: 'CAJA-1' },
    ]);
    // La venta vieja de 2 piezas sigue pendiente: el pull ya la descuenta.
    expect((await prisma.product.findUnique({ where: { id: 'p-1' } })).totalStock).toBe(18);

    await ventas.createLocal(prisma, {
      folio: 'PENDIENTE-2',
      idempotencyKey: 'k-2',
      subtotal: 450,
      discountTotal: 0,
      total: 450,
      paymentMethod: 'cash',
      amountReceived: 450,
      change: 0,
      cashAmount: 450,
      cashSessionId: 'cs-1',
      cashierId: 'uid-cajero',
      coupon: { code: 'BIENVENIDA10', name: 'Bienvenida', scope: 'sale', discountAmount: 0 },
      items: [
        {
          kind: 'product',
          productId: 'p-1',
          productName: 'Paracetamol',
          unitPrice: 450,
          discountAmount: 0,
          quantity: 10,
          subtotal: 450,
          saleUnit: { type: 'box', boxes: 1, piecesPerBox: 10, boxPrice: 450 },
        },
      ],
      payload: { items: [{ kind: 'product', productId: 'p-1', quantity: 1, unitPrice: 450, discountAmount: 0, saleUnit: 'box' }], couponCode: 'BIENVENIDA10' },
    });
    expect((await prisma.product.findUnique({ where: { id: 'p-1' } })).totalStock).toBe(8);

    // El servidor todavía no conoce ninguna de las dos ventas: su foto es 20.
    await productos.upsertMany(prisma, [
      { id: 'r-1', sku: 'SKU-1', name: 'Paracetamol', salePrice: 50, stock: 20, boxQuantity: 10, boxPrice: 450, boxBarcode: 'CAJA-1' },
    ]);
    expect((await prisma.product.findUnique({ where: { id: 'p-1' } })).totalStock).toBe(8);

    const caja = await productos.getByBarcode(prisma, 'CAJA-1');
    expect(caja).toMatchObject({ saleUnit: 'box', boxQuantity: 10 });

    const [pendiente] = (await ventas.getPendingPush(prisma)).filter((venta) => venta.payload.couponCode);
    expect(pendiente.payload).toMatchObject({ couponCode: 'BIENVENIDA10', items: [{ productId: 'r-1', saleUnit: 'box', quantity: 1 }] });
  });

  it('la tabla de cupones existe y acepta el pull', async () => {
    await cupones.upsertMany(prisma, [
      {
        id: 'BIENVENIDA10',
        code: 'BIENVENIDA10',
        name: 'Bienvenida',
        scope: 'sale',
        productIds: [],
        discount: { type: 'percent', percent: 10 },
        minPurchase: null,
        startsAt: '2026-11-01T00:00:00.000Z',
        endsAt: null,
        maxUses: null,
        usedCount: 0,
        isActive: true,
        deactivatedAt: null,
        updatedAt: '2026-11-02T00:00:00.000Z',
      },
    ]);
    expect(await cupones.findByCode(prisma, 'bienvenida10')).toMatchObject({ code: 'BIENVENIDA10', scope: 'sale' });
  });
});
