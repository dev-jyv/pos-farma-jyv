import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import productos from '../db/products.js';

/**
 * Catálogo sin pisadas entre cajas y servidor (SPEC 56) y entradas sin atascos
 * (SPEC 55, lado POS), contra **SQLite de verdad**: la fusión por `remoteId`
 * existe justo porque el `@unique` real revienta, y un Prisma falso no lo vería.
 */

let tmpDir;
let dbPath;
let prisma;

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-catalogo-'));
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
  await prisma.saleMovement.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.product.deleteMany();
  await prisma.syncLog.deleteMany();
});

const REMOTO = 'RmtPrd0000000000000A';

function remoto(overrides = {}) {
  return {
    id: REMOTO,
    sku: 'SKU-1',
    name: 'Paracetamol 500',
    concentration: '500 mg',
    categoryId: 'cat-1',
    unit: 'caja',
    salePrice: 50,
    minStock: 2,
    hasIva: false,
    hasIvaZero: true,
    hasIeps: false,
    isActive: true,
    stock: 20,
    updatedAt: '2026-11-06T10:00:00.000Z',
    ...overrides,
  };
}

async function filaRemota() {
  return prisma.product.findUnique({ where: { remoteId: REMOTO } });
}

/** Venta local pendiente de subir, con una partida del producto `productId`. */
async function ventaPendiente({ id, productId, quantity }) {
  await prisma.sale.create({
    data: {
      id,
      folio: `PENDIENTE-${id}`,
      idempotencyKey: `k-${id}`,
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

describe('pull: una edición pendiente sobrevive (SPEC 56, C2)', () => {
  it('fila sin pendientes: toma el servidor y guarda la foto con su updatedAt', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();

    expect(fila).toMatchObject({ salePrice: 50, totalStock: 20, catalogConflict: null });
    expect(fila.remoteUpdatedAt.toISOString()).toBe('2026-11-06T10:00:00.000Z');
    const base = JSON.parse(fila.baseFields);
    expect(base.updatedAt).toBe('2026-11-06T10:00:00.000Z');
    expect(base.fields).toMatchObject({ salePrice: 50, concentration: '500 mg', isActive: true });
  });

  it('edición pendiente del catálogo: el pull no toca sus campos, sí stock y remoteUpdatedAt', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();
    await productos.updateCatalogProduct(prisma, fila.id, { salePrice: 65, concentration: '650 mg' });
    const baseAntes = (await filaRemota()).baseFields;

    await productos.upsertMany(prisma, [
      remoto({ salePrice: 55, name: 'Paracetamol 500 tabs', stock: 30, updatedAt: '2026-11-06T12:00:00.000Z' }),
    ]);

    const despues = await filaRemota();
    expect(despues).toMatchObject({
      salePrice: 65,
      concentration: '650 mg',
      name: 'Paracetamol 500',
      totalStock: 30,
      pendingCatalogPush: true,
    });
    expect(despues.remoteUpdatedAt.toISOString()).toBe('2026-11-06T12:00:00.000Z');
    // La foto no se mueve: el PATCH compara contra lo que la caja vio al editar.
    expect(despues.baseFields).toBe(baseAntes);
  });

  it('entrada pendiente con productUpdate: tampoco se pisan sus correcciones', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    await productos.recordStockEntry(prisma, {
      invoiceId: 'inv-1',
      lotNumber: 'L-9',
      expiryDate: '2027-12-31',
      quantity: 5,
      productId: REMOTO,
      productUpdate: { salePrice: 60 },
    });

    await productos.upsertMany(prisma, [remoto({ salePrice: 55, stock: 20 })]);

    const fila = await filaRemota();
    expect(fila.salePrice).toBe(60);
    // Servidor (20) + entrada sin subir (5).
    expect(fila.totalStock).toBe(25);
  });

  it('una entrada pendiente sin productUpdate no frena el catálogo', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    await productos.recordStockEntry(prisma, {
      invoiceId: 'inv-1',
      lotNumber: 'L-9',
      expiryDate: '2027-12-31',
      quantity: 5,
      productId: REMOTO,
    });

    await productos.upsertMany(prisma, [remoto({ salePrice: 55 })]);

    expect((await filaRemota()).salePrice).toBe(55);
  });

  it('el upsert es idempotente: el mismo producto dos veces deja lo mismo', async () => {
    await productos.upsertMany(prisma, [remoto({ batches: [{ id: 'rb-1', lotNumber: 'A', quantity: 20 }] })]);
    const primera = await filaRemota();
    await productos.upsertMany(prisma, [remoto({ batches: [{ id: 'rb-1', lotNumber: 'A', quantity: 20 }] })]);
    const segunda = await filaRemota();

    expect(segunda.totalStock).toBe(primera.totalStock);
    expect(segunda.baseFields).toBe(primera.baseFields);
    expect(await prisma.batch.count({ where: { productId: segunda.id } })).toBe(1);
  });
});

