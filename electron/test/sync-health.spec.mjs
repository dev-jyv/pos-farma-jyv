import { beforeEach, describe, expect, it } from 'vitest';

import sales from '../db/sales.js';
import blockers from '../db/sale-blockers.js';
import syncLog from '../db/sync-log.js';
import diagnostics from '../db/diagnostics.js';
import products from '../db/products.js';
import cashSessions from '../db/cash-sessions.js';
import { createFakePrisma } from './fake-prisma.mjs';

/**
 * Salud de la cola de ventas: bloqueadores con nombre, autocorrección de las
 * ventas atoradas y la foto que viaja en el diagnóstico remoto.
 *
 * Caso real que motivó todo esto: ventas con "Esta venta espera a que su turno
 * o alguno de sus productos sincronice…" que nunca salían de la caja y de las
 * que el servidor no tenía rastro.
 */

const CAJERO = 'uid-cajero';
const UUID_LOCAL = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const ID_FIRESTORE = 'Ab3dE6gH9jK2mN5pQ8sT';

let prisma;

beforeEach(() => {
  prisma = createFakePrisma();
});

async function producto(id, extra = {}) {
  return prisma.product.create({
    data: { id, remoteId: null, name: `Producto ${id}`, sku: id, salePrice: 100, totalStock: 10, ...extra },
  });
}

async function turno(id, extra = {}) {
  return prisma.cashSession.create({
    data: { id, openedBy: CAJERO, openedByLabel: 'ana@farma.mx', openingAmount: 0, ...extra },
  });
}

function partida(productId, productName = 'Paracetamol 500') {
  return { kind: 'product', productId, productName, unitPrice: 100, discountAmount: 0, quantity: 1, subtotal: 100 };
}

async function venta(items, { cashSessionId = 'cs-remoto-sin-fila', folio = 'PENDIENTE-1' } = {}) {
  return sales.createLocal(prisma, {
    folio,
    idempotencyKey: `k-${Math.random()}`,
    subtotal: 100,
    discountTotal: 0,
    total: 100,
    paymentMethod: 'cash',
    cashAmount: 100,
    cashSessionId,
    cashierId: CAJERO,
    items,
    payload: { cashSessionId, items: items.map((item) => ({ ...item })) },
  });
}

async function agotarIntentos() {
  for (let ciclo = 0; ciclo < sales.MAX_RESOLVE_ATTEMPTS; ciclo += 1) {
    await sales.getPendingPush(prisma, { contarIntentos: true });
  }
}

describe('diagnoseSale', () => {
  it('nombra el turno sin remoteId con su cajero, fecha y error de apertura', async () => {
    await turno('cs-1', { openedAt: new Date(2026, 8, 25, 13, 2), pushError: 'Turno remoto ya abierto' });
    const creada = await venta([], { cashSessionId: 'cs-1' });

    const resultado = await blockers.diagnoseSale(prisma, creada.id);

    expect(resultado).toEqual([
      {
        kind: 'cashSession',
        localId: 'cs-1',
        remoteId: null,
        label: 'Turno de ana@farma.mx del 25/09 13:02',
        error: 'Turno remoto ya abierto',
        missingLocally: false,
      },
    ]);
  });

  it('nombra el producto sin remoteId con el error del catálogo o, si no, el del lote', async () => {
    await producto('p-cat', { catalogPushError: 'SKU duplicado' });
    await producto('p-lote');
    await prisma.batch.create({ data: { productId: 'p-lote', quantity: 5, pendingPush: true, pushError: 'Proveedor inválido' } });
    const creada = await venta([partida('p-cat'), partida('p-lote')]);

    const resultado = await blockers.diagnoseSale(prisma, creada.id);

    expect(resultado.map((b) => [b.localId, b.label, b.error])).toEqual([
      ['p-cat', 'Producto p-cat', 'SKU duplicado'],
      ['p-lote', 'Producto p-lote', 'Proveedor inválido'],
    ]);
  });

  it('un producto local inexistente sale como missingLocally con el nombre de la partida', async () => {
    const creada = await venta([partida(UUID_LOCAL, 'Ibuprofeno 400')]);

    const [bloqueador] = await blockers.diagnoseSale(prisma, creada.id);

    expect(bloqueador).toMatchObject({ kind: 'product', localId: UUID_LOCAL, label: 'Ibuprofeno 400', missingLocally: true });
  });

  it('no bloquea con un producto ya sincronizado ni con un id de Firestore sin fila local', async () => {
    await producto('p-ok', { remoteId: 'remote-ok' });
    const creada = await venta([partida('p-ok'), partida(ID_FIRESTORE)]);

    expect(await blockers.diagnoseSale(prisma, creada.id)).toEqual([]);
  });

  it('devuelve null si la venta no existe', async () => {
    expect(await blockers.diagnoseSale(prisma, 'no-existe')).toBeNull();
  });
});

