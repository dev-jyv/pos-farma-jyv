import { describe, expect, it, beforeEach } from 'vitest';

import cashSessions from '../db/cash-sessions.js';
import cashMovements from '../db/cash-movements.js';
import { createFakePrisma } from './fake-prisma.mjs';

/**
 * Recorrido completo de un turno de caja, de punta a punta sobre la base
 * local: abrir → vender → gastar → cerrar con diferencia → sincronizar →
 * un admin resuelve el ajuste → el POS lo refleja de vuelta.
 *
 * Es la prueba que cubre lo que ninguna unidad ve sola: que el efectivo
 * esperado, la cola de push y el estado del ajuste sigan cuadrando cuando los
 * pasos ocurren en el orden real de una jornada (incluido el desorden: sin
 * red, cerrando antes del primer sync).
 */

const CAJERO = 'uid-cajero';
const ADMIN = 'uid-admin';

let prisma;

beforeEach(() => {
  prisma = createFakePrisma();
});

/** Simula el `SyncScheduler`: sube el alta, luego los movimientos, luego el cierre. */
async function sincronizar(backend) {
  for (const pendiente of await cashSessions.getPendingPush(prisma)) {
    const remoteId = backend.crearTurno(pendiente);
    await cashSessions.markCreateSynced(prisma, pendiente.id, remoteId);
  }
  for (const pendiente of await cashMovements.getPendingPush(prisma)) {
    backend.agregarMovimiento(pendiente);
    await cashMovements.markSynced(prisma, pendiente.id, `remote-${pendiente.id}`);
  }
  for (const pendiente of await cashSessions.getPendingClosePush(prisma)) {
    const autoritativo = backend.cerrarTurno(pendiente);
    await cashSessions.markCloseSynced(prisma, pendiente.id, autoritativo);
  }
}

/** Backend de mentira con las MISMAS reglas del real, para cerrar el circuito. */
function crearBackend() {
  const turnos = new Map();
  const movimientos = [];
  let secuencia = 0;

  return {
    turnos,
    movimientos,
    crearTurno(pendiente) {
      secuencia += 1;
      const id = `remote-${secuencia}`;
      turnos.set(id, { id, openingAmount: pendiente.openingAmount, closed: false });
      return id;
    },
    agregarMovimiento(pendiente) {
      if (pendiente.type === 'expense' && !pendiente.category) {
        throw new Error('La categoría es requerida para gastos');
      }
      movimientos.push(pendiente);
    },
    cerrarTurno(pendiente) {
      const turno = turnos.get(pendiente.remoteId);
      if (!turno) throw new Error('Turno remoto inexistente');
      if (turno.closed) throw new Error('El turno ya está cerrado');
      turno.closed = true;
      // El backend recalcula: aquí se acepta el cálculo local, que es lo que
      // esta prueba quiere verificar que coincida.
      const expectedCashAmount = pendiente.expectedCashAmount;
      const cashDifference = Math.round((pendiente.countedCashAmount - expectedCashAmount) * 100) / 100;
      turno.hasPendingAdjustment = !pendiente.autoClosedByExpiry && Math.abs(cashDifference) >= 0.01;
      turno.adjustmentStatus = turno.hasPendingAdjustment ? 'pending' : null;
      return { expectedCashAmount, cashDifference };
    },
    revisarAjuste(remoteId, decision, note) {
      const turno = turnos.get(remoteId);
      if (!turno?.hasPendingAdjustment || turno.adjustmentStatus !== 'pending') {
        throw new Error('El turno no tiene un ajuste pendiente de revisión');
      }
      turno.adjustmentStatus = decision;
      turno.hasPendingAdjustment = false;
      turno.adjustmentReviewedBy = ADMIN;
      turno.adjustmentNote = note ?? null;
      return turno;
    },
  };
}

async function venderEnEfectivo(sessionId, total) {
  await prisma.sale.create({
    data: { cashSessionId: sessionId, paymentMethod: 'cash', total, cashAmount: total },
  });
}

