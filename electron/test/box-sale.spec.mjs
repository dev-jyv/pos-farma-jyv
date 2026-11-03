import { beforeEach, describe, expect, it } from 'vitest';

import productos from '../db/products.js';
import ventas from '../db/sales.js';
import { createFakePrisma } from './fake-prisma.mjs';

/**
 * Venta por caja completa (SPEC 46) en la capa local: el catálogo trae los
 * campos de caja, el código de la caja se reconoce al escanear y el stock local
 * se descuenta en **piezas**.
 */

let prisma;

beforeEach(() => {
  prisma = createFakePrisma();
});

function remoto(overrides = {}) {
  return {
    id: 'r-amox',
    sku: 'AMOX-500',
    barcode: '7501000000011',
    name: 'Amoxicilina 500 mg',
    salePrice: 12,
    stock: 35,
    isActive: true,
    boxQuantity: 10,
    boxPrice: 100,
    boxBarcode: '17501000000018',
    ...overrides,
  };
}

describe('catálogo con caja', () => {
  it('el pull guarda piezas por caja, precio y código de la caja', async () => {
    await productos.upsertMany(prisma, [remoto()]);

    const [producto] = await productos.search(prisma, 'amox');

    expect(producto).toMatchObject({ boxQuantity: 10, boxPrice: 100, boxBarcode: '17501000000018', stock: 35 });
  });

  it('un backend anterior (sin campos de caja) deja el producto solo por pieza', async () => {
    const { boxQuantity: _q, boxPrice: _p, boxBarcode: _b, ...viejo } = remoto();
    await productos.upsertMany(prisma, [viejo]);

    const [producto] = await productos.search(prisma, 'amox');

    expect(producto.boxQuantity).toBeNull();
    expect(producto.boxPrice).toBeNull();
  });

  it('una caja a medias (piezas sin precio) no se ofrece', async () => {
    await productos.upsertMany(prisma, [remoto({ boxPrice: null })]);

    const [producto] = await productos.search(prisma, 'amox');

    expect(producto.boxQuantity).toBeNull();
  });

  it('el código de la caja también encuentra el producto en la búsqueda', async () => {
    await productos.upsertMany(prisma, [remoto()]);

    const encontrados = await productos.search(prisma, '17501000000018');

    expect(encontrados.map((p) => p.name)).toEqual(['Amoxicilina 500 mg']);
  });
});

describe('escaneo del código de la caja', () => {
  beforeEach(async () => {
    await productos.upsertMany(prisma, [remoto()]);
  });

  it('el código de la caja devuelve el producto marcado como caja', async () => {
    const producto = await productos.getByBarcode(prisma, '17501000000018');

    expect(producto).toMatchObject({ name: 'Amoxicilina 500 mg', saleUnit: 'box', boxQuantity: 10 });
  });

  it('el código de la pieza sigue devolviendo la pieza', async () => {
    const producto = await productos.getByBarcode(prisma, '7501000000011');

    expect(producto.saleUnit).toBeUndefined();
  });

  it('si el producto ya no se vende por caja, su código no lo agrega como caja', async () => {
    await productos.upsertMany(prisma, [remoto({ boxQuantity: null, boxPrice: null })]);

    const producto = await productos.getByBarcode(prisma, '17501000000018');

    expect(producto.saleUnit).toBeUndefined();
  });
});

function ventaConCaja({ boxes = 2, piecesPerBox = 10, boxPrice = 100, quantity } = {}) {
  const subtotal = boxes * boxPrice;
  const item = {
    kind: 'product',
    productId: 'p-amox',
    productName: 'Amoxicilina 500 mg',
    unitPrice: boxPrice,
    discountAmount: 0,
    // El renderer manda piezas; la capa local las deriva de todos modos.
    quantity: quantity ?? boxes * piecesPerBox,
    subtotal,
    saleUnit: { type: 'box', boxes, piecesPerBox, boxPrice },
  };
  return {
    folio: 'PENDIENTE-1',
    idempotencyKey: `k-${Math.random()}`,
    subtotal,
    discountTotal: 0,
    total: subtotal,
    taxSummary: null,
    paymentMethod: 'cash',
    amountReceived: subtotal,
    change: 0,
    cashAmount: subtotal,
    cardAmount: null,
    cardPaymentReference: null,
    cashSessionId: 'cs-1',
    cashierId: 'uid-cajero',
    controlledGroups: [],
    items: [item],
    payload: {
      items: [{ kind: 'product', productId: 'p-amox', quantity: boxes, unitPrice: boxPrice, discountAmount: 0, saleUnit: 'box' }],
    },
  };
}

describe('stock local en piezas', () => {
  beforeEach(async () => {
    await prisma.product.create({
      data: { id: 'p-amox', remoteId: 'r-amox', name: 'Amoxicilina', sku: 'AMOX', salePrice: 12, totalStock: 35, boxQuantity: 10, boxPrice: 100 },
    });
  });

  it('vender 2 cajas de 10 descuenta 20 piezas', async () => {
    await ventas.createLocal(prisma, ventaConCaja());

    expect(prisma.product.rows[0].totalStock).toBe(15);
  });

  it('aunque el renderer mande la cantidad en cajas, se descuentan piezas', async () => {
    await ventas.createLocal(prisma, ventaConCaja({ quantity: 2 }));

    expect(prisma.product.rows[0].totalStock).toBe(15);
  });

  it('la partida guarda piezas en quantity y la caja en saleUnit', async () => {
    const venta = await ventas.createLocal(prisma, ventaConCaja());

    expect(venta.items[0]).toMatchObject({
      quantity: 20,
      unitPrice: 100,
      subtotal: 200,
      saleUnit: { type: 'box', boxes: 2, piecesPerBox: 10, boxPrice: 100 },
    });
  });

  it('anular repone las 20 piezas', async () => {
    const venta = await ventas.createLocal(prisma, ventaConCaja());

    await ventas.voidLocal(prisma, venta.id, 'uid-admin');

    expect(prisma.product.rows[0].totalStock).toBe(35);
  });

  it('el payload que sube conserva saleUnit y la cantidad en cajas', async () => {
    await ventas.createLocal(prisma, ventaConCaja());

    const [pendiente] = await ventas.getPendingPush(prisma);

    expect(pendiente.payload.items[0]).toMatchObject({ productId: 'r-amox', quantity: 2, unitPrice: 100, saleUnit: 'box' });
  });
});