describe('PATCH por diferencias (SPEC 56, C3)', () => {
  it('manda solo los campos editados y el updatedAt remoto de la foto', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();
    await productos.updateCatalogProduct(prisma, fila.id, { concentration: '650 mg' });

    const [pendiente] = await productos.getPendingCatalogPush(prisma);

    expect(pendiente.changes).toEqual({ concentration: '650 mg' });
    expect(pendiente.baseUpdatedAt).toBe('2026-11-06T10:00:00.000Z');
    // Lo completo sigue ahí para la foto nueva al confirmar.
    expect(pendiente.snapshot).toMatchObject({ concentration: '650 mg', salePrice: 50, isActive: true });
  });

  it('un cambio de impuestos viaja con todos los campos de impuestos', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();
    await productos.updateCatalogProduct(prisma, fila.id, { hasIeps: true, iepsRate: 0.08 });

    const [pendiente] = await productos.getPendingCatalogPush(prisma);

    expect(pendiente.changes).toEqual({ hasIva: false, hasIvaZero: true, hasIeps: true, iepsRate: 0.08 });
  });

  it('quitar el grupo controlado manda controlledGroup: null (SPEC 64)', async () => {
    await productos.upsertMany(prisma, [remoto({ controlledGroup: 'IV', requiresPrescription: true })]);
    const fila = await filaRemota();
    expect(fila.controlledGroup).toBe('IV');
    await productos.updateCatalogProduct(prisma, fila.id, { controlledGroup: null });

    const [pendiente] = await productos.getPendingCatalogPush(prisma);

    expect(pendiente.changes).toEqual({ controlledGroup: null });
    expect(pendiente.snapshot.controlledGroup).toBeNull();

    // Confirmado el push, la foto nueva ya no tiene grupo: no vuelve a viajar.
    await productos.markCatalogSynced(prisma, fila.id, REMOTO, pendiente.version, {
      fields: pendiente.snapshot,
      remoteUpdatedAt: '2026-11-06T13:00:00.000Z',
    });
    await productos.updateCatalogProduct(prisma, fila.id, { concentration: '650 mg' });
    const [siguiente] = await productos.getPendingCatalogPush(prisma);
    expect(siguiente.changes).toEqual({ concentration: '650 mg' });
    expect(siguiente.fields).not.toHaveProperty('controlledGroup');
  });

  it('un producto que nunca tuvo grupo no manda controlledGroup', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();
    await productos.updateCatalogProduct(prisma, fila.id, { salePrice: 55 });

    const [pendiente] = await productos.getPendingCatalogPush(prisma);
    expect(pendiente.changes).toEqual({ salePrice: 55 });
    expect(pendiente.fields).not.toHaveProperty('controlledGroup');
  });

  it('guardar sin cambios no deja nada que subir', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();
    await productos.updateCatalogProduct(prisma, fila.id, { salePrice: 50 });

    const [pendiente] = await productos.getPendingCatalogPush(prisma);
    expect(pendiente.changes).toEqual({});
  });

  it('fila de antes de la migración (sin foto): sube completa y sin baseUpdatedAt, como siempre', async () => {
    await prisma.product.create({
      data: { remoteId: REMOTO, sku: 'SKU-1', name: 'Viejo', salePrice: 40, pendingCatalogPush: true },
    });

    const [pendiente] = await productos.getPendingCatalogPush(prisma);
    expect(pendiente.changes).toBeNull();
    expect(pendiente.baseUpdatedAt).toBeNull();
    expect(pendiente.fields).toMatchObject({ name: 'Viejo', salePrice: 40, isActive: true });
  });

  it('confirmar el push renueva la foto con lo subido y el updatedAt del servidor', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();
    await productos.updateCatalogProduct(prisma, fila.id, { concentration: '650 mg' });
    const [pendiente] = await productos.getPendingCatalogPush(prisma);

    await productos.markCatalogSynced(prisma, fila.id, REMOTO, pendiente.version, {
      fields: pendiente.snapshot,
      remoteUpdatedAt: { _seconds: Date.parse('2026-11-06T13:00:00.000Z') / 1000, _nanoseconds: 0 },
    });

    const despues = await filaRemota();
    expect(despues.pendingCatalogPush).toBe(false);
    const base = JSON.parse(despues.baseFields);
    expect(base.updatedAt).toBe('2026-11-06T13:00:00.000Z');
    expect(base.fields.concentration).toBe('650 mg');
    expect(await productos.getPendingCatalogPush(prisma)).toEqual([]);
  });
});