describe('producto con id remoto sin fila local', () => {
  it('la venta sale en el push con el id tal cual, sin esperar', async () => {
    await venta([partida(ID_FIRESTORE)]);

    const pendientes = await sales.getPendingPush(prisma, { contarIntentos: true });

    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].payload.items[0].productId).toBe(ID_FIRESTORE);
    expect(prisma.sale.rows[0].payloadResolveAttempts).toBe(0);
  });

  it('un uuid local que ya no existe se bloquea en el acto con un motivo claro', async () => {
    await venta([partida(UUID_LOCAL, 'Ibuprofeno 400')]);

    await sales.getPendingPush(prisma, { contarIntentos: true });

    const fila = prisma.sale.rows[0];
    expect(fila.pushError).toMatch(/El producto Ibuprofeno 400 no existe en esta caja/);
    expect(fila.payloadResolveAttempts).toBe(sales.MAX_RESOLVE_ATTEMPTS);
    expect(prisma.syncLog.rows.at(-1)).toMatchObject({ level: 'warn', entity: 'sale', ref: fila.id });
  });
});

describe('bloqueo por espera con mensaje específico', () => {
  it('cita el turno y su error de apertura', async () => {
    await turno('cs-1', { openedAt: new Date(2026, 8, 25, 13, 2), pushError: 'el turno de caja ya está cerrado' });
    await venta([], { cashSessionId: 'cs-1' });

    await agotarIntentos();

    expect(prisma.sale.rows[0].pushError).toBe(
      'Espera al turno de ana@farma.mx del 25/09 13:02 (su apertura falló: el turno de caja ya está cerrado). ' +
        'Pulsa "Arreglar" para reintentarlo.',
    );
  });

  it('el healing de "turno cerrado" no limpia un bloqueo por espera que cita ese error', async () => {
    await turno('cs-1', { pushError: 'el turno de caja ya está cerrado' });
    await venta([], { cashSessionId: 'cs-1' });
    await agotarIntentos();
    const mensaje = prisma.sale.rows[0].pushError;

    await sales.getPendingPush(prisma, { contarIntentos: true });

    expect(prisma.sale.rows[0].pushError).toBe(mensaje);
  });
});

describe('healing de ventas bloqueadas por espera', () => {
  it('desbloquea y repone el cupo cuando el bloqueador ya sincronizó', async () => {
    await producto('p-1');
    await venta([partida('p-1')]);
    await agotarIntentos();
    expect(prisma.sale.rows[0].pushError).not.toBeNull();

    prisma.product.rows[0].remoteId = 'remote-p1';
    const pendientes = await sales.getPendingPush(prisma, { contarIntentos: true });

    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].payload.items[0].productId).toBe('remote-p1');
    expect(prisma.sale.rows[0]).toMatchObject({ pushError: null, payloadResolveAttempts: 0 });
    expect(prisma.syncLog.rows.some((r) => r.level === 'info' && /desbloqueada/.test(r.message))).toBe(true);
  });

  it('reescribe el mensaje genérico de versiones anteriores con el bloqueador concreto', async () => {
    await producto('p-1', { catalogPushError: 'SKU duplicado' });
    const creada = await venta([partida('p-1')]);
    const fila = prisma.sale.rows.find((r) => r.id === creada.id);
    fila.pushError =
      'Esta venta espera a que su turno o alguno de sus productos sincronice, y ya lleva demasiados intentos.';
    fila.payloadResolveAttempts = 0;

    await sales.getPendingPush(prisma);

    expect(fila.pushError).toMatch(/^Espera al producto Producto p-1 \(alta local sin subir: SKU duplicado\)/);
  });

  it('no toca un rechazo del servidor (sin contador al tope ni texto de espera)', async () => {
    const creada = await venta([partida(ID_FIRESTORE)]);
    await sales.markPushFailed(prisma, creada.id, 'Stock insuficiente');

    await sales.getPendingPush(prisma);

    expect(prisma.sale.rows[0].pushError).toBe('Stock insuficiente');
  });
});

