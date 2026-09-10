import { describe, expect, it, beforeEach } from 'vitest';

import cashSessions from '../db/cash-sessions.js';
import cashMovements from '../db/cash-movements.js';
import { createFakePrisma } from './fake-prisma.mjs';

const {
  buildSummary,
  getOpenLocal,
  createLocal,
  getLiveSummary,
  closeLocal,
  getPendingPush,
  getPendingClosePush,
  markCreateSynced,
  markCloseSynced,
  markPushFailed,
  markClosePushFailed,
  clearPushError,
  clearClosePushError,
  listLocal,
  updateAdjustmentStatus,
} = cashSessions;

const CAJERO = 'uid-cajero';

let prisma;

beforeEach(() => {
  prisma = createFakePrisma();
});

function sale(overrides = {}) {
  return { paymentMethod: 'cash', total: 100, voidedAt: null, cashAmount: null, amountReceived: null, change: null, ...overrides };
}

describe('buildSummary — espejo de la aritmética del backend', () => {
  it('suma al cajón solo la parte en efectivo de las ventas cash y mixed', () => {
    const { expectedCashAmount, summary } = buildSummary(500, [
      sale({ paymentMethod: 'cash', total: 100, cashAmount: 100 }),
      sale({ paymentMethod: 'mixed', total: 250, cashAmount: 50 }),
      sale({ paymentMethod: 'card', total: 400 }),
      sale({ paymentMethod: 'transfer', total: 80 }),
    ], []);

    // 500 de fondo + 100 de la venta en efectivo + 50 de la parte en efectivo
    // de la mixta. Tarjeta y transferencia no tocan el cajón.
    expect(expectedCashAmount).toBe(650);
    expect(summary.grandTotal).toBe(830);
    expect(summary.salesCount).toBe(4);
    expect(summary.byMethod.card.total).toBe(400);
    expect(summary.byMethod.mixed.count).toBe(1);
  });

  it('reconstruye el efectivo de ventas viejas sin cashAmount (recibido − cambio)', () => {
    const { expectedCashAmount } = buildSummary(0, [
      sale({ paymentMethod: 'cash', total: 90, cashAmount: null, amountReceived: 100, change: 10 }),
    ], []);
    expect(expectedCashAmount).toBe(90);
  });

  it('excluye las ventas anuladas del total y del cajón, pero las cuenta aparte', () => {
    const { expectedCashAmount, summary } = buildSummary(100, [
      sale({ total: 50, cashAmount: 50 }),
      sale({ total: 999, cashAmount: 999, voidedAt: new Date() }),
    ], []);

    expect(expectedCashAmount).toBe(150);
    expect(summary.salesCount).toBe(1);
    expect(summary.voidedCount).toBe(1);
    expect(summary.grandTotal).toBe(50);
  });

  it('depósitos suman y retiros/gastos restan del efectivo esperado', () => {
    const { expectedCashAmount, summary } = buildSummary(1000, [], [
      { type: 'deposit', amount: 300 },
      { type: 'withdrawal', amount: 200 },
      { type: 'expense', amount: 150 },
      { type: 'expense', amount: 50 },
    ]);

    expect(expectedCashAmount).toBe(900);
    expect(summary.movements.deposits.total).toBe(300);
    expect(summary.movements.withdrawals.total).toBe(200);
    expect(summary.movements.expenses).toEqual({ count: 2, total: 200 });
  });

  it('un gasto afecta el cajón exactamente igual que un retiro del mismo monto', () => {
    const conGasto = buildSummary(500, [], [{ type: 'expense', amount: 120 }]);
    const conRetiro = buildSummary(500, [], [{ type: 'withdrawal', amount: 120 }]);
    expect(conGasto.expectedCashAmount).toBe(conRetiro.expectedCashAmount);
  });

  it('un turno sin ventas ni movimientos espera exactamente el fondo inicial', () => {
    expect(buildSummary(750, [], []).expectedCashAmount).toBe(750);
  });

  it('ignora métodos de pago desconocidos en el desglose sin romper el total', () => {
    const { summary } = buildSummary(0, [sale({ paymentMethod: 'crypto', total: 10 })], []);
    expect(summary.grandTotal).toBe(10);
    expect(summary.byMethod).not.toHaveProperty('crypto');
  });
});

