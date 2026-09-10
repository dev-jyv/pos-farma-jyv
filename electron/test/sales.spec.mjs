import { describe, expect, it, beforeEach } from 'vitest';

import sales from '../db/sales.js';
import { createFakePrisma } from './fake-prisma.mjs';

const {
  createLocal,
  voidLocal,
  discard,
  getPendingPush,
  markPushFailed,
  clearPushError,
  getNeedingRemoteVoid,
  list,
} = sales;

const CAJERO = 'uid-cajero';

let prisma;

beforeEach(() => {
  prisma = createFakePrisma();
});

async function producto(id, { remoteId = null, stock = 10 } = {}) {
  return prisma.product.create({
    data: { id, remoteId, name: `Producto ${id}`, sku: id, salePrice: 100, totalStock: stock },
  });
}

function partidaProducto(productId, overrides = {}) {
  return {
    kind: 'product',
    productId,
    productName: 'Paracetamol',
    unitPrice: 100,
    discountAmount: 0,
    quantity: 2,
    subtotal: 200,
    ...overrides,
  };
}

function partidaServicio(serviceId = 'sv-1', overrides = {}) {
  return {
    kind: 'service',
    serviceId,
    productName: 'Consulta general',
    providerId: 'dr-1',
    providerName: 'Dra. Ruiz',
    commissionRate: 10,
    commissionAmount: 20,
    unitPrice: 200,
    discountAmount: 0,
    quantity: 1,
    subtotal: 200,
    ...overrides,
  };
}

function venta(items, overrides = {}) {
  const total = items.reduce((suma, item) => suma + item.subtotal - item.discountAmount, 0);
  return {
    folio: 'PENDIENTE-1',
    idempotencyKey: `k-${Math.random()}`,
    subtotal: total,
    discountTotal: 0,
    total,
    taxSummary: null,
    paymentMethod: 'cash',
    amountReceived: total,
    change: 0,
    cashAmount: total,
    cardAmount: null,
    cardPaymentReference: null,
    cashSessionId: 'cs-1',
    cashierId: CAJERO,
    customerId: null,
    customerName: null,
    prescription: null,
    prescriptionRetained: false,
    controlledGroups: [],
    billing: null,
    invoiceStatus: null,
    items,
    payload: { items: items.map((item) => ({ ...item })) },
    ...overrides,
  };
}

describe('venta local: los servicios no tocan inventario', () => {
  it('una partida de producto descuenta stock', async () => {
    await producto('p-1', { stock: 10 });

    await createLocal(prisma, venta([partidaProducto('p-1')]));

    expect(prisma.product.rows[0].totalStock).toBe(8);
  });

  it('una partida de servicio no descuenta nada de ningún producto', async () => {
    await producto('p-1', { stock: 10 });

    await createLocal(prisma, venta([partidaServicio()]));

    expect(prisma.product.rows[0].totalStock).toBe(10);
  });

  it('en un ticket mixto solo se descuenta el medicamento', async () => {
    await producto('p-1', { stock: 10 });

    await createLocal(prisma, venta([partidaProducto('p-1'), partidaServicio()]));

    expect(prisma.product.rows[0].totalStock).toBe(8);
  });

  it('guarda la partida de servicio con su comisión congelada', async () => {
    const creada = await createLocal(prisma, venta([partidaServicio()]));

    const servicio = creada.items.find((item) => item.kind === 'service');
    expect(servicio).toMatchObject({
      serviceId: 'sv-1',
      providerId: 'dr-1',
      providerName: 'Dra. Ruiz',
      commissionRate: 10,
      commissionAmount: 20,
    });
    expect(servicio.productId).toBeUndefined();
  });

  it('una partida sin `kind` (venta anterior a los servicios) se trata como producto', async () => {
    await producto('p-1', { stock: 10 });

    await createLocal(prisma, venta([partidaProducto('p-1', { kind: undefined })]));

    expect(prisma.product.rows[0].totalStock).toBe(8);
  });
});

