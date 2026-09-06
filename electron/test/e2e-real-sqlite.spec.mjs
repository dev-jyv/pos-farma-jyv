import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import cashSessions from '../db/cash-sessions.js';
import cashMovements from '../db/cash-movements.js';
import catalogo from '../db/pharmacy-services.js';
import productos from '../db/products.js';
import ventas from '../db/sales.js';

/**
 * E2E del núcleo local-first: **SQLite de verdad**, migraciones de verdad y
 * cliente Prisma de verdad.
 *
 * Las otras suites usan un Prisma falso en memoria, que es rápido pero miente:
 * no aplica `CHECK`, ni `NOT NULL`, ni `UNIQUE`, ni las cascadas, ni valida que
 * los campos que el código escribe existan realmente en el esquema. Todo eso
 * solo aparece cuando corre el motor real, y es justo lo que rompe una caja en
 * producción. Cada prueba de aquí recorre un flujo completo de mostrador.
 */

const CAJERO = 'uid-cajero';
const ADMIN = 'uid-admin';

let tmpDir;
let dbPath;
let prisma;

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-e2e-'));
  dbPath = path.join(tmpDir, 'farmajyv-pos.sqlite');
  prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  const resultado = await migrate.runMigrations(prisma, { databasePath: dbPath });
  // Si esto falla, ninguna prueba de abajo significa nada.
  expect(resultado.applied.length).toBeGreaterThan(0);
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Cada prueba arranca con la base vacía, pero con el esquema ya migrado. */
beforeEach(async () => {
  await prisma.saleMovement.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.cashMovement.deleteMany();
  await prisma.cashSession.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.product.deleteMany();
  await prisma.pharmacyService.deleteMany();
  await prisma.serviceProvider.deleteMany();
});

async function unProducto({ id = 'p-1', stock = 20, salePrice = 50, remoteId = null } = {}) {
  return prisma.product.create({
    data: { id, remoteId, sku: `SKU-${id}`, name: `Producto ${id}`, salePrice, totalStock: stock },
  });
}

async function unServicio({ id = 'sv-1', price = 200, commissionRate = 40, requiresPerformer = true } = {}) {
  await catalogo.upsertServices(prisma, [
    {
      id,
      code: `COD-${id}`,
      name: 'Consulta general',
      serviceType: 'consultation',
      price,
      taxMode: 'exempt',
      commissionRate,
      requiresPerformer,
      isActive: true,
      updatedAt: '2026-09-07T10:00:00.000Z',
    },
  ]);
  return catalogo.getServiceById(prisma, id);
}

async function unDoctor({ id = 'dr-1', name = 'Dra. Ruiz' } = {}) {
  await catalogo.upsertProviders(prisma, [{ id, name, license: '1234567', updatedAt: '2026-09-07T10:00:00.000Z' }]);
  return id;
}