describe('apertura y consulta del turno local', () => {
  it('crea el turno pendiente de subir y lo devuelve como abierto para ese cajero', async () => {
    const creado = await createLocal(prisma, { openedBy: CAJERO, openedByLabel: 'caja@farma.mx', openingAmount: 500 });

    expect(creado.remoteId).toBeNull();
    expect(creado.closedAt).toBeNull();
    expect(await getOpenLocal(prisma, CAJERO)).toMatchObject({ id: creado.id, openingAmount: 500 });
  });

  it('no devuelve el turno de otro cajero', async () => {
    await createLocal(prisma, { openedBy: 'otro-uid', openingAmount: 100 });
    expect(await getOpenLocal(prisma, CAJERO)).toBeNull();
  });

  it('deja de considerarlo abierto una vez cerrado', async () => {
    const abierto = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await closeLocal(prisma, abierto.id, { countedCashAmount: 100, closedBy: CAJERO });
    expect(await getOpenLocal(prisma, CAJERO)).toBeNull();
  });

  it('el resumen en vivo refleja ventas y gastos del turno, y solo de ese turno', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 200 });
    const otroTurno = await createLocal(prisma, { openedBy: 'otro-uid', openingAmount: 999 });

    await prisma.sale.create({ data: { cashSessionId: turno.id, paymentMethod: 'cash', total: 100, cashAmount: 100 } });
    await prisma.sale.create({ data: { cashSessionId: otroTurno.id, paymentMethod: 'cash', total: 5000, cashAmount: 5000 } });
    await cashMovements.addMovement(prisma, turno.id, {
      type: 'expense', amount: 50, reason: 'Comida', category: 'food', createdBy: CAJERO,
    });

    const { expectedCashAmount, summary } = await getLiveSummary(prisma, turno.id);
    expect(expectedCashAmount).toBe(250);
    expect(summary.salesCount).toBe(1);
  });

  it('falla claro si se pide el resumen de un turno inexistente', async () => {
    await expect(getLiveSummary(prisma, 'no-existe')).rejects.toThrow(/no se encontró el turno local/i);
  });
});

describe('cierre y ajuste pendiente', () => {
  async function turnoConEfectivo(esperado) {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: esperado });
    return turno;
  }

  it('sin diferencia no deja ajuste pendiente', async () => {
    const turno = await turnoConEfectivo(500);
    const cerrado = await closeLocal(prisma, turno.id, { countedCashAmount: 500, closedBy: CAJERO });

    expect(cerrado.cashDifference).toBe(0);
    expect(cerrado.hasPendingAdjustment).toBe(false);
    expect(cerrado.adjustmentStatus).toBeNull();
  });

  it('con faltante deja el ajuste pendiente de revisión de un administrador', async () => {
    const turno = await turnoConEfectivo(500);
    const cerrado = await closeLocal(prisma, turno.id, { countedCashAmount: 460, closedBy: CAJERO });

    expect(cerrado.cashDifference).toBe(-40);
    expect(cerrado.hasPendingAdjustment).toBe(true);
    expect(cerrado.adjustmentStatus).toBe('pending');
  });

  it('con sobrante también deja ajuste pendiente (sobra dinero no es "cuadra")', async () => {
    const turno = await turnoConEfectivo(500);
    const cerrado = await closeLocal(prisma, turno.id, { countedCashAmount: 520, closedBy: CAJERO });
    expect(cerrado.hasPendingAdjustment).toBe(true);
  });

  it('una diferencia menor a un centavo no genera ajuste (ruido de punto flotante)', async () => {
    const turno = await turnoConEfectivo(500);
    const cerrado = await closeLocal(prisma, turno.id, { countedCashAmount: 500.005, closedBy: CAJERO });
    expect(cerrado.hasPendingAdjustment).toBe(false);
  });

  it('exactamente un centavo de diferencia SÍ genera ajuste (frontera)', async () => {
    const turno = await turnoConEfectivo(500);
    const cerrado = await closeLocal(prisma, turno.id, { countedCashAmount: 500.01, closedBy: CAJERO });
    expect(cerrado.hasPendingAdjustment).toBe(true);
  });

  it('el auto-cierre por expiración NUNCA deja ajuste pendiente, ni con diferencia', async () => {
    const turno = await turnoConEfectivo(500);
    const cerrado = await closeLocal(prisma, turno.id, {
      countedCashAmount: 300,
      closedBy: CAJERO,
      autoClosedByExpiry: true,
    });

    expect(cerrado.autoClosedByExpiry).toBe(true);
    expect(cerrado.hasPendingAdjustment).toBe(false);
    expect(cerrado.adjustmentStatus).toBeNull();
  });

  it('congela el resumen del turno al cerrar (snapshot, no recálculo posterior)', async () => {
    const turno = await turnoConEfectivo(100);
    await prisma.sale.create({ data: { cashSessionId: turno.id, paymentMethod: 'cash', total: 40, cashAmount: 40 } });

    const cerrado = await closeLocal(prisma, turno.id, { countedCashAmount: 140, closedBy: CAJERO });
    expect(cerrado.summary.salesCount).toBe(1);
    expect(cerrado.expectedCashAmount).toBe(140);

    // Una venta que llegara después no puede alterar el corte ya firmado.
    await prisma.sale.create({ data: { cashSessionId: turno.id, paymentMethod: 'cash', total: 999, cashAmount: 999 } });
    const [almacenado] = await listLocal(prisma, {});
    expect(almacenado.summary.salesCount).toBe(1);
    expect(almacenado.expectedCashAmount).toBe(140);
  });

  it('el cierre deja el turno marcado para su propio push', async () => {
    const turno = await turnoConEfectivo(100);
    await closeLocal(prisma, turno.id, { countedCashAmount: 100, closedBy: CAJERO });
    const [fila] = prisma.cashSession.rows;
    expect(fila.pendingClosePush).toBe(true);
  });
});

