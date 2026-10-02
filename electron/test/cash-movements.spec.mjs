import { describe, expect, it, beforeEach } from 'vitest';

import cashMovements from '../db/cash-movements.js';
import cashSessions from '../db/cash-sessions.js';
import { createFakePrisma } from './fake-prisma.mjs';

const {
  addMovement,
  listForSession,
  listAllLocal,
  getPendingPush,
  assertPushable,
  listBlocked,
  discard,
  updateExpense,
  markSynced,
  markPushFailed,
  clearPushError,
} = cashMovements;

const CAJERO = 'uid-cajero';
const SIN_DESCRIPCION = ['salary', 'food', 'rent', 'contingency', 'electricity'];
const CON_DESCRIPCION = ['supplies', 'supplier', 'other'];

let prisma;
let turno;

beforeEach(async () => {
  prisma = createFakePrisma();
  turno = await cashSessions.createLocal(prisma, { openedBy: CAJERO, openingAmount: 500 });
});

function gasto(overrides = {}) {
  return {
    type: 'expense',
    amount: 100,
    reason: 'Comida',
    category: 'food',
    createdBy: CAJERO,
    ...overrides,
  };
}

describe('validación de gastos (espejo de createCashMovementSchema del backend)', () => {
  it('rechaza un gasto sin categoría', async () => {
    await expect(addMovement(prisma, turno.id, gasto({ category: undefined }))).rejects.toThrow(
      /categoría es requerida/i,
    );
    expect(prisma.cashMovement.rows).toHaveLength(0);
  });

  it.each(CON_DESCRIPCION)('exige descripción en la categoría "%s"', async (category) => {
    await expect(
      addMovement(prisma, turno.id, gasto({ category, description: undefined })),
    ).rejects.toThrow(/descripción es requerida/i);
  });

  it.each(CON_DESCRIPCION)('una descripción en blanco no cuenta como descripción ("%s")', async (category) => {
    await expect(
      addMovement(prisma, turno.id, gasto({ category, description: '    ' })),
    ).rejects.toThrow(/descripción es requerida/i);
  });

  it.each(CON_DESCRIPCION)('acepta "%s" cuando sí se describe en qué se gastó', async (category) => {
    const creado = await addMovement(prisma, turno.id, gasto({ category, description: ' Cajas de guantes ' }));
    expect(creado.category).toBe(category);
    // La descripción se normaliza al guardar: sin espacios de sobra.
    expect(creado.description).toBe('Cajas de guantes');
  });

  it.each(SIN_DESCRIPCION)('la categoría "%s" no exige descripción', async (category) => {
    const creado = await addMovement(prisma, turno.id, gasto({ category }));
    expect(creado.category).toBe(category);
    expect(creado.description).toBeNull();
  });

  it('depósito y retiro no exigen categoría', async () => {
    await expect(
      addMovement(prisma, turno.id, { type: 'deposit', amount: 50, reason: 'Fondo extra', createdBy: CAJERO }),
    ).resolves.toMatchObject({ type: 'deposit', category: null });
    await expect(
      addMovement(prisma, turno.id, { type: 'withdrawal', amount: 50, reason: 'Depósito banco', createdBy: CAJERO }),
    ).resolves.toMatchObject({ type: 'withdrawal' });
  });

  it('el gasto nace pendiente de subir y atado a su turno', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    expect(creado.cashSessionId).toBe(turno.id);
    expect(creado.pendingPush).toBe(true);
    expect(creado.remoteId).toBeNull();
  });
});

describe('consulta de movimientos', () => {
  it('listForSession solo devuelve los del turno pedido', async () => {
    const otroTurno = await cashSessions.createLocal(prisma, { openedBy: 'otro-uid', openingAmount: 100 });
    await addMovement(prisma, turno.id, gasto());
    await addMovement(prisma, otroTurno.id, gasto({ amount: 999 }));

    const delTurno = await listForSession(prisma, turno.id);
    expect(delTurno).toHaveLength(1);
    expect(delTurno[0].amount).toBe(100);
  });

  it('listAllLocal filtra por tipo — la auditoría de gastos nunca ve depósitos ni retiros', async () => {
    await addMovement(prisma, turno.id, gasto());
    await addMovement(prisma, turno.id, { type: 'deposit', amount: 20, reason: 'Fondo', createdBy: CAJERO });
    await addMovement(prisma, turno.id, { type: 'withdrawal', amount: 30, reason: 'Banco', createdBy: CAJERO });

    const soloGastos = await listAllLocal(prisma, { type: 'expense' });
    expect(soloGastos).toHaveLength(1);
    expect(soloGastos[0].type).toBe('expense');
  });

  it('listAllLocal filtra por categoría', async () => {
    await addMovement(prisma, turno.id, gasto({ category: 'rent' }));
    await addMovement(prisma, turno.id, gasto({ category: 'food' }));

    const renta = await listAllLocal(prisma, { type: 'expense', category: 'rent' });
    expect(renta).toHaveLength(1);
    expect(renta[0].category).toBe('rent');
  });
});