describe('anulación', () => {
  it('repone el stock del medicamento', async () => {
    await producto('p-1', { stock: 10 });
    const creada = await createLocal(prisma, venta([partidaProducto('p-1')]));

    await voidLocal(prisma, creada.id, 'uid-admin');

    expect(prisma.product.rows[0].totalStock).toBe(10);
    expect(prisma.sale.rows[0].voidedAt).toBeTruthy();
  });

  it('si ya tiene remoteId, encola needsRemoteVoid para el sync', async () => {
    await producto('p-1', { stock: 10 });
    const creada = await createLocal(prisma, venta([partidaProducto('p-1')]));
    prisma.sale.rows.find((row) => row.id === creada.id).remoteId = 'remote-sale-1';
    prisma.sale.rows.find((row) => row.id === creada.id).pendingPush = false;

    await voidLocal(prisma, creada.id, 'uid-admin');

    expect(prisma.sale.rows[0].needsRemoteVoid).toBe(true);
    expect((await getNeedingRemoteVoid(prisma)).map((row) => row.id)).toContain(creada.id);
  });

  it('sin remoteId no encola void remoto (sube por getPendingVoided)', async () => {
    await producto('p-1', { stock: 10 });
    const creada = await createLocal(prisma, venta([partidaProducto('p-1')]));

    await voidLocal(prisma, creada.id, 'uid-admin');

    expect(prisma.sale.rows[0].needsRemoteVoid).toBe(false);
    expect(await getNeedingRemoteVoid(prisma)).toEqual([]);
  });

  /**
   * Regresión: la reposición usaba `update`, que lanza P2025 si el producto no
   * existe, y eso **abortaba la anulación entera** dejando la venta viva. Anular
   * nunca puede fallar por un problema de catálogo.
   */
  it('anula aunque el producto ya no exista en el catálogo local', async () => {
    const creada = await createLocal(prisma, venta([partidaProducto('p-fantasma')]));

    await expect(voidLocal(prisma, creada.id, 'uid-admin')).resolves.toBeTruthy();
    expect(prisma.sale.rows[0].voidedAt).toBeTruthy();
  });

  it('anula un ticket mixto sin tropezar con la partida de servicio', async () => {
    await producto('p-1', { stock: 10 });
    const creada = await createLocal(prisma, venta([partidaProducto('p-1'), partidaServicio()]));

    await voidLocal(prisma, creada.id, 'uid-admin');

    expect(prisma.sale.rows[0].voidedAt).toBeTruthy();
    expect(prisma.product.rows[0].totalStock).toBe(10);
  });

  it('descartar una venta con servicios tampoco tropieza', async () => {
    await producto('p-1', { stock: 10 });
    const creada = await createLocal(prisma, venta([partidaProducto('p-1'), partidaServicio()]));

    await discard(prisma, creada.id);

    expect(prisma.sale.rows).toHaveLength(0);
    expect(prisma.product.rows[0].totalStock).toBe(10);
  });
});

describe('totales denormalizados', () => {
  it('una venta solo de farmacia queda 100% farmacia', async () => {
    await producto('p-1');
    await createLocal(prisma, venta([partidaProducto('p-1')]));

    expect(prisma.sale.rows[0]).toMatchObject({ pharmacyTotal: 200, servicesTotal: 0, commissionTotal: 0 });
  });

  it('respeta el reparto que calculó el renderer en un ticket mixto', async () => {
    await producto('p-1');
    const items = [partidaProducto('p-1'), partidaServicio()];

    await createLocal(
      prisma,
      venta(items, {
        pharmacyTotal: 200,
        servicesTotal: 200,
        // Servicios primero: el efectivo cubre antes la consulta.
        servicesCashAmount: 200,
        pharmacyCashAmount: 200,
        commissionTotal: 20,
      }),
    );

    expect(prisma.sale.rows[0]).toMatchObject({
      pharmacyTotal: 200,
      servicesTotal: 200,
      servicesCashAmount: 200,
      pharmacyCashAmount: 200,
      commissionTotal: 20,
    });
  });
});