/**
 * Equipo compartido por dos cajeros. El backend solo acepta el turno de quien lo
 * abrió (o el de un admin): si el cajero B sincroniza el turno de A, responde 403
 * y el POS se lo mostraba a B como un "rechazado" que B no podía resolver — pasó
 * en producción.
 */
describe('la cola de push es de cada cajero, no del equipo', () => {
  it('solo devuelve las altas del cajero que sincroniza', async () => {
    await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await createLocal(prisma, { openedBy: 'otro-cajero', openingAmount: 200 });

    const mios = await getPendingPush(prisma, { ownerUid: CAJERO });

    expect(mios).toHaveLength(1);
    expect(mios[0].openedBy).toBe(CAJERO);
  });

  it('solo devuelve los cierres del cajero que sincroniza', async () => {
    const ajeno = await createLocal(prisma, { openedBy: 'otro-cajero', openingAmount: 100 });
    await markCreateSynced(prisma, ajeno.id, 'remote-ajeno');
    await closeLocal(prisma, ajeno.id, { countedCashAmount: 100, closedBy: 'otro-cajero' });

    expect(await getPendingClosePush(prisma, { ownerUid: CAJERO })).toHaveLength(0);
    // Cuando entre su dueño, sí sube.
    expect(await getPendingClosePush(prisma, { ownerUid: 'otro-cajero' })).toHaveLength(1);
  });

  it('la primera pasada NO cierra un turno que aún tiene gastos en cola', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await markCreateSynced(prisma, turno.id, 'remote-1');
    await prisma.cashMovement.create({
      data: {
        id: 'mov-1',
        cashSessionId: turno.id,
        type: 'expense',
        amount: 100,
        reason: 'Comida',
        category: 'food',
        createdBy: CAJERO,
        pendingPush: true,
      },
    });
    await closeLocal(prisma, turno.id, { countedCashAmount: 400, closedBy: CAJERO });

    // Cerrarlo aquí condenaría al gasto: el backend lo rechaza con "el turno de
    // caja ya está cerrado" (el 400 que salía al cerrar sesión).
    expect(
      await getPendingClosePush(prisma, { ownerUid: CAJERO, sinHijosPendientes: true }),
    ).toHaveLength(0);
    // La pasada final sí lo cierra, ya con el gasto arriba.
    expect(await getPendingClosePush(prisma, { ownerUid: CAJERO })).toHaveLength(1);
  });

  /**
   * Una venta que el servidor ya tiene **activa** y que aquí se anuló: le falta
   * el `POST /sales/:id/void`. No lleva `pendingPush` —su alta sí subió—, así
   * que no la veía ninguno de los dos conteos de hijos y el cierre se le
   * adelantaba. Después de cerrar, el backend responde "solo un administrador
   * puede anularla" (un turno cerrado tiene su arqueo firmado) y el cajero se
   * queda sin poder aplicarla: el servidor conserva como buena una venta que en
   * la caja no existe.
   */
  it('la primera pasada NO cierra un turno con una anulación remota pendiente', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await markCreateSynced(prisma, turno.id, 'remote-1');
    await prisma.sale.create({
      data: {
        id: 'venta-1',
        cashSessionId: turno.id,
        remoteId: 'remota-1',
        // Su alta ya subió: por eso no está en `pendingPush`.
        pendingPush: false,
        needsRemoteVoid: true,
        voidedAt: new Date(),
        voidedBy: CAJERO,
        cashierId: CAJERO,
        folio: 'A-1',
        total: 100,
        subtotal: 100,
        discountTotal: 0,
        paymentMethod: 'cash',
      },
    });
    await closeLocal(prisma, turno.id, { countedCashAmount: 400, closedBy: CAJERO });

    expect(
      await getPendingClosePush(prisma, { ownerUid: CAJERO, sinHijosPendientes: true }),
    ).toHaveLength(0);
  });

  /**
   * Un hijo ya rechazado espera intervención del admin (reintentar, corregir o
   * descartar). Si retuviera el cierre, el turno quedaría abierto en el servidor
   * para siempre y su corte nunca aparecería en la auditoría — peor que el mal
   * que el filtro venía a evitar.
   */
  it('un gasto ya rechazado no retiene el cierre del turno', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 400 });
    await markCreateSynced(prisma, turno.id, 'remote-1');
    await prisma.cashMovement.create({
      data: {
        cashSessionId: turno.id,
        type: 'expense',
        amount: 100,
        reason: 'Proveedor',
        createdBy: CAJERO,
        pendingPush: true,
        pushError: 'El turno de caja ya está cerrado',
      },
    });
    await closeLocal(prisma, turno.id, { countedCashAmount: 300, closedBy: CAJERO });

    expect(
      await getPendingClosePush(prisma, { ownerUid: CAJERO, sinHijosPendientes: true }),
    ).toHaveLength(1);
  });

  it('la primera pasada sí cierra un turno sin nada en cola: es lo que libera el hueco', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await markCreateSynced(prisma, turno.id, 'remote-1');
    await closeLocal(prisma, turno.id, { countedCashAmount: 500, closedBy: CAJERO });

    expect(
      await getPendingClosePush(prisma, { ownerUid: CAJERO, sinHijosPendientes: true }),
    ).toHaveLength(1);
  });

  /** El admin desatora el equipo cuyo cajero ya no vuelve: sube todo. */
  it('sin `ownerUid` (admin) sube lo de todos', async () => {
    await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await createLocal(prisma, { openedBy: 'otro-cajero', openingAmount: 200 });

    expect(await getPendingPush(prisma)).toHaveLength(2);
  });
});