describe('cola de push de movimientos', () => {
  it('no intenta subir un movimiento cuyo turno padre aún no tiene remoteId', async () => {
    await addMovement(prisma, turno.id, gasto());
    expect(await getPendingPush(prisma)).toHaveLength(0);
  });

  it('lo encola en cuanto el turno padre sincroniza, con el remoteId del turno a mano', async () => {
    await addMovement(prisma, turno.id, gasto());
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');

    const pendientes = await getPendingPush(prisma);
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].cashSessionRemoteId).toBe('remote-turno-1');
  });

  it('deja de reintentarlo una vez subido', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    await markSynced(prisma, creado.id, 'remote-mov-1');

    expect(await getPendingPush(prisma)).toHaveLength(0);
    expect(prisma.cashMovement.rows[0].remoteId).toBe('remote-mov-1');
  });

  it('un rechazo permanente lo saca de la cola hasta limpiarlo a mano', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    await markPushFailed(prisma, creado.id, 'categoría inválida');
    expect(await getPendingPush(prisma)).toHaveLength(0);

    await clearPushError(prisma, creado.id);
    expect(await getPendingPush(prisma)).toHaveLength(1);
  });
});

/**
 * **Ninguna petición de movimiento después del cierre.**
 *
 * Un movimiento de un turno que ya cerró en el servidor no puede subir: el
 * backend responde 400 "el turno de caja ya está cerrado". Mandarlo igual es la
 * petición en rojo que aparecía justo después del `close`.
 */
describe('movimientos de un turno ya cerrado en el servidor', () => {
  /** Deja el turno cerrado **y con su cierre ya subido**. */
  async function cerrarYSincronizar() {
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    await cashSessions.closeLocal(prisma, turno.id, { countedCashAmount: 0, closedBy: CAJERO });
    await cashSessions.markCloseSynced(prisma, turno.id, {});
  }

  it('no se entrega en la cola: la petición no llega a salir', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    await cerrarYSincronizar();

    expect(await getPendingPush(prisma)).toHaveLength(0);
    expect(creado.id).toBeTruthy();
  });

  it('queda bloqueado con el motivo, no desaparece', async () => {
    // Sacarlo de la cola sin más escondería dinero: el contador de pendientes
    // diría 0 con un gasto real sin registrar en el servidor.
    const creado = await addMovement(prisma, turno.id, gasto());
    await cerrarYSincronizar();
    await getPendingPush(prisma);

    const bloqueados = await listBlocked(prisma);
    expect(bloqueados.map((item) => item.id)).toContain(creado.id);
    expect(prisma.cashMovement.rows[0].pushError).toMatch(/turno ya se cerró en el servidor/i);
  });

  /**
   * El caso que NO hay que bloquear: el turno se cerró en la caja pero su
   * cierre sigue en cola, así que el movimiento todavía llega a tiempo. De que
   * suba antes se encarga el orden de `SyncScheduler`.
   */
  it('un turno cerrado cuyo cierre AÚN no sube conserva sus movimientos en cola', async () => {
    await addMovement(prisma, turno.id, gasto());
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    await cashSessions.closeLocal(prisma, turno.id, { countedCashAmount: 0, closedBy: CAJERO });

    expect(await getPendingPush(prisma)).toHaveLength(1);
  });

  /**
   * Cerrojo del **momento del envío**, el que se consulta justo antes del POST.
   * El filtro de la cola mira el estado cuando se lee; entre esa lectura y el
   * envío de cada movimiento cabe un cierre, y esto corta esa ventana.
   */
  describe('assertPushable', () => {
    it('deniega y bloquea cuando el turno ya cerró en el servidor', async () => {
      const creado = await addMovement(prisma, turno.id, gasto());
      await cerrarYSincronizar();

      expect(await assertPushable(prisma, creado.id)).toBe(false);
      expect(prisma.cashMovement.rows[0].pushError).toMatch(/turno ya se cerró en el servidor/i);
    });

    it('permite si el cierre todavía está en cola: el movimiento llega a tiempo', async () => {
      const creado = await addMovement(prisma, turno.id, gasto());
      await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
      await cashSessions.closeLocal(prisma, turno.id, { countedCashAmount: 0, closedBy: CAJERO });

      expect(await assertPushable(prisma, creado.id)).toBe(true);
      expect(prisma.cashMovement.rows[0].pushError).toBeNull();
    });

    it('permite con el turno abierto', async () => {
      const creado = await addMovement(prisma, turno.id, gasto());
      await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');

      expect(await assertPushable(prisma, creado.id)).toBe(true);
    });

    it('permite el de la caja de la farmacia: no cuelga de ningún turno', async () => {
      const creado = await addMovement(prisma, null, {
        type: 'withdrawal', amount: 50, reason: 'Banco', createdBy: CAJERO,
      });
      await cerrarYSincronizar();

      expect(await assertPushable(prisma, creado.id)).toBe(true);
    });

    it('un movimiento que ya no existe no bloquea el ciclo', async () => {
      expect(await assertPushable(prisma, 'no-existe')).toBe(true);
    });
  });

  it('un turno abierto conserva sus movimientos en cola', async () => {
    await addMovement(prisma, turno.id, gasto());
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');

    expect(await getPendingPush(prisma)).toHaveLength(1);
  });

  it('no toca los de la caja de la farmacia, que no cuelgan de ningún turno', async () => {
    await addMovement(prisma, null, { type: 'withdrawal', amount: 50, reason: 'Banco', createdBy: CAJERO });
    await cerrarYSincronizar();

    expect(await getPendingPush(prisma)).toHaveLength(1);
  });
});