describe('listBlocked con bloqueadores', () => {
  it('cada venta trae sus bloqueadores para el panel', async () => {
    await turno('cs-1', { pushError: 'boom' });
    await venta([], { cashSessionId: 'cs-1' });
    await agotarIntentos();

    const [registro] = await sales.listBlocked(prisma);

    expect(registro.blockers).toHaveLength(1);
    expect(registro.blockers[0]).toMatchObject({ kind: 'cashSession', localId: 'cs-1', error: 'boom' });
  });
});

describe('prepareUnreconciled', () => {
  it('omite el turno local sin remoteId y traduce los productos que sí tienen', async () => {
    await turno('cs-1', { pushError: 'rechazado' });
    await producto('p-1', { remoteId: 'remote-p1' });
    const creada = await venta([partida('p-1'), partida('p-2')], { cashSessionId: 'cs-1' });

    const preparada = await sales.prepareUnreconciled(prisma, creada.id);

    expect(preparada.cashSessionId).toBeNull();
    expect(preparada.payload).not.toHaveProperty('cashSessionId');
    expect(preparada.payload.items.map((i) => i.productId)).toEqual(['remote-p1', 'p-2']);
  });

  it('usa el remoteId del turno cuando ya existe', async () => {
    await turno('cs-1', { remoteId: 'remote-cs' });
    const creada = await venta([], { cashSessionId: 'cs-1' });

    const preparada = await sales.prepareUnreconciled(prisma, creada.id);

    expect(preparada.payload.cashSessionId).toBe('remote-cs');
  });

  it('null si la venta no existe', async () => {
    expect(await sales.prepareUnreconciled(prisma, 'nada')).toBeNull();
  });
});

describe('reintento de bloqueadores', () => {
  it('retryProductPush limpia el error del producto y de sus lotes pendientes', async () => {
    await producto('p-1', { catalogPushError: 'x', pushError: 'y' });
    await prisma.batch.create({ data: { productId: 'p-1', quantity: 1, pendingPush: true, pushError: 'z' } });

    expect(await products.retryProductPush(prisma, 'p-1')).toBe(true);

    expect(prisma.product.rows[0]).toMatchObject({ catalogPushError: null, pushError: null });
    expect(prisma.batch.rows[0].pushError).toBeNull();
    expect(await products.retryProductPush(prisma, 'no-existe')).toBe(false);
  });

  it('retryPush del turno limpia alta y cierre; false si no existe', async () => {
    await turno('cs-1', { pushError: 'a', closePushError: 'b' });

    expect(await cashSessions.retryPush(prisma, 'cs-1')).toBe(true);
    expect(prisma.cashSession.rows[0]).toMatchObject({ pushError: null, closePushError: null });
    expect(await cashSessions.retryPush(prisma, 'cs-x')).toBe(false);
  });
});

describe('SyncLog', () => {
  it('append normaliza nivel y recorta mensajes enormes', async () => {
    const dto = await syncLog.append(prisma, { level: 'raro', entity: 'sale', message: 'x'.repeat(5000), ref: 's-1' });

    expect(dto.level).toBe('info');
    expect(dto.message).toHaveLength(syncLog.MAX_MESSAGE_LENGTH);
    expect(dto.ref).toBe('s-1');
  });

  it('listRecent devuelve los más nuevos primero y respeta el límite', async () => {
    for (let i = 0; i < 5; i += 1) {
      await prisma.syncLog.create({ data: { level: 'info', entity: 'sync', message: `m${i}`, at: new Date(2026, 8, 1, 10, i) } });
    }

    const lista = await syncLog.listRecent(prisma, 2);

    expect(lista.map((r) => r.message)).toEqual(['m4', 'm3']);
  });

  it('purgeOld borra lo de más de 30 días', async () => {
    const ahora = new Date('2026-10-01T12:00:00Z');
    await prisma.syncLog.create({ data: { level: 'info', entity: 'sync', message: 'viejo', at: new Date('2026-08-20T12:00:00Z') } });
    await prisma.syncLog.create({ data: { level: 'info', entity: 'sync', message: 'nuevo', at: new Date('2026-09-20T12:00:00Z') } });

    expect(await syncLog.purgeOld(prisma, ahora)).toBe(1);
    expect(prisma.syncLog.rows.map((r) => r.message)).toEqual(['nuevo']);
  });

  it('appendSafe nunca lanza aunque la tabla no exista', async () => {
    delete prisma.syncLog;
    await expect(syncLog.appendSafe(prisma, { message: 'x' })).resolves.toBeNull();
  });
});