describe('colas de push: alta y cierre son independientes', () => {
  it('un turno nuevo está pendiente de alta, no de cierre', async () => {
    await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    expect(await getPendingPush(prisma)).toHaveLength(1);
    expect(await getPendingClosePush(prisma)).toHaveLength(0);
  });

  it('tras subir el alta ya no se reintenta el alta, y guarda el remoteId', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await markCreateSynced(prisma, turno.id, 'remote-1');

    expect(await getPendingPush(prisma)).toHaveLength(0);
    expect(prisma.cashSession.rows[0].remoteId).toBe('remote-1');
  });

  it('si el turno se cerró mientras el alta viajaba, el cierre queda encolado igual (carrera)', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await closeLocal(prisma, turno.id, { countedCashAmount: 100, closedBy: CAJERO });
    // El cierre local ocurrió ANTES de que el alta terminara de subir.
    await markCreateSynced(prisma, turno.id, 'remote-1');

    const pendientes = await getPendingClosePush(prisma);
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].id).toBe(turno.id);
  });

  it('un cierre no se puede subir mientras el alta no tenga remoteId', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await closeLocal(prisma, turno.id, { countedCashAmount: 100, closedBy: CAJERO });

    // Sin `markCreateSynced` no hay remoteId: el backend no sabría a qué turno cerrar.
    expect(await getPendingClosePush(prisma)).toHaveLength(0);
  });

  it('fallar el cierre NO reencola el alta (no se duplica el turno en el backend)', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await markCreateSynced(prisma, turno.id, 'remote-1');
    await closeLocal(prisma, turno.id, { countedCashAmount: 90, closedBy: CAJERO });
    await markClosePushFailed(prisma, turno.id, 'timeout');

    expect(await getPendingPush(prisma)).toHaveLength(0);
    expect(prisma.cashSession.rows[0].remoteId).toBe('remote-1');
  });

  it('un rechazo permanente saca la fila de la cola hasta que alguien lo limpie', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await markPushFailed(prisma, turno.id, 'turno ya abierto en otro equipo');
    expect(await getPendingPush(prisma)).toHaveLength(0);

    await clearPushError(prisma, turno.id);
    expect(await getPendingPush(prisma)).toHaveLength(1);
  });

  it('lo mismo para la cola de cierre', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await markCreateSynced(prisma, turno.id, 'remote-1');
    await closeLocal(prisma, turno.id, { countedCashAmount: 100, closedBy: CAJERO });
    await markClosePushFailed(prisma, turno.id, '500');
    expect(await getPendingClosePush(prisma)).toHaveLength(0);

    await clearClosePushError(prisma, turno.id);
    expect(await getPendingClosePush(prisma)).toHaveLength(1);
  });

  it('al confirmar el cierre adopta los importes autoritativos del backend', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await markCreateSynced(prisma, turno.id, 'remote-1');
    await closeLocal(prisma, turno.id, { countedCashAmount: 95, closedBy: CAJERO });
    await markCloseSynced(prisma, turno.id, { expectedCashAmount: 110, cashDifference: -15 });

    const fila = prisma.cashSession.rows[0];
    expect(fila.pendingClosePush).toBe(false);
    expect(fila.expectedCashAmount).toBe(110);
    expect(fila.cashDifference).toBe(-15);
  });

  it('si el backend no devuelve importes, conserva los locales en vez de borrarlos', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await markCreateSynced(prisma, turno.id, 'remote-1');
    await closeLocal(prisma, turno.id, { countedCashAmount: 95, closedBy: CAJERO });
    await markCloseSynced(prisma, turno.id, {});

    const fila = prisma.cashSession.rows[0];
    expect(fila.expectedCashAmount).toBe(100);
    expect(fila.cashDifference).toBe(-5);
  });
});