/**
 * Caja de la farmacia: el admin mueve efectivo sin turno abierto. El
 * movimiento se guarda igual, pero con `cashSessionId` en `null`.
 */
describe('movimientos sin turno', () => {
  const retiro = { type: 'withdrawal', amount: 200, reason: 'Depósito bancario', createdBy: CAJERO };

  it('acepta una entrada o salida sin turno', async () => {
    const creado = await addMovement(prisma, null, retiro);
    expect(creado.cashSessionId).toBeNull();
    expect(creado.pendingPush).toBe(true);
  });

  /**
   * Un gasto sin turno no tendría corte donde aparecer en su desglose, así que
   * seguiría exigiendo turno aunque el resto ya no.
   */
  it('un gasto sigue exigiendo turno', async () => {
    await expect(
      addMovement(prisma, null, { type: 'expense', amount: 50, reason: 'Comida', category: 'food', createdBy: CAJERO }),
    ).rejects.toThrow(/turno abierto/i);
  });

  it('sube de inmediato: no espera a que ningún turno sincronice', async () => {
    await addMovement(prisma, null, retiro);

    const pendientes = await getPendingPush(prisma);
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].cashSessionRemoteId).toBeNull();
  });

  it('no entra al corte de un turno abierto', async () => {
    await addMovement(prisma, null, retiro);

    const { expectedCashAmount } = await cashSessions.getLiveSummary(prisma, turno.id);
    expect(expectedCashAmount).toBe(500);
  });

  it('atado a un turno abierto sí baja su efectivo esperado', async () => {
    await addMovement(prisma, turno.id, retiro);

    const { expectedCashAmount } = await cashSessions.getLiveSummary(prisma, turno.id);
    expect(expectedCashAmount).toBe(300);
  });
});

describe('rechazados visibles', () => {
  it('listBlocked devuelve lo que el servidor rechazó, con su motivo', async () => {
    const ok = await addMovement(prisma, turno.id, gasto());
    const rechazado = await addMovement(prisma, turno.id, gasto({ amount: 300 }));
    await markPushFailed(prisma, rechazado.id, 'El turno de caja ya está cerrado');

    const bloqueados = await listBlocked(prisma);
    expect(bloqueados).toHaveLength(1);
    expect(bloqueados[0].id).toBe(rechazado.id);
    expect(bloqueados[0].kind).toBe('cashMovement');
    expect(bloqueados[0].reason).toBe('El turno de caja ya está cerrado');
    // El que va bien no aparece: el aviso es solo para lo que necesita decisión.
    expect(bloqueados.some((item) => item.id === ok.id)).toBe(false);
  });

  it('deja de listarlo en cuanto se limpia el error para reintentarlo', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    await markPushFailed(prisma, creado.id, 'Stock insuficiente');
    expect(await listBlocked(prisma)).toHaveLength(1);

    await clearPushError(prisma, creado.id);
    expect(await listBlocked(prisma)).toHaveLength(0);
  });
});