describe('snapshot de diagnóstico', () => {
  it('arma PosDiagnosticsInput desde SQLite', async () => {
    await turno('cs-1', { pushError: 'rechazado' });
    await producto('p-1', { catalogPushError: 'SKU duplicado' });
    await venta([partida('p-1')], { cashSessionId: 'cs-1', folio: 'PENDIENTE-9' });
    await venta([partida(ID_FIRESTORE)], { folio: 'PENDIENTE-10' });
    await agotarIntentos();
    await prisma.syncRun.create({ data: { entity: 'products', direction: 'pull', status: 'error', errorMessage: '503' } });

    const foto = await diagnostics.buildSnapshot(
      prisma,
      { deviceId: 'caja-1-aabb', deviceName: 'caja-1', appVersion: '1.0.5', platform: 'darwin-arm64' },
      new Date('2026-10-01T12:00:00Z'),
    );

    expect(foto).toMatchObject({
      deviceId: 'caja-1-aabb',
      deviceName: 'caja-1',
      appVersion: '1.0.5',
      platform: 'darwin-arm64',
      generatedAt: '2026-10-01T12:00:00.000Z',
      pendingSalesCount: 1,
    });
    expect(foto.blockedSales).toHaveLength(1);
    expect(foto.blockedSales[0]).toMatchObject({ folio: 'PENDIENTE-9', waitingFor: 'turno', total: 100 });
    expect(foto.blockedSales[0].blockers.map((b) => b.kind)).toEqual(['cashSession', 'product']);
    expect(foto.blockedCashSessions[0]).toMatchObject({ localId: 'cs-1', remoteId: null, pushError: 'rechazado' });
    expect(foto.unsyncedProducts[0]).toMatchObject({ localId: 'p-1', catalogPushError: 'SKU duplicado' });
    expect(foto.recentSyncRuns[0]).toMatchObject({ entity: 'products', status: 'error', errorMessage: '503' });
    expect(foto.syncLog.some((r) => r.entity === 'sale' && r.level === 'warn')).toBe(true);
  });

  const DEVICE = { deviceId: 'caja-1', deviceName: 'caja-1', appVersion: '1.0.9', platform: 'win32' };

  it('openCashSessionId es null sin turno abierto (no alerta por silencio)', async () => {
    await turno('cs-cerrado', { remoteId: 'remoto-1', closedAtLocal: new Date('2026-10-01T10:00:00Z') });

    const foto = await diagnostics.buildSnapshot(prisma, DEVICE);

    expect(foto.openCashSessionId).toBeNull();
  });

  it('openCashSessionId usa el remoteId del turno abierto, o el id local si aún no sube', async () => {
    await turno('cs-local', { openedAt: new Date('2026-10-01T09:00:00Z') });
    expect((await diagnostics.buildSnapshot(prisma, DEVICE)).openCashSessionId).toBe('cs-local');

    await prisma.cashSession.update({ where: { id: 'cs-local' }, data: { remoteId: 'Ab3dE6gH9jK2mN5pQ8sT' } });
    expect((await diagnostics.buildSnapshot(prisma, DEVICE)).openCashSessionId).toBe('Ab3dE6gH9jK2mN5pQ8sT');
  });

  it('si no puede leer el turno omite el campo en vez de mandar null', async () => {
    prisma.cashSession.findFirst = async () => {
      throw new Error('SQLITE_BUSY');
    };

    const foto = await diagnostics.buildSnapshot(prisma, DEVICE);

    expect('openCashSessionId' in foto).toBe(false);
    expect(JSON.parse(JSON.stringify(foto))).not.toHaveProperty('openCashSessionId');
  });
});