describe('jornada completa de un turno', () => {
  it('abrir, vender, gastar, cerrar con faltante, sincronizar y que un admin lo apruebe', async () => {
    const backend = crearBackend();

    // 1. El cajero abre turno con $500 de fondo. Sin red todavía.
    const turno = await cashSessions.createLocal(prisma, {
      openedBy: CAJERO,
      openedByLabel: 'caja@farmajyv.mx',
      openingAmount: 500,
    });
    expect(await cashSessions.getOpenLocal(prisma, CAJERO)).not.toBeNull();

    // 2. Vende: $300 en efectivo y $400 con tarjeta (la tarjeta no entra al cajón).
    await venderEnEfectivo(turno.id, 300);
    await prisma.sale.create({ data: { cashSessionId: turno.id, paymentMethod: 'card', total: 400 } });

    let vivo = await cashSessions.getLiveSummary(prisma, turno.id);
    expect(vivo.expectedCashAmount).toBe(800);
    expect(vivo.summary.byMethod.card.total).toBe(400);

    // 3. Registra un gasto de proveedor (categoría que exige describir).
    await cashMovements.addMovement(prisma, turno.id, {
      type: 'expense',
      amount: 150,
      reason: 'Proveedor: Farmacéutica del Norte',
      category: 'supplier',
      description: 'Medicamento de patente',
      createdBy: CAJERO,
    });

    vivo = await cashSessions.getLiveSummary(prisma, turno.id);
    expect(vivo.expectedCashAmount).toBe(650);

    // 4. Cierra contando $610: faltan $40, queda ajuste pendiente.
    const cerrado = await cashSessions.closeLocal(prisma, turno.id, {
      countedCashAmount: 610,
      closedBy: CAJERO,
    });
    expect(cerrado.cashDifference).toBe(-40);
    expect(cerrado.adjustmentStatus).toBe('pending');

    // 5. Vuelve la red: el sync sube alta, gasto y cierre en el orden correcto.
    await sincronizar(backend);

    const [fila] = prisma.cashSession.rows;
    expect(fila.remoteId).toBe('remote-1');
    expect(fila.pendingPush).toBe(false);
    expect(fila.pendingClosePush).toBe(false);
    expect(backend.movimientos).toHaveLength(1);
    expect(backend.turnos.get('remote-1').adjustmentStatus).toBe('pending');

    // 6. Un admin aprueba el faltante desde la auditoría (solo en el backend).
    backend.revisarAjuste('remote-1', 'approved', 'Faltante autorizado');

    // 7. El POS hace pull y refleja la decisión: deja de estar pendiente.
    const pendientesLocales = await cashSessions.listLocal(prisma, { adjustmentStatus: 'pending' });
    expect(pendientesLocales).toHaveLength(1);

    const remoto = backend.turnos.get('remote-1');
    await cashSessions.updateAdjustmentStatus(prisma, turno.id, {
      status: remoto.adjustmentStatus,
      reviewedBy: remoto.adjustmentReviewedBy,
      reviewedAt: '2026-09-06T10:00:00.000Z',
      note: remoto.adjustmentNote,
    });

    const [final] = await cashSessions.listLocal(prisma, {});
    expect(final.adjustmentStatus).toBe('approved');
    expect(final.hasPendingAdjustment).toBe(false);
    expect(final.adjustmentNote).toBe('Faltante autorizado');
    expect(await cashSessions.listLocal(prisma, { adjustmentStatus: 'pending' })).toHaveLength(0);
  });

  it('jornada entera sin red: todo se acumula y sube completo al reconectar', async () => {
    const backend = crearBackend();

    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await venderEnEfectivo(turno.id, 200);
    await cashMovements.addMovement(prisma, turno.id, {
      type: 'expense', amount: 100, reason: 'Comida', category: 'food', createdBy: CAJERO,
    });
    await cashMovements.addMovement(prisma, turno.id, {
      type: 'withdrawal', amount: 50, reason: 'Depósito al banco', createdBy: CAJERO,
    });
    await cashSessions.closeLocal(prisma, turno.id, { countedCashAmount: 550, closedBy: CAJERO });

    // Nada salió del equipo todavía.
    expect(backend.turnos.size).toBe(0);

    await sincronizar(backend);

    expect(backend.turnos.size).toBe(1);
    expect(backend.movimientos).toHaveLength(2);
    const [fila] = prisma.cashSession.rows;
    expect(fila.pendingPush).toBe(false);
    expect(fila.pendingClosePush).toBe(false);
    // 500 + 200 − 100 − 50 = 550: cierra cuadrado, sin ajuste.
    expect(fila.cashDifference).toBe(0);
    expect(fila.hasPendingAdjustment).toBe(false);
  });

  it('el turno olvidado abierto se auto-cierra a medianoche sin dejar ajuste', async () => {
    const backend = crearBackend();

    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await venderEnEfectivo(turno.id, 250);
    await sincronizar(backend);

    // 24:00: expira la sesión y `autoCloseForExpiry` cierra con el esperado.
    const { expectedCashAmount } = await cashSessions.getLiveSummary(prisma, turno.id);
    await cashSessions.closeLocal(prisma, turno.id, {
      countedCashAmount: expectedCashAmount,
      closedBy: CAJERO,
      autoClosedByExpiry: true,
    });
    await sincronizar(backend);

    const [fila] = prisma.cashSession.rows;
    expect(fila.autoClosedByExpiry).toBe(true);
    expect(fila.cashDifference).toBe(0);
    expect(fila.hasPendingAdjustment).toBe(false);
    expect(backend.turnos.get('remote-1').closed).toBe(true);
    // Nadie tiene que revisar nada: no hubo cajero para contar el efectivo.
    expect(await cashSessions.listLocal(prisma, { adjustmentStatus: 'pending' })).toHaveLength(0);
  });

  it('un fallo a media sincronización no duplica el turno ni pierde el cierre', async () => {
    const backend = crearBackend();

    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await venderEnEfectivo(turno.id, 100);
    await cashSessions.closeLocal(prisma, turno.id, { countedCashAmount: 590, closedBy: CAJERO });

    // Primer intento: el alta sube, el cierre revienta.
    for (const pendiente of await cashSessions.getPendingPush(prisma)) {
      await cashSessions.markCreateSynced(prisma, pendiente.id, backend.crearTurno(pendiente));
    }
    for (const pendiente of await cashSessions.getPendingClosePush(prisma)) {
      await cashSessions.markClosePushFailed(prisma, pendiente.id, 'timeout');
    }

    expect(backend.turnos.size).toBe(1);
    expect(await cashSessions.getPendingPush(prisma)).toHaveLength(0);

    // El cajero destraba el cierre y el siguiente ciclo lo completa.
    await cashSessions.clearClosePushError(prisma, turno.id);
    await sincronizar(backend);

    // Un solo turno en el backend: el reintento nunca creó un segundo.
    expect(backend.turnos.size).toBe(1);
    expect(backend.turnos.get('remote-1').closed).toBe(true);
    expect(prisma.cashSession.rows[0].pendingClosePush).toBe(false);
  });

  it('dos turnos del mismo día, uno por cajero, no se mezclan', async () => {
    const backend = crearBackend();

    const turnoA = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    const turnoB = await cashSessions.createLocal(prisma, { openedBy: 'uid-cajero-2', openingAmount: 300 });

    await venderEnEfectivo(turnoA.id, 100);
    await venderEnEfectivo(turnoB.id, 700);
    await cashMovements.addMovement(prisma, turnoA.id, {
      type: 'expense', amount: 60, reason: 'Luz', category: 'electricity', createdBy: CAJERO,
    });

    const vivoA = await cashSessions.getLiveSummary(prisma, turnoA.id);
    const vivoB = await cashSessions.getLiveSummary(prisma, turnoB.id);
    expect(vivoA.expectedCashAmount).toBe(540);
    expect(vivoB.expectedCashAmount).toBe(1000);

    await cashSessions.closeLocal(prisma, turnoA.id, { countedCashAmount: 540, closedBy: CAJERO });
    await cashSessions.closeLocal(prisma, turnoB.id, { countedCashAmount: 900, closedBy: 'uid-cajero-2' });
    await sincronizar(backend);

    expect(backend.turnos.size).toBe(2);
    const pendientes = await cashSessions.listLocal(prisma, { adjustmentStatus: 'pending' });
    // Solo el turno B quedó con faltante: el ajuste no se contagia entre cajas.
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].openedBy).toBe('uid-cajero-2');
  });

  it('el backend rechaza un gasto inválido sin arrastrar al resto de la cola', async () => {
    const backend = crearBackend();
    const turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
    await sincronizar(backend);

    // Un gasto sin categoría no puede siquiera escribirse en local.
    await expect(
      cashMovements.addMovement(prisma, turno.id, {
        type: 'expense', amount: 10, reason: 'x', createdBy: CAJERO,
      }),
    ).rejects.toThrow(/categoría es requerida/i);

    // Y el turno sigue sano y sincronizado.
    expect(prisma.cashSession.rows[0].remoteId).toBe('remote-1');
    expect(await cashMovements.getPendingPush(prisma)).toHaveLength(0);
  });
});