/**
 * El dinero no desaparece al cerrar el turno: sigue físicamente en el cajón y
 * debe aparecer precargado como fondo del turno siguiente.
 */
describe('efectivo que queda en caja (fondo del turno siguiente)', () => {
  const { getCashOnHand } = cashSessions;

  it('sin cierres previos no hay nada heredado', async () => {
    expect(await getCashOnHand(prisma)).toMatchObject({ amount: 0, lastClosedAt: null });
  });

  it('hereda lo que se CONTÓ al cerrar, no lo que se esperaba', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await prisma.sale.create({ data: { cashSessionId: turno.id, paymentMethod: 'cash', total: 300, cashAmount: 300 } });
    // Esperado 800, pero en el cajón solo había 780: ese es el dinero real.
    await closeLocal(prisma, turno.id, { countedCashAmount: 780, closedBy: CAJERO });

    const enCaja = await getCashOnHand(prisma);
    expect(enCaja.amount).toBe(780);
    expect(enCaja.countedAtLastClose).toBe(780);
  });

  it('un turno abierto no cuenta: solo hereda de turnos cerrados', async () => {
    const cerrado = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await closeLocal(prisma, cerrado.id, { countedCashAmount: 100, closedBy: CAJERO });
    await createLocal(prisma, { openedBy: 'otro-uid', openingAmount: 9999 });

    expect((await getCashOnHand(prisma)).amount).toBe(100);
  });

  it('toma el cierre más reciente, no el primero', async () => {
    const viejo = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await closeLocal(prisma, viejo.id, { countedCashAmount: 100, closedBy: CAJERO });
    const nuevo = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    prisma.cashSession.rows.find((row) => row.id === nuevo.id).openedAt = new Date('2026-09-06T14:00:00Z');
    await closeLocal(prisma, nuevo.id, { countedCashAmount: 450, closedBy: CAJERO });

    expect((await getCashOnHand(prisma)).amount).toBe(450);
  });

  it('hereda de cualquier cajero: el cajón es del equipo, no de la persona', async () => {
    const ajeno = await createLocal(prisma, { openedBy: 'otro-uid', openingAmount: 200 });
    await closeLocal(prisma, ajeno.id, { countedCashAmount: 640, closedBy: 'otro-uid' });

    expect((await getCashOnHand(prisma)).amount).toBe(640);
  });

  describe('movimientos de caja entre turnos', () => {
    async function cajaCerradaCon(monto) {
      const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: monto });
      await closeLocal(prisma, turno.id, { countedCashAmount: monto, closedBy: CAJERO });
      return turno;
    }

    /**
     * `createdAt` se calcula **relativo al reloj**, no a una fecha fija.
     *
     * Estaba clavado en `2026-09-06T09:00:00Z` como "después del cierre", y el
     * cierre se sella con `now()`: el día que el reloj real pasó esa fecha, el
     * movimiento quedó ANTES del cierre y las tres pruebas se cayeron sin que
     * nadie tocara el código. Una prueba que depende de qué día se corre no
     * prueba nada el resto del año.
     */
    const DESPUES_DEL_CIERRE = () => new Date(Date.now() + 60_000);
    const ANTES_DEL_CIERRE = () => new Date(Date.now() - 60_000);

    async function movimientoSuelto(type, amount, createdAt = DESPUES_DEL_CIERRE()) {
      const creado = await cashMovements.addMovement(prisma, null, {
        type,
        amount,
        reason: 'Caja de la farmacia',
        createdBy: 'uid-admin',
      });
      prisma.cashMovement.rows.find((row) => row.id === creado.id).createdAt = createdAt;
      return creado;
    }

    it('meter efectivo con la caja cerrada sube el fondo del día siguiente', async () => {
      await cajaCerradaCon(500);
      await movimientoSuelto('deposit', 200);

      expect((await getCashOnHand(prisma)).amount).toBe(700);
    });

    it('sacar efectivo con la caja cerrada lo baja', async () => {
      await cajaCerradaCon(500);
      await movimientoSuelto('withdrawal', 300);

      expect((await getCashOnHand(prisma)).amount).toBe(200);
    });

    it('ignora los movimientos ANTERIORES al cierre: ya están en lo contado', async () => {
      await movimientoSuelto('deposit', 999, ANTES_DEL_CIERRE());
      await cajaCerradaCon(500);

      expect((await getCashOnHand(prisma)).amount).toBe(500);
    });

    it('ignora los movimientos que sí pertenecen a un turno: ya bajaron su efectivo esperado', async () => {
      const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
      await cashMovements.addMovement(prisma, turno.id, {
        type: 'expense', amount: 100, reason: 'Comida', category: 'food', createdBy: CAJERO,
      });
      // Esperado 400 y se contó 400: el gasto ya está descontado ahí.
      await closeLocal(prisma, turno.id, { countedCashAmount: 400, closedBy: CAJERO });

      expect((await getCashOnHand(prisma)).amount).toBe(400);
    });

    it('suma y resta varios movimientos, redondeando a centavos', async () => {
      await cajaCerradaCon(100.1);
      await movimientoSuelto('deposit', 0.2);
      await movimientoSuelto('withdrawal', 0.1);

      expect((await getCashOnHand(prisma)).amount).toBe(100.2);
    });
  });
});