/** Venta tal como la arma el renderer, con sus totales por rama ya calculados. */
function ventaPayload(items, overrides = {}) {
  const total = items.reduce((suma, item) => suma + item.subtotal - item.discountAmount, 0);
  const servicesTotal = items
    .filter((item) => item.kind === 'service')
    .reduce((suma, item) => suma + item.subtotal - item.discountAmount, 0);
  const commissionTotal = items.reduce((suma, item) => suma + (item.commissionAmount ?? 0), 0);
  const cashAmount = overrides.cashAmount ?? total;
  // Servicios primero, la misma regla que aplica el backend.
  const servicesCashAmount = Math.min(cashAmount, servicesTotal);
  return {
    folio: `PENDIENTE-${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: `k-${Math.random().toString(36).slice(2, 12)}`,
    subtotal: total,
    discountTotal: 0,
    total,
    taxSummary: null,
    paymentMethod: 'cash',
    amountReceived: cashAmount,
    change: 0,
    cashAmount,
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
    items,
    pharmacyTotal: total - servicesTotal,
    servicesTotal,
    servicesCashAmount,
    pharmacyCashAmount: cashAmount - servicesCashAmount,
    commissionTotal,
    payload: { items: items.map((item) => ({ ...item })) },
    ...overrides,
  };
}

const partidaProducto = (productId = 'p-1', overrides = {}) => ({
  kind: 'product',
  productId,
  productName: 'Paracetamol',
  unitPrice: 50,
  discountAmount: 0,
  quantity: 2,
  subtotal: 100,
  ...overrides,
});

const partidaServicio = (serviceId = 'sv-1', overrides = {}) => ({
  kind: 'service',
  serviceId,
  productName: 'Consulta general',
  providerId: 'dr-1',
  providerName: 'Dra. Ruiz',
  commissionRate: 40,
  commissionAmount: 80,
  unitPrice: 200,
  discountAmount: 0,
  quantity: 1,
  subtotal: 200,
  ...overrides,
});

describe('el esquema real impide lo que el diseño prohíbe', () => {
  /**
   * El `CHECK` de la migración es la última línea de defensa: si el código
   * escribiera un `productId` inventado en una partida de servicio, ese
   * servicio descontaría stock de un producto real.
   */
  it('SQLite rechaza una partida híbrida (producto y servicio a la vez)', async () => {
    const sesion = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    await unProducto();
    const venta = await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto()]),
      cashSessionId: sesion.id,
    });

    await expect(
      prisma.saleItem.create({
        data: {
          saleId: venta.id,
          kind: 'service',
          productId: 'p-1',
          serviceId: 'sv-1',
          productName: 'Híbrida',
          unitPrice: 1,
          discountAmount: 0,
          quantity: 1,
          subtotal: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it('rechaza una partida de servicio sin `serviceId`', async () => {
    const sesion = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    await unProducto();
    const venta = await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto()]),
      cashSessionId: sesion.id,
    });

    await expect(
      prisma.saleItem.create({
        data: {
          saleId: venta.id,
          kind: 'service',
          productName: 'Sin id',
          unitPrice: 1,
          discountAmount: 0,
          quantity: 1,
          subtotal: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it('borrar una venta arrastra sus partidas y su bitácora (cascada real)', async () => {
    const sesion = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    await unProducto();
    const venta = await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto(), partidaServicio()]),
      cashSessionId: sesion.id,
    });
    expect(await prisma.saleItem.count({ where: { saleId: venta.id } })).toBe(2);

    await ventas.discard(prisma, venta.id);

    expect(await prisma.saleItem.count()).toBe(0);
    expect(await prisma.saleMovement.count()).toBe(0);
  });

  it('la llave de idempotencia es única de verdad: no se puede duplicar una venta', async () => {
    const sesion = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    await unProducto();
    const payload = { ...ventaPayload([partidaProducto()]), cashSessionId: sesion.id };

    await ventas.createLocal(prisma, payload);

    await expect(ventas.createLocal(prisma, payload)).rejects.toThrow();
  });

  it('un servicio no puede tener stock ni lote: no hay columnas ni relación para eso', async () => {
    await unServicio();

    // El esquema real ni siquiera acepta el campo.
    await expect(
      prisma.pharmacyService.update({ where: { id: 'sv-1' }, data: { totalStock: 10 } }),
    ).rejects.toThrow();
    // Y un lote solo puede colgar de un producto.
    await expect(
      prisma.batch.create({ data: { productId: 'sv-1', quantity: 10 } }),
    ).rejects.toThrow();
  });
});

describe('jornada completa contra SQLite real', () => {
  it('abrir, vender mixto, gastar, cerrar y cuadrar', async () => {
    await unProducto({ stock: 20 });
    await unServicio();
    await unDoctor();

    // 1. Apertura con el efectivo que quedó en caja.
    const enCaja = await cashSessions.getCashOnHand(prisma);
    expect(enCaja.amount).toBe(0);
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });

    // 2. Ticket mixto: medicamento 100 + consulta 200, todo en efectivo.
    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto(), partidaServicio()]),
      cashSessionId: turno.id,
    });

    // El stock del medicamento bajó; el servicio no tocó inventario.
    expect((await prisma.product.findUnique({ where: { id: 'p-1' } })).totalStock).toBe(18);

    // 3. Un gasto del turno.
    await cashMovements.addMovement(prisma, turno.id, {
      type: 'expense',
      amount: 150,
      reason: 'Insumos: guantes',
      category: 'supplies',
      description: 'Cajas de guantes',
      createdBy: CAJERO,
    });

    // 4. El corte en vivo: dos esperados, un solo cajón.
    const vivo = await cashSessions.getLiveSummary(prisma, turno.id);
    // Farmacia: 500 de fondo + 100 de la venta − 150 del gasto.
    expect(vivo.expectedCashAmount).toBe(450);
    expect(vivo.expectedServicesCashAmount).toBe(200);
    expect(vivo.summary.services).toMatchObject({ count: 1, total: 200, commissionTotal: 80 });

    // 5. Cierre contando el cajón completo: 450 + 200.
    const cerrado = await cashSessions.closeLocal(prisma, turno.id, {
      countedCashAmount: 650,
      closedBy: CAJERO,
    });
    expect(cerrado.cashDifference).toBe(0);
    expect(cerrado.hasPendingAdjustment).toBe(false);

    // 6. Lo contado se hereda como fondo del turno siguiente.
    expect((await cashSessions.getCashOnHand(prisma)).amount).toBe(650);
  });

  it('cerrar con faltante deja el ajuste pendiente de un admin, y el pull lo resuelve', async () => {
    await unProducto();
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });

    const cerrado = await cashSessions.closeLocal(prisma, turno.id, {
      countedCashAmount: 460,
      closedBy: CAJERO,
    });
    expect(cerrado.cashDifference).toBe(-40);
    expect(cerrado.adjustmentStatus).toBe('pending');

    // El admin lo aprueba en el backend; el POS solo refleja el resultado.
    await cashSessions.updateAdjustmentStatus(prisma, turno.id, {
      status: 'approved',
      reviewedBy: ADMIN,
      reviewedAt: '2026-09-08T10:00:00.000Z',
      note: 'Faltante autorizado',
    });

    const [reflejado] = await cashSessions.listLocal(prisma, {});
    expect(reflejado.adjustmentStatus).toBe('approved');
    expect(reflejado.hasPendingAdjustment).toBe(false);
    expect(await cashSessions.listLocal(prisma, { adjustmentStatus: 'pending' })).toHaveLength(0);
  });

  it('anular un ticket mixto repone solo el medicamento', async () => {
    await unProducto({ stock: 20 });
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    const venta = await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto(), partidaServicio()]),
      cashSessionId: turno.id,
    });
    expect((await prisma.product.findUnique({ where: { id: 'p-1' } })).totalStock).toBe(18);

    const anulada = await ventas.voidLocal(prisma, venta.id, ADMIN, 'admin@farmajyv.mx');

    expect(anulada.voidedAt).toBeTruthy();
    expect((await prisma.product.findUnique({ where: { id: 'p-1' } })).totalStock).toBe(20);
    // Y el corte deja de contarla, sin inflar el esperado de servicios.
    const vivo = await cashSessions.getLiveSummary(prisma, turno.id);
    expect(vivo.expectedCashAmount).toBe(0);
    expect(vivo.expectedServicesCashAmount).toBe(0);
    expect(vivo.summary.services).toMatchObject({ count: 0, voidedCount: 1 });
  });

  it('anular una venta cuyo producto ya no está en el catálogo local no rompe la anulación', async () => {
    await unProducto();
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    const venta = await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto('p-fantasma')]),
      cashSessionId: turno.id,
    });

    // Regresión: con `update` en vez de `updateMany`, esto lanzaba P2025 y
    // abortaba la transacción, dejando la venta viva.
    const anulada = await ventas.voidLocal(prisma, venta.id, ADMIN);
    expect(anulada.voidedAt).toBeTruthy();
  });

  it('un turno rezagado se cierra solo con el efectivo del momento', async () => {
    await unProducto();
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto()]),
      cashSessionId: turno.id,
    });

    const { expectedCashAmount } = await cashSessions.getLiveSummary(prisma, turno.id);
    const cerrado = await cashSessions.closeLocal(prisma, turno.id, {
      countedCashAmount: expectedCashAmount,
      closedBy: CAJERO,
      autoClosedByExpiry: true,
    });

    expect(cerrado.autoClosedByExpiry).toBe(true);
    // Un auto-cierre nunca deja ajuste: no hay cajero que cuente.
    expect(cerrado.hasPendingAdjustment).toBe(false);
    expect(cerrado.cashDifference).toBe(0);
  });

  it('la caja de la farmacia mueve efectivo entre turnos y se hereda al abrir', async () => {
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await cashSessions.closeLocal(prisma, turno.id, { countedCashAmount: 500, closedBy: CAJERO });

    // Con la caja cerrada, el admin mete efectivo (sin turno).
    await cashMovements.addMovement(prisma, null, {
      type: 'deposit',
      amount: 300,
      reason: 'Fondo del dueño',
      createdBy: ADMIN,
    });

    expect((await cashSessions.getCashOnHand(prisma)).amount).toBe(800);
  });

  /**
   * La caja **puede quedar en rojo**: se gastó de más, o un movimiento se
   * registró mal. Antes el conteo se recortaba a cero, y eso no saldaba nada —
   * falseaba el cierre y escondía el faltante justo en el documento que existe
   * para asentarlo. El rojo tiene que sobrevivir al cierre y heredarse al turno
   * siguiente, o el descuadre reaparece sin dueño.
   */
  it('un gasto mayor al efectivo deja la caja en rojo, y el rojo se hereda', async () => {
    await unProducto({ stock: 20 });
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });

    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto()]),
      cashSessionId: turno.id,
    });

    // Se paga al proveedor más de lo que hay en el cajón: 300 sobre 200.
    await cashMovements.addMovement(prisma, turno.id, {
      type: 'expense',
      amount: 300,
      reason: 'Proveedor',
      category: 'supplier',
      description: 'Pago parcial de la factura',
      createdBy: CAJERO,
    });

    // 100 de fondo + 100 de la venta − 300 del gasto.
    const vivo = await cashSessions.getLiveSummary(prisma, turno.id);
    expect(vivo.expectedCashAmount).toBe(-100);

    const cerrado = await cashSessions.closeLocal(prisma, turno.id, {
      countedCashAmount: -100,
      closedBy: CAJERO,
    });
    expect(cerrado.countedCashAmount).toBe(-100);
    // El rojo estaba justificado por el gasto: no hay diferencia que ajustar.
    expect(cerrado.cashDifference).toBe(0);
    expect(cerrado.hasPendingAdjustment).toBe(false);

    // Y el turno siguiente arranca reconociendo el faltante, no en cero.
    expect((await cashSessions.getCashOnHand(prisma)).amount).toBe(-100);
  });

  it('el turno siguiente abre con el fondo en rojo y vuelve a cuadrar al vender', async () => {
    await unProducto({ stock: 20 });
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: -100 });

    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto()]),
      cashSessionId: turno.id,
    });

    // −100 heredados + 100 cobrados: la caja vuelve a cero, no a 100.
    const vivo = await cashSessions.getLiveSummary(prisma, turno.id);
    expect(vivo.expectedCashAmount).toBe(0);

    const cerrado = await cashSessions.closeLocal(prisma, turno.id, {
      countedCashAmount: 0,
      closedBy: CAJERO,
    });
    expect(cerrado.cashDifference).toBe(0);
  });

  it('un error de registro que deja la caja en rojo sí levanta ajuste pendiente', async () => {
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });

    // El cajón está vacío pero nadie registró en qué se fue: eso no es un rojo
    // explicado, es un faltante, y tiene que llegarle a un admin.
    const cerrado = await cashSessions.closeLocal(prisma, turno.id, {
      countedCashAmount: -50,
      closedBy: CAJERO,
    });
    expect(cerrado.cashDifference).toBe(-550);
    expect(cerrado.hasPendingAdjustment).toBe(true);
  });

  /**
   * Recibir mercancía es trabajo de mostrador (`stockEntry:write`). Lo que
   * importa del recorrido: lo recibido se puede vender enseguida, sin esperar a
   * que la entrada suba al servidor.
   */
  it('el cajero recibe mercancía y la vende en el mismo turno', async () => {
    const producto = await unProducto({ stock: 0 });
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });

    const entrada = await productos.recordStockEntry(prisma, {
      productId: producto.id,
      lotNumber: 'L-2026-A',
      expiryDate: '2027-06-30',
      quantity: 12,
      invoiceId: 'inv-1',
    });
    expect(entrada.stock).toBe(12);

    // La entrada queda en cola: se vende contra stock local, sin red de por medio.
    expect(await productos.getPendingStockEntries(prisma)).toHaveLength(1);

    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto(producto.id)]),
      cashSessionId: turno.id,
    });

    expect((await prisma.product.findUnique({ where: { id: producto.id } })).totalStock).toBe(10);
  });

  it('recibir un producto que aún no existe lo da de alta y lo deja vendible', async () => {
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });

    const entrada = await productos.recordStockEntry(prisma, {
      product: { sku: 'SKU-NUEVO', name: 'Producto nuevo', salePrice: 80 },
      lotNumber: 'L-1',
      expiryDate: '2027-01-31',
      quantity: 5,
      invoiceId: 'inv-2',
    });

    expect(entrada.stock).toBe(5);
    /**
     * Sube **con su entrada de stock**, no por la cola de catálogo: el producto
     * y la mercancía viajan en el mismo `POST /stock-entries`. Si además
     * apareciera en la cola de catálogo se daría de alta dos veces.
     */
    expect(await productos.getPendingStockEntries(prisma)).toHaveLength(1);
    expect(await productos.getPendingCatalogPush(prisma)).toHaveLength(0);

    const encontrado = await productos.search(prisma, 'Producto nuevo');
    expect(encontrado).toHaveLength(1);

    await ventas.createLocal(prisma, {
      ...ventaPayload([
        partidaProducto(entrada.product.id, { unitPrice: 80, quantity: 1, subtotal: 80 }),
      ]),
      cashSessionId: turno.id,
    });

    expect((await prisma.product.findUnique({ where: { id: entrada.product.id } })).totalStock).toBe(4);
  });

  /**
   * FEFO: el mostrador despacha primero lo que caduca antes. El orden lo
   * resuelve la consulta de lotes, y de ahí sale el lote que la venta asienta —
   * si viniera al revés, la caducidad del ticket sería la equivocada y el lote
   * viejo se quedaría en el anaquel hasta vencerse.
   */
  it('al vender, los lotes salen por caducidad más próxima', async () => {
    const producto = await unProducto({ stock: 0 });

    // Se reciben desordenados a propósito: el que caduca antes llega después.
    await productos.recordStockEntry(prisma, {
      productId: producto.id,
      lotNumber: 'L-LEJANO',
      expiryDate: '2028-01-31',
      quantity: 5,
      invoiceId: 'inv-1',
    });
    await productos.recordStockEntry(prisma, {
      productId: producto.id,
      lotNumber: 'L-PROXIMO',
      expiryDate: '2026-11-30',
      quantity: 3,
      invoiceId: 'inv-2',
    });

    const lotes = await productos.getBatchesByProduct(prisma, producto.id);
    expect(lotes.map((lote) => lote.lotNumber)).toEqual(['L-PROXIMO', 'L-LEJANO']);
    expect((await prisma.product.findUnique({ where: { id: producto.id } })).totalStock).toBe(8);
  });

  /**
   * Lo que el cajero se lleva puesto al irse. `countPending` en el renderer suma
   * estas mismas colas: si una quedara fuera, salir con un corte o una entrada
   * sin subir no avisaría nada.
   */
  it('al terminar el turno, cada cosa sin subir sigue en su cola', async () => {
    const producto = await unProducto({ stock: 10, remoteId: 'REMOTO-1' });
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });

    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto(producto.id)]),
      cashSessionId: turno.id,
    });
    await cashMovements.addMovement(prisma, turno.id, {
      type: 'expense',
      amount: 20,
      reason: 'Comida',
      category: 'food',
      createdBy: CAJERO,
    });
    await productos.recordStockEntry(prisma, {
      productId: producto.id,
      lotNumber: 'L-9',
      expiryDate: '2027-05-31',
      quantity: 4,
      invoiceId: 'inv-3',
    });
    await cashSessions.closeLocal(prisma, turno.id, { countedCashAmount: 180, closedBy: CAJERO });

    // El turno todavía no subió, así que su movimiento espera con él.
    expect(await cashSessions.getPendingPush(prisma)).toHaveLength(1);
    expect(await productos.getPendingStockEntries(prisma)).toHaveLength(1);
    expect(await ventas.getPendingPush(prisma)).toHaveLength(1);

    // Con el alta del turno ya sincronizada, el movimiento y el cierre se sueltan.
    await cashSessions.markCreateSynced(prisma, turno.id, 'REMOTO-TURNO');
    expect(await cashMovements.getPendingPush(prisma)).toHaveLength(1);
    expect(await cashSessions.getPendingClosePush(prisma)).toHaveLength(1);
  });

  it('un gasto sin turno se rechaza: no tendría corte donde aparecer', async () => {
    await expect(
      cashMovements.addMovement(prisma, null, {
        type: 'expense',
        amount: 50,
        reason: 'Comida',
        category: 'food',
        createdBy: CAJERO,
      }),
    ).rejects.toThrow(/turno/i);
  });

  it('no se pueden abrir dos turnos del mismo cajero', async () => {
    await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });

    await expect(
      cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 300 }),
    ).rejects.toThrow(/ya tienes un turno/i);
  });
});

describe('sincronización: la cola contra el backend', () => {
  it('una venta de solo servicios sube sin necesitar ningún producto sincronizado', async () => {
    await unServicio();
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaServicio()]),
      cashSessionId: turno.id,
    });

    const pendientes = await ventas.getPendingPush(prisma);

    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].payload.items[0].serviceId).toBe('sv-1');
  });

  it('traduce el id local del producto al remoto y deja el del servicio intacto', async () => {
    await unProducto({ remoteId: 'remote-p1' });
    await unServicio();
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto(), partidaServicio()]),
      cashSessionId: turno.id,
    });

    const [pendiente] = await ventas.getPendingPush(prisma);

    expect(pendiente.payload.items[0].productId).toBe('remote-p1');
    expect(pendiente.payload.items[1].serviceId).toBe('sv-1');
  });

  it('una venta cuyo producto nunca sincroniza acaba en revisión manual, no invisible', async () => {
    await unProducto({ remoteId: null });
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 0 });
    await ventas.createLocal(prisma, {
      ...ventaPayload([partidaProducto()]),
      cashSessionId: turno.id,
    });

    for (let ciclo = 0; ciclo < 6; ciclo += 1) {
      expect(await ventas.getPendingPush(prisma)).toHaveLength(0);
    }

    const [fila] = await prisma.sale.findMany();
    expect(fila.pushError).toMatch(/espera a que su turno o alguno de sus productos sincronice/i);
  });

  it('el cierre de un turno no se puede subir antes que su alta', async () => {
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await cashSessions.closeLocal(prisma, turno.id, { countedCashAmount: 100, closedBy: CAJERO });

    // Sin `remoteId`, el backend no sabría a qué turno cerrar.
    expect(await cashSessions.getPendingClosePush(prisma)).toHaveLength(0);

    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    expect(await cashSessions.getPendingClosePush(prisma)).toHaveLength(1);
  });

  it('adoptar un remoteId que ya es de otro turno se marca como conflicto, no revienta', async () => {
    const ayer = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await cashSessions.markCreateSynced(prisma, ayer.id, 'remote-1');
    await cashSessions.closeLocal(prisma, ayer.id, { countedCashAmount: 500, closedBy: CAJERO });
    const hoy = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });

    // Con SQLite real, sin la guarda esto sería el P2002 que se vio en producción.
    const resultado = await cashSessions.markCreateSynced(prisma, hoy.id, 'remote-1');

    // El dueño del `remoteId` ya cerró en local: el hueco en el servidor se
    // libera subiendo ESE cierre, así que se reencola y el alta de hoy se queda
    // en cola —sin bloquear— para el ciclo siguiente (closes → creates).
    expect(resultado).toEqual({ conflict: true, requeuedClose: true });
    const fila = await prisma.cashSession.findUnique({ where: { id: hoy.id } });
    expect(fila.remoteId).toBeNull();
    // Sin `pushError`: no hay nada que un humano deba resolver, se resuelve solo.
    expect(fila.pushError).toBeNull();
    expect(await cashSessions.getPendingClosePush(prisma)).toHaveLength(1);
  });

  /**
   * La otra rama del mismo conflicto: el dueño del `remoteId` sigue **abierto**
   * en local, así que no hay cierre que reencolar y nadie puede liberar el hueco
   * solo. Ahí sí se bloquea el alta nueva con un motivo legible.
   */
  it('si el dueño del remoteId sigue abierto, el alta nueva queda bloqueada con motivo', async () => {
    const otro = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await cashSessions.markCreateSynced(prisma, otro.id, 'remote-1');
    const hoy = await cashSessions.createLocal(prisma, { openedBy: 'otro-cajero', openingAmount: 300 });

    const resultado = await cashSessions.markCreateSynced(prisma, hoy.id, 'remote-1');

    expect(resultado).toEqual({ conflict: true });
    const fila = await prisma.cashSession.findUnique({ where: { id: hoy.id } });
    expect(fila.remoteId).toBeNull();
    expect(fila.pushError).toMatch(/ya pertenece a otro turno/i);
  });

  it('un movimiento espera a que su turno tenga remoteId, y luego sube con él', async () => {
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await cashMovements.addMovement(prisma, turno.id, {
      type: 'withdrawal',
      amount: 100,
      reason: 'Depósito al banco',
      createdBy: CAJERO,
    });

    expect(await cashMovements.getPendingPush(prisma)).toHaveLength(0);

    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    const [pendiente] = await cashMovements.getPendingPush(prisma);
    expect(pendiente.cashSessionRemoteId).toBe('remote-turno-1');
  });
});

describe('el catálogo de servicios contra la base real', () => {
  it('el pull es idempotente y refleja las bajas', async () => {
    await unServicio();
    await unServicio({ price: 250 });

    const activos = await catalogo.listServices(prisma);
    expect(activos).toHaveLength(1);
    expect(activos[0].price).toBe(250);

    await catalogo.upsertServices(prisma, [
      { id: 'sv-1', code: 'COD-sv-1', name: 'Consulta', serviceType: 'consultation', price: 250, isActive: false, updatedAt: '2026-09-08T10:00:00.000Z' },
    ]);
    expect(await catalogo.listServices(prisma)).toHaveLength(0);
    // Pero sigue existiendo, para que una venta vieja pueda mostrar su nombre.
    expect(await catalogo.getServiceById(prisma, 'sv-1')).not.toBeNull();
  });

  it('el buscador de entrada de stock no ve los servicios', async () => {
    await unServicio();
    await unProducto();

    const encontrados = await productos.search(prisma, 'Consulta');

    // Si un servicio apareciera aquí, se le podría dar entrada de mercancía.
    // El control de que la búsqueda sí encuentra productos evita que esta
    // prueba pase por estar buscando mal.
    expect(encontrados).toEqual([]);
    expect(await productos.search(prisma, 'Producto')).toHaveLength(1);
  });

  it('recordStockEntry no puede tocar un servicio', async () => {
    await unServicio();

    // Con el mensaje exacto: si un día fallara por otra razón (una factura
    // faltante, por ejemplo), esta prueba pasaría sin comprobar nada.
    await expect(
      productos.recordStockEntry(prisma, {
        productId: 'sv-1',
        lotNumber: 'L1',
        expiryDate: '2027-01-01',
        quantity: 10,
      }),
    ).rejects.toThrow(/no se encontró el producto local/i);

    // Control: el mismo camino sí funciona con un producto de verdad.
    await unProducto({ id: 'p-real', stock: 5 });
    const resultado = await productos.recordStockEntry(prisma, {
      productId: 'p-real',
      lotNumber: 'L1',
      expiryDate: '2027-01-01',
      quantity: 10,
    });
    expect(resultado.stock).toBe(15);
  });
});