describe('conflicto con el panel: 409 CATALOG_CONFLICT (SPEC 56)', () => {
  async function editarPrecioEnConflicto() {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();
    await productos.updateCatalogProduct(prisma, fila.id, { salePrice: 65, concentration: '650 mg' });
    await productos.markCatalogConflict(prisma, fila.id, { salePrice: 58, isActive: true });
    return fila.id;
  }

  it('queda bloqueada visible con el precio del panel y sus acciones', async () => {
    await editarPrecioEnConflicto();

    expect(await productos.getPendingCatalogPush(prisma)).toEqual([]);
    const [bloqueado] = await productos.listBlockedProducts(prisma);
    expect(bloqueado.reason).toBe('El precio cambió en el panel: $58.00 [CATALOG_CONFLICT]');
    expect(bloqueado.conflict).toEqual({ salePrice: 58, isActive: true });
    expect(bloqueado.diagnosis).toEqual({ code: 'catalogo-en-conflicto', syncCode: 'CATALOG_CONFLICT' });
  });

  it('un producto desactivado en el panel lo dice', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    const fila = await filaRemota();
    await productos.updateCatalogProduct(prisma, fila.id, { isActive: true, concentration: '1 g' });
    await productos.markCatalogConflict(prisma, fila.id, { salePrice: 50, isActive: false });

    const [bloqueado] = await productos.listBlockedProducts(prisma);
    expect(bloqueado.reason).toBe('El producto se desactivó en el panel [CATALOG_CONFLICT]');
  });

  it('"Usar el del panel": toma el precio del panel y sube solo lo demás', async () => {
    const id = await editarPrecioEnConflicto();

    expect(await productos.resolveCatalogConflict(prisma, id, 'panel')).toBe(true);

    expect(await prisma.product.findUnique({ where: { id } })).toMatchObject({
      salePrice: 58,
      catalogConflict: null,
      catalogPushError: null,
    });
    const [pendiente] = await productos.getPendingCatalogPush(prisma);
    expect(pendiente.changes).toEqual({ concentration: '650 mg' });
    expect(pendiente.baseUpdatedAt).toBe('2026-11-06T10:00:00.000Z');
    expect(await productos.listBlockedProducts(prisma)).toEqual([]);
  });

  it('"Forzar el mío": vuelve a la cola sin baseUpdatedAt y con su precio', async () => {
    const id = await editarPrecioEnConflicto();

    await productos.resolveCatalogConflict(prisma, id, 'mine');

    const [pendiente] = await productos.getPendingCatalogPush(prisma);
    expect(pendiente.changes).toEqual({ salePrice: 65, concentration: '650 mg' });
    expect(pendiente.baseUpdatedAt).toBeNull();

    // Al confirmar, el conflicto desaparece y la siguiente edición ya lleva foto.
    await productos.markCatalogSynced(prisma, id, REMOTO, pendiente.version, {
      fields: pendiente.snapshot,
      remoteUpdatedAt: '2026-11-06T14:00:00.000Z',
    });
    expect((await prisma.product.findUnique({ where: { id } })).catalogConflict).toBeNull();
  });

  it('sin conflicto no hay nada que resolver', async () => {
    await productos.upsertMany(prisma, [remoto()]);
    expect(await productos.resolveCatalogConflict(prisma, (await filaRemota()).id, 'panel')).toBe(false);
  });
});