/**
 * Bloque de servicios: se reporta aparte pero sale de los campos
 * DENORMALIZADOS de la venta, nunca de sus partidas — igual que el cálculo
 * autoritativo del backend, que solo proyecta la venta.
 */
describe('bloque independiente de servicios', () => {
  async function turno(openingAmount = 500) {
    return createLocal(prisma, { openedBy: CAJERO, openingAmount });
  }

  async function ventaMixta(sessionId, overrides = {}) {
    return prisma.sale.create({
      data: {
        cashSessionId: sessionId,
        paymentMethod: 'cash',
        total: 300,
        cashAmount: 300,
        // Servicios primero: la consulta de 200 se cubre antes.
        servicesTotal: 200,
        servicesCashAmount: 200,
        pharmacyCashAmount: 100,
        commissionTotal: 80,
        ...overrides,
      },
    });
  }

  it('un turno sin servicios no trae el bloque: nada nuevo que leer', async () => {
    const t = await turno();
    await prisma.sale.create({
      data: { cashSessionId: t.id, paymentMethod: 'cash', total: 100, cashAmount: 100 },
    });

    const { summary, expectedServicesCashAmount } = await getLiveSummary(prisma, t.id);
    expect(summary.services).toBeUndefined();
    expect(expectedServicesCashAmount).toBe(0);
  });

  it('separa el efectivo de cada bloque sin perder un peso', async () => {
    const t = await turno(500);
    await ventaMixta(t.id);

    const { expectedCashAmount, expectedServicesCashAmount, summary } = await getLiveSummary(prisma, t.id);

    // 500 de fondo + 100 de la parte de farmacia.
    expect(expectedCashAmount).toBe(600);
    expect(expectedServicesCashAmount).toBe(200);
    // El total que el cajero encontrará en el cajón (uno solo): 500 de fondo
    // más los 300 que entraron en efectivo, repartidos entre los dos bloques.
    expect(expectedCashAmount + expectedServicesCashAmount).toBe(800);
    expect(summary.services).toMatchObject({ count: 1, total: 200, commissionTotal: 80 });
  });

  it('el fondo inicial es de farmacia: servicios abre en cero', async () => {
    const t = await turno(1000);
    const { expectedServicesCashAmount } = await getLiveSummary(prisma, t.id);
    expect(expectedServicesCashAmount).toBe(0);
  });

  it('una venta con servicios anulada no infla el bloque ni el efectivo esperado', async () => {
    const t = await turno(500);
    await ventaMixta(t.id, { voidedAt: new Date() });

    const { expectedCashAmount, expectedServicesCashAmount, summary } = await getLiveSummary(prisma, t.id);

    expect(expectedCashAmount).toBe(500);
    expect(expectedServicesCashAmount).toBe(0);
    expect(summary.services).toMatchObject({ count: 0, voidedCount: 1, total: 0, commissionTotal: 0 });
  });

  it('una venta con tarjeta suma al bloque pero no al efectivo', async () => {
    const t = await turno(500);
    await ventaMixta(t.id, { paymentMethod: 'card', cashAmount: null, servicesCashAmount: 0, pharmacyCashAmount: 0 });

    const { expectedServicesCashAmount, summary } = await getLiveSummary(prisma, t.id);
    expect(expectedServicesCashAmount).toBe(0);
    expect(summary.services).toMatchObject({ count: 1, total: 200 });
    expect(summary.services.byMethod.card.total).toBe(200);
  });

  /**
   * No-regresión: una venta anterior a los servicios no trae los campos
   * denormalizados y tiene que comportarse como 100 % farmacia.
   */
  it('una venta histórica sin los campos nuevos cuenta toda a farmacia', async () => {
    const t = await turno(0);
    await prisma.sale.create({
      data: {
        cashSessionId: t.id,
        paymentMethod: 'cash',
        total: 250,
        amountReceived: 300,
        change: 50,
        // Sin servicesTotal, sin pharmacyCashAmount: como las ventas de ayer.
      },
    });

    const { expectedCashAmount, expectedServicesCashAmount, summary } = await getLiveSummary(prisma, t.id);

    expect(expectedCashAmount).toBe(250);
    expect(expectedServicesCashAmount).toBe(0);
    expect(summary.services).toBeUndefined();
  });

  it('el cierre mide la diferencia contra la SUMA de los dos esperados', async () => {
    const t = await turno(500);
    await ventaMixta(t.id);

    // Esperado total = 600 farmacia + 200 servicios.
    const cerrado = await closeLocal(prisma, t.id, { countedCashAmount: 800, closedBy: CAJERO });

    expect(cerrado.cashDifference).toBe(0);
    expect(cerrado.hasPendingAdjustment).toBe(false);
    expect(cerrado.expectedServicesCashAmount).toBe(200);
  });

  it('contar solo el efectivo de farmacia deja el faltante de servicios a la vista', async () => {
    const t = await turno(500);
    await ventaMixta(t.id);

    const cerrado = await closeLocal(prisma, t.id, { countedCashAmount: 600, closedBy: CAJERO });

    expect(cerrado.cashDifference).toBe(-200);
    expect(cerrado.adjustmentStatus).toBe('pending');
  });
});