describe('traducción del turno al empujar', () => {
  it('espera si el turno todavía no tiene id en el servidor', async () => {
    await producto('p1', { remoteId: 'P-REMOTO' });
    await prisma.cashSession.create({ data: { id: 'cs-local', openedBy: CAJERO, remoteId: null } });
    await createLocal(prisma, venta([partidaProducto('p1')], {
      cashSessionId: 'cs-local',
      payload: { items: [partidaProducto('p1')], cashSessionId: 'cs-local' },
    }));

    // Mandarla ahora sería condenarla: el backend no conoce ese uuid local.
    expect(await getPendingPush(prisma, { contarIntentos: true })).toHaveLength(0);
  });

  /**
   * Regresión (QA-14): no enviarla es correcto; **ocultarla** no. La lectura de
   * la UI la omitía, así que una venta ya cobrada no salía en la barra de
   * pendientes ni en el conteo del shell, y el aviso del corte decía "Quedan 1"
   * con dos movimientos sin subir. La cajera solo se enteraba cuando agotaba los
   * seis intentos y aparecía como rechazada.
   */
  it('la lectura de la UI sí la reporta, marcada como que espera a su turno', async () => {
    await producto('p1', { remoteId: 'P-REMOTO' });
    await prisma.cashSession.create({ data: { id: 'cs-local', openedBy: CAJERO, remoteId: null } });
    await createLocal(prisma, venta([partidaProducto('p1')], {
      cashSessionId: 'cs-local',
      payload: { items: [partidaProducto('p1')], cashSessionId: 'cs-local' },
    }));

    const [esperando] = await getPendingPush(prisma);

    expect(esperando).toBeDefined();
    expect(esperando.esperandoPor).toBe('turno');
    // Sin payload: es la señal de que todavía no se puede enviar.
    expect(esperando.payload).toBeNull();
    expect(esperando.pushError).toBeNull();
  });

  it('distingue cuando lo que falta es un producto nuevo, no el turno', async () => {
    await producto('p1', { remoteId: null });
    await createLocal(prisma, venta([partidaProducto('p1')], { cashSessionId: 'YA-REMOTO' }));

    const [esperando] = await getPendingPush(prisma);

    expect(esperando.esperandoPor).toBe('catalogo');
    expect(esperando.payload).toBeNull();
  });

  it('manda el id remoto del turno, no el local', async () => {
    await producto('p1', { remoteId: 'P-REMOTO' });
    await prisma.cashSession.create({
      data: { id: 'cs-local', openedBy: CAJERO, remoteId: 'REMOTO-1' },
    });
    await createLocal(prisma, venta([partidaProducto('p1')], {
      cashSessionId: 'cs-local',
      payload: { items: [partidaProducto('p1')], cashSessionId: 'cs-local' },
    }));

    const [pendiente] = await getPendingPush(prisma);
    // Antes viajaba 'cs-local' y el backend respondía "Turno de caja no encontrado".
    expect(pendiente.payload.cashSessionId).toBe('REMOTO-1');
  });

  it('deja pasar tal cual un id que ya es remoto (turno nacido en el servidor)', async () => {
    await producto('p1', { remoteId: 'P-REMOTO' });
    await createLocal(prisma, venta([partidaProducto('p1')], {
      cashSessionId: 'YA-REMOTO',
      payload: { items: [partidaProducto('p1')], cashSessionId: 'YA-REMOTO' },
    }));

    const [pendiente] = await getPendingPush(prisma);
    expect(pendiente.payload.cashSessionId).toBe('YA-REMOTO');
  });

  it('la ruta de anuladas también manda el id remoto del turno', async () => {
    await producto('p1', { remoteId: 'P-REMOTO' });
    await prisma.cashSession.create({
      data: { id: 'cs-local', openedBy: CAJERO, remoteId: 'REMOTO-1' },
    });
    const creada = await createLocal(prisma, venta([partidaProducto('p1')], {
      cashSessionId: 'cs-local',
      payload: { items: [partidaProducto('p1')], cashSessionId: 'cs-local' },
    }));
    // Anulada antes de sincronizar: sube por `getPendingVoided`, no por la cola normal.
    await voidLocal(prisma, creada.id, CAJERO);

    const [pendiente] = await sales.getPendingVoided(prisma);
    expect(pendiente.payload.cashSessionId).toBe('REMOTO-1');
  });
});