describe('enlace local–remoto: el choque de remoteId fusiona (SPEC 56, B6)', () => {
  it('entrada con alta embebida cuya respuesta se perdió: el pull trajo el producto antes del enlace', async () => {
    // 1) Alta local con su entrada (10) y una venta local de 3, todo sin subir.
    const { product } = await productos.recordStockEntry(prisma, {
      invoiceId: 'inv-1',
      lotNumber: 'L-1',
      expiryDate: '2027-12-31',
      quantity: 10,
      product: { sku: 'SKU-1', name: 'Paracetamol 500', salePrice: 50, minStock: 0 },
    });
    const local = product.id;
    await ventaPendiente({ id: 'v-1', productId: local, quantity: 3 });
    const [entrada] = await productos.getPendingStockEntries(prisma);

    // 2) El servidor sí aplicó la entrada; el pull trae el producto como fila nueva
    //    (10 piezas, su lote) y en esa fila se vende 2.
    await productos.upsertMany(prisma, [
      remoto({ stock: 10, batches: [{ id: 'rb-1', lotNumber: 'L-1', expiryDate: '2027-12-31', quantity: 10 }] }),
    ]);
    const delPull = (await filaRemota()).id;
    await ventaPendiente({ id: 'v-2', productId: delPull, quantity: 2 });

    // 3) El reintento de la entrada confirma y enlaza: antes reventaba el @unique.
    await productos.markStockEntrySynced(prisma, entrada.id, REMOTO);

    const filas = await prisma.product.findMany();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ id: local, remoteId: REMOTO, pendingPush: false });
    // Servidor (10) menos las 5 piezas vendidas sin subir.
    expect(filas[0].totalStock).toBe(5);
    const partidas = await prisma.saleItem.findMany();
    expect(partidas.map((p) => p.productId)).toEqual([local, local]);
    // El lote ya subido se sustituye por la foto del servidor: no se cuenta doble.
    const lotes = await prisma.batch.findMany({ where: { productId: local } });
    expect(lotes).toHaveLength(1);
    expect(lotes[0].remoteId).toBe('rb-1');
    const bitacora = await prisma.syncLog.findMany({ where: { entity: 'product' } });
    expect(bitacora).toHaveLength(1);
    expect(bitacora[0].message).toMatch(/Fusión de producto duplicado/);
    expect(bitacora[0].ref).toBe(local);
  });

  it('alta desde el catálogo: también fusiona, conserva lo local y sus lotes pendientes', async () => {
    const creado = await productos.createCatalogProduct(prisma, {
      sku: 'SKU-1',
      name: 'Paracetamol 500',
      salePrice: 52,
      minStock: 0,
      hasIva: false,
      hasIvaZero: true,
      hasIeps: false,
    });
    // Entrada que espera a que el producto suba (sin alta embebida).
    await productos.recordStockEntry(prisma, {
      invoiceId: 'inv-1',
      lotNumber: 'L-2',
      expiryDate: '2027-12-31',
      quantity: 4,
      productId: creado.id,
    });
    await productos.upsertMany(prisma, [remoto({ salePrice: 52, stock: 0 })]);
    const [pendiente] = await productos.getPendingCatalogPush(prisma);

    await productos.markCatalogSynced(prisma, creado.id, REMOTO, pendiente.version, {
      fields: pendiente.snapshot,
      remoteUpdatedAt: '2026-11-06T10:00:00.000Z',
    });

    const filas = await prisma.product.findMany();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ id: creado.id, remoteId: REMOTO, pendingCatalogPush: false, totalStock: 4 });
    // La entrada que esperaba ya puede subir con el id remoto.
    const [entrada] = await productos.getPendingStockEntries(prisma);
    expect(entrada.payload.productId).toBe(REMOTO);
  });

  it('sin choque solo enlaza', async () => {
    const creado = await productos.createCatalogProduct(prisma, {
      sku: 'SKU-9',
      name: 'Nuevo',
      salePrice: 10,
      minStock: 0,
      hasIva: false,
      hasIvaZero: false,
      hasIeps: false,
    });

    await productos.markCatalogSynced(prisma, creado.id, 'RmtPrd000000000000Z9');

    expect(await prisma.product.findUnique({ where: { id: creado.id } })).toMatchObject({
      remoteId: 'RmtPrd000000000000Z9',
      pendingCatalogPush: false,
    });
    expect(await prisma.syncLog.count()).toBe(0);
  });
});