describe('regresiones vistas en caja', () => {
  it('no deja abrir dos turnos a la vez en el mismo equipo', async () => {
    await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });

    await expect(createLocal(prisma, { openedBy: CAJERO, openingAmount: 300 })).rejects.toThrow(
      /ya tienes un turno de caja abierto/i,
    );
    expect(prisma.cashSession.rows).toHaveLength(1);
  });

  it('otro cajero sí puede abrir su turno en el mismo equipo', async () => {
    await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await expect(createLocal(prisma, { openedBy: 'otro-uid', openingAmount: 300 })).resolves.toBeDefined();
  });

  it('cerrado el turno, el cajero puede abrir uno nuevo', async () => {
    const primero = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await closeLocal(prisma, primero.id, { countedCashAmount: 500, closedBy: CAJERO });

    await expect(createLocal(prisma, { openedBy: CAJERO, openingAmount: 300 })).resolves.toBeDefined();
  });

  /**
   * P2002 real de producción: `GET /cash-sessions/current` devolvía el turno
   * de ayer (su cierre no había subido) y el turno de hoy intentaba adoptar
   * ese mismo `remoteId`, que es único.
   */
  it('si el dueño del remoteId ya cerró en local, reencola ese cierre y deja el alta en cola', async () => {
    const ayer = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await markCreateSynced(prisma, ayer.id, 'remote-1');
    await closeLocal(prisma, ayer.id, { countedCashAmount: 500, closedBy: CAJERO });
    // Simula el estado atascado: el cierre local se dio por subido pero el
    // servidor sigue con ese turno como `current`.
    await prisma.cashSession.update({
      where: { id: ayer.id },
      data: { pendingClosePush: false },
    });
    const hoy = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 400 });

    const resultado = await markCreateSynced(prisma, hoy.id, 'remote-1');

    expect(resultado).toEqual({ conflict: true, requeuedClose: true });
    const filaHoy = prisma.cashSession.rows.find((row) => row.id === hoy.id);
    expect(filaHoy.remoteId).toBeNull();
    expect(filaHoy.pushError).toBeNull();
    expect(filaHoy.pendingPush).toBe(true);
    const filaAyer = prisma.cashSession.rows.find((row) => row.id === ayer.id);
    expect(filaAyer.remoteId).toBe('remote-1');
    expect(filaAyer.pendingClosePush).toBe(true);
  });

  it('si el dueño del remoteId sigue abierto en local, marca conflicto y saca el alta de la cola', async () => {
    const abierto = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await markCreateSynced(prisma, abierto.id, 'remote-1');
    const otro = await createLocal(prisma, { openedBy: 'uid-otro', openingAmount: 400 });

    const resultado = await markCreateSynced(prisma, otro.id, 'remote-1');

    expect(resultado).toEqual({ conflict: true });
    const filaOtro = prisma.cashSession.rows.find((row) => row.id === otro.id);
    expect(filaOtro.remoteId).toBeNull();
    expect(filaOtro.pushError).toMatch(/ya pertenece a otro turno/i);
    expect((await getPendingPush(prisma)).map((row) => row.id)).not.toContain(otro.id);
  });

  it('healRemoteOpenConflicts reencola el cierre y destraba el alta bloqueada', async () => {
    const ayer = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await markCreateSynced(prisma, ayer.id, 'remote-1');
    await closeLocal(prisma, ayer.id, { countedCashAmount: 500, closedBy: CAJERO });
    await prisma.cashSession.update({
      where: { id: ayer.id },
      data: { pendingClosePush: false },
    });
    const hoy = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 400 });
    await prisma.cashSession.update({
      where: { id: hoy.id },
      data: {
        pushError:
          'El turno remoto remote-1 ya pertenece a otro turno de este equipo. ' +
          'Sincroniza el cierre del turno anterior antes de subir este.',
      },
    });

    expect((await getPendingClosePush(prisma)).map((row) => row.id)).toContain(ayer.id);
    expect((await getPendingPush(prisma)).map((row) => row.id)).toContain(hoy.id);
    expect(prisma.cashSession.rows.find((row) => row.id === hoy.id).pushError).toBeNull();
  });

  it('reintentar el mismo remoteId sobre su propio turno es idempotente, no conflicto', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await markCreateSynced(prisma, turno.id, 'remote-1');

    const resultado = await markCreateSynced(prisma, turno.id, 'remote-1');

    expect(resultado).toEqual({ conflict: false });
    expect(prisma.cashSession.rows[0].remoteId).toBe('remote-1');
  });
});