describe('descartar un rechazado', () => {
  it('lo borra y deja de restar del efectivo esperado', async () => {
    const creado = await addMovement(prisma, turno.id, gasto({ amount: 120 }));
    await markPushFailed(prisma, creado.id, 'El turno de caja ya está cerrado');
    expect((await cashSessions.getLiveSummary(prisma, turno.id)).expectedCashAmount).toBe(380);

    await discard(prisma, creado.id);

    expect(await listBlocked(prisma)).toHaveLength(0);
    // Vuelve a los 500 del fondo: el gasto ya no existe.
    expect((await cashSessions.getLiveSummary(prisma, turno.id)).expectedCashAmount).toBe(500);
  });

  it('no borra uno que ya existe en el servidor: quedaría vivo en la auditoría', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    await markSynced(prisma, creado.id, 'remote-mov-1');

    await expect(discard(prisma, creado.id)).rejects.toThrow(/ya existe en el servidor/i);
    expect(prisma.cashMovement.rows).toHaveLength(1);
  });
});

describe('corrección de un gasto', () => {
  it('cambia el monto y el corte lo refleja de inmediato', async () => {
    const creado = await addMovement(prisma, turno.id, gasto({ amount: 120 }));
    await updateExpense(prisma, creado.id, { amount: 200 });

    const { expectedCashAmount, summary } = await cashSessions.getLiveSummary(prisma, turno.id);
    // 500 de fondo − 200 corregidos (no los 120 originales).
    expect(expectedCashAmount).toBe(300);
    expect(summary.movements.expenses).toEqual({ count: 1, total: 200 });
  });

  it('vuelve a marcarlo pendiente de subir, para que la corrección llegue al servidor', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    await markSynced(prisma, creado.id, 'remote-mov-1');
    expect(await getPendingPush(prisma)).toHaveLength(0);

    await updateExpense(prisma, creado.id, { amount: 50 });

    const pendientes = await getPendingPush(prisma);
    expect(pendientes).toHaveLength(1);
    // Conserva el `remoteId`: el reenvío debe ser PATCH, no un alta duplicada.
    expect(pendientes[0].remoteId).toBe('remote-mov-1');
  });

  it('limpia el error de push: la causa pudo ser justo lo que se corrigió', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    await cashSessions.markCreateSynced(prisma, turno.id, 'remote-turno-1');
    await markPushFailed(prisma, creado.id, 'categoría inválida');
    expect(await getPendingPush(prisma)).toHaveLength(0);

    await updateExpense(prisma, creado.id, { category: 'rent' });
    expect(await getPendingPush(prisma)).toHaveLength(1);
  });

  it('valida contra la categoría resultante, no contra la anterior', async () => {
    const creado = await addMovement(prisma, turno.id, gasto({ category: 'food' }));
    // Pasar a "Insumos" sin describir dejaría un gasto que el alta habría rechazado.
    await expect(updateExpense(prisma, creado.id, { category: 'supplies' })).rejects.toThrow(
      /descripción es requerida/i,
    );
  });

  it('rechaza un monto que no sea positivo', async () => {
    const creado = await addMovement(prisma, turno.id, gasto());
    await expect(updateExpense(prisma, creado.id, { amount: 0 })).rejects.toThrow(/mayor a cero/i);
  });

  it('no corrige lo que no es un gasto', async () => {
    const deposito = await addMovement(prisma, turno.id, {
      type: 'deposit', amount: 50, reason: 'Fondo extra', createdBy: CAJERO,
    });
    await expect(updateExpense(prisma, deposito.id, { amount: 60 })).rejects.toThrow(
      /solo se pueden corregir gastos/i,
    );
  });
});

describe('efecto de los gastos sobre el corte', () => {
  it('cada gasto baja el efectivo esperado del turno', async () => {
    const antes = await cashSessions.getLiveSummary(prisma, turno.id);
    await addMovement(prisma, turno.id, gasto({ amount: 120 }));
    const despues = await cashSessions.getLiveSummary(prisma, turno.id);

    expect(antes.expectedCashAmount).toBe(500);
    expect(despues.expectedCashAmount).toBe(380);
    expect(despues.summary.movements.expenses).toEqual({ count: 1, total: 120 });
  });

  it('los gastos de OTRO turno no tocan este corte', async () => {
    const otroTurno = await cashSessions.createLocal(prisma, { openedBy: 'otro-uid', openingAmount: 100 });
    await addMovement(prisma, otroTurno.id, gasto({ amount: 999 }));

    const { expectedCashAmount } = await cashSessions.getLiveSummary(prisma, turno.id);
    expect(expectedCashAmount).toBe(500);
  });
});