describe('cola de push', () => {
  it('una venta de solo servicios se puede subir aunque no haya productos que traducir', async () => {
    await createLocal(prisma, venta([partidaServicio()]));

    const pendientes = await getPendingPush(prisma);

    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].payload.items[0].serviceId).toBe('sv-1');
  });

  it('traduce el id local del producto al remoto y deja el servicio intacto', async () => {
    await producto('p-1', { remoteId: 'remote-p1' });
    await createLocal(prisma, venta([partidaProducto('p-1'), partidaServicio()]));

    const [pendiente] = await getPendingPush(prisma);

    expect(pendiente.payload.items[0].productId).toBe('remote-p1');
    expect(pendiente.payload.items[1].serviceId).toBe('sv-1');
  });

  it('espera si el producto todavía no sincroniza', async () => {
    await producto('p-1', { remoteId: null });
    await createLocal(prisma, venta([partidaProducto('p-1')]));

    expect(await getPendingPush(prisma, { contarIntentos: true })).toHaveLength(0);
    expect(prisma.sale.rows[0].payloadResolveAttempts).toBe(1);
    expect(prisma.sale.rows[0].pushError).toBeNull();
  });

  /**
   * Regresión: antes esto era un `continue` sin memoria. Una venta cuyo producto
   * nunca sincronizara quedaba invisible para siempre — ni en la cola ni en la
   * lista de bloqueadas — y nadie se enteraba de que ese dinero no subió.
   */
  it('tras varios ciclos sin poder resolver, la manda a revisión manual', async () => {
    await producto('p-1', { remoteId: null });
    await createLocal(prisma, venta([partidaProducto('p-1')]));

    for (let ciclo = 0; ciclo < 6; ciclo += 1) {
      await getPendingPush(prisma, { contarIntentos: true });
    }

    expect(prisma.sale.rows[0].pushError).toMatch(/espera a que su turno o alguno de sus productos sincronice/i);
    expect(prisma.sale.rows[0].payloadResolveAttempts).toBe(6);
  });

  it('si el producto sincroniza a tiempo, el contador se reinicia', async () => {
    const creado = await producto('p-1', { remoteId: null });
    await createLocal(prisma, venta([partidaProducto('p-1')]));
    await getPendingPush(prisma, { contarIntentos: true });
    expect(prisma.sale.rows[0].payloadResolveAttempts).toBe(1);

    prisma.product.rows.find((row) => row.id === creado.id).remoteId = 'remote-p1';
    const pendientes = await getPendingPush(prisma, { contarIntentos: true });

    expect(pendientes).toHaveLength(1);
    expect(prisma.sale.rows[0].payloadResolveAttempts).toBe(0);
  });

  /**
   * Regresión: el contador vivía dentro de una consulta que también usa la UI
   * (barra de pendientes, conteo del shell, refresco al cobrar/descartar). El
   * cupo se gastaba en ~6 refrescos de pantalla en vez de 6 ciclos de sync: con
   * el turno aún sin `remoteId`, a la sexta venta cobrada la primera ya estaba
   * bloqueada y salía de la cola.
   */
  it('las lecturas de la UI no consumen el cupo de reintentos', async () => {
    await producto('p-1', { remoteId: null });
    await createLocal(prisma, venta([partidaProducto('p-1')]));

    for (let refresco = 0; refresco < 10; refresco += 1) {
      await getPendingPush(prisma);
    }

    expect(prisma.sale.rows[0].payloadResolveAttempts ?? 0).toBe(0);
    expect(prisma.sale.rows[0].pushError).toBeNull();
  });

  /** Reintentar tiene que servir: si no repone el cupo, se rebloquea al instante. */
  it('destrabar una venta repone su cupo de intentos', async () => {
    await producto('p-1', { remoteId: null });
    const creada = await createLocal(prisma, venta([partidaProducto('p-1')]));
    for (let ciclo = 0; ciclo < 6; ciclo += 1) {
      await getPendingPush(prisma, { contarIntentos: true });
    }
    expect(prisma.sale.rows[0].pushError).toBeTruthy();

    await clearPushError(prisma, creada.id);

    expect(prisma.sale.rows[0].payloadResolveAttempts).toBe(0);
    // Un solo push posterior no la vuelve a bloquear.
    await getPendingPush(prisma, { contarIntentos: true });
    expect(prisma.sale.rows[0].pushError).toBeNull();
  });

  it('una venta bloqueada no se reintenta sola hasta que alguien la destraba', async () => {
    await producto('p-1', { remoteId: 'remote-p1' });
    const creada = await createLocal(prisma, venta([partidaProducto('p-1')]));
    await markPushFailed(prisma, creada.id, 'stock insuficiente');

    expect(await getPendingPush(prisma)).toHaveLength(0);

    await clearPushError(prisma, creada.id);
    expect(await getPendingPush(prisma)).toHaveLength(1);
  });
});

describe('historial local: la caja es del equipo, la venta es del cajero', () => {
  /**
   * Regresión (QA-3): `list()` no aceptaba `cashierId`, así que el historial —que
   * lee la SQLite del equipo, no `GET /sales`— mostraba las ventas del turno
   * anterior de otra persona, y con `sales:write` o `pos:write` se podían anular
   * desde el detalle.
   */
  it('con cashierId solo devuelve las de ese cajero', async () => {
    await producto('p-1');
    await createLocal(prisma, venta([partidaProducto('p-1')], { cashierId: CAJERO }));
    await createLocal(prisma, venta([partidaProducto('p-1')], { cashierId: 'uid-otro-cajero' }));

    const propias = await list(prisma, { cashierId: CAJERO });

    expect(propias).toHaveLength(1);
    expect(propias[0].cashierId).toBe(CAJERO);
  });

  it('sin cashierId devuelve las de todo el equipo (el admin audita)', async () => {
    await producto('p-1');
    await createLocal(prisma, venta([partidaProducto('p-1')], { cashierId: CAJERO }));
    await createLocal(prisma, venta([partidaProducto('p-1')], { cashierId: 'uid-otro-cajero' }));

    expect(await list(prisma, {})).toHaveLength(2);
  });
});