describe('estado del ajuste (pull desde el backend)', () => {
  it('refleja la aprobación de un administrador y deja de contarlo como pendiente', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await closeLocal(prisma, turno.id, { countedCashAmount: 400, closedBy: CAJERO });

    await updateAdjustmentStatus(prisma, turno.id, {
      status: 'approved',
      reviewedBy: 'uid-admin',
      reviewedAt: '2026-09-06T10:00:00.000Z',
      note: 'Faltante autorizado',
    });

    const [reflejado] = await listLocal(prisma, {});
    expect(reflejado.adjustmentStatus).toBe('approved');
    expect(reflejado.hasPendingAdjustment).toBe(false);
    expect(reflejado.adjustmentReviewedBy).toBe('uid-admin');
    expect(reflejado.adjustmentNote).toBe('Faltante autorizado');
    expect(await listLocal(prisma, { adjustmentStatus: 'pending' })).toHaveLength(0);
  });

  it('un rechazo también cierra el pendiente', async () => {
    const turno = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await closeLocal(prisma, turno.id, { countedCashAmount: 400, closedBy: CAJERO });
    await updateAdjustmentStatus(prisma, turno.id, { status: 'rejected', reviewedBy: 'uid-admin' });

    const [reflejado] = await listLocal(prisma, {});
    expect(reflejado.adjustmentStatus).toBe('rejected');
    expect(reflejado.hasPendingAdjustment).toBe(false);
  });

  it('listLocal filtra por cajero y por estado del ajuste', async () => {
    const mio = await createLocal(prisma, { openedBy: CAJERO, openingAmount: 100 });
    await closeLocal(prisma, mio.id, { countedCashAmount: 50, closedBy: CAJERO });
    const ajeno = await createLocal(prisma, { openedBy: 'otro-uid', openingAmount: 100 });
    await closeLocal(prisma, ajeno.id, { countedCashAmount: 100, closedBy: 'otro-uid' });

    expect(await listLocal(prisma, { openedBy: CAJERO })).toHaveLength(1);
    const pendientes = await listLocal(prisma, { adjustmentStatus: 'pending' });
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].id).toBe(mio.id);
  });
});
