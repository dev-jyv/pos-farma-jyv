/** Categorías de gasto que exigen describir en qué se gastó (no basta el motivo corto). */
const CATEGORIES_REQUIRING_DESCRIPTION = new Set(['supplies', 'supplier', 'other']);

function toCashMovementDto(row) {
  return {
    id: row.id,
    remoteId: row.remoteId ?? null,
    cashSessionId: row.cashSessionId ?? null,
    type: row.type,
    amount: row.amount,
    reason: row.reason,
    category: row.category ?? null,
    description: row.description ?? null,
    createdBy: row.createdBy,
    createdByLabel: row.createdByLabel ?? null,
    createdAt: row.createdAt,
    pendingPush: row.pendingPush,
    pushError: row.pushError ?? null,
  };
}

/**
 * Depósito/retiro/gasto. Un "gasto" es esta misma función con
 * `type: 'expense'` — mismo criterio de validación que el backend
 * (`createCashMovementSchema` en `backend-farma-jyv`): la categoría es
 * obligatoria para gastos, y la descripción solo para Insumos/Proveedor/Otros.
 *
 * `cashSessionId` puede ir en `null`: es la caja de la farmacia, donde el admin
 * mete o saca efectivo sin turno abierto. Un gasto sí exige turno, porque su
 * desglose solo tiene sentido dentro de un corte.
 */
async function addMovement(prisma, cashSessionId, { type, amount, reason, category, description, createdBy, createdByLabel }) {
  if (type === 'expense' && !category) {
    throw new Error('La categoría es requerida para gastos');
  }
  if (type === 'expense' && !cashSessionId) {
    throw new Error('Los gastos requieren un turno abierto');
  }
  if (category && CATEGORIES_REQUIRING_DESCRIPTION.has(category) && !description?.trim()) {
    throw new Error('La descripción es requerida para esta categoría');
  }
  const created = await prisma.cashMovement.create({
    data: {
      cashSessionId: cashSessionId ?? null,
      type,
      amount,
      reason,
      category: category ?? null,
      description: description?.trim() || null,
      createdBy,
      createdByLabel: createdByLabel ?? null,
      pendingPush: true,
    },
  });
  return toCashMovementDto(created);
}

/**
 * Corrige un gasto ya registrado del turno.
 *
 * Vuelve a marcar `pendingPush`: si el gasto ya subió, el reenvío manda un
 * `PATCH` con el `remoteId` (ver `pushOne` en `cash-movement.service.ts`); si
 * todavía no, el alta viaja ya corregida. Sin esto, la corrección quedaría solo
 * en este equipo y el reporte del admin seguiría mostrando la cifra vieja.
 *
 * `pushError` se limpia: la causa del rechazo pudo ser justo lo que se corrigió.
 */
async function updateExpense(prisma, id, patch) {
  const current = await prisma.cashMovement.findUnique({ where: { id } });
  if (!current) {
    throw new Error('El gasto no existe en este equipo');
  }
  if (current.type !== 'expense') {
    throw new Error('Solo se pueden corregir gastos');
  }

  const amount = patch.amount ?? current.amount;
  const category = patch.category ?? current.category;
  const description = patch.description !== undefined ? patch.description : current.description;
  const reason = patch.reason ?? current.reason;

  if (!(amount > 0)) {
    throw new Error('El monto debe ser mayor a cero');
  }
  if (!category) {
    throw new Error('La categoría es requerida para gastos');
  }
  // Se valida contra la categoría **resultante**: cambiar a Insumos sin describir
  // dejaría pasar algo que el alta habría rechazado.
  if (CATEGORIES_REQUIRING_DESCRIPTION.has(category) && !description?.trim()) {
    throw new Error('La descripción es requerida para esta categoría');
  }

  const updated = await prisma.cashMovement.update({
    where: { id },
    data: {
      amount,
      reason,
      category,
      description: description?.trim() || null,
      pendingPush: true,
      pushError: null,
    },
  });
  return toCashMovementDto(updated);
}

async function listForSession(prisma, cashSessionId) {
  const rows = await prisma.cashMovement.findMany({
    where: { cashSessionId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toCashMovementDto);
}

/** Todos los movimientos locales, para la pantalla de auditoría de gastos del POS. */
function buildWhere(filters = {}) {
  const where = {};
  if (filters.type) where.type = filters.type;
  if (filters.category) where.category = filters.category;
  // Alcance del reporte: por turno, o por rango de fechas para el reporte del día.
  if (filters.cashSessionId) where.cashSessionId = filters.cashSessionId;
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: new Date(filters.from) } : {}),
      ...(filters.to ? { lte: new Date(filters.to) } : {}),
    };
  }
  return where;
}

async function listAllLocal(prisma, filters = {}) {
  const rows = await prisma.cashMovement.findMany({
    where: buildWhere(filters),
    orderBy: { createdAt: 'desc' },
    ...(filters.offset ? { skip: filters.offset } : {}),
    ...(filters.limit ? { take: filters.limit } : {}),
  });
  return rows.map(toCashMovementDto);
}

/**
 * Cuántos movimientos hay con esos filtros. Lo pide el paginador: sin el total,
 * la tabla no sabe cuántas páginas existen y solo puede ofrecer "siguiente"
 * hasta que una página vuelva vacía.
 */
async function countAllLocal(prisma, filters = {}) {
  return prisma.cashMovement.count({ where: buildWhere(filters) });
}

/**
 * Movimientos listos para subir. Los de un turno esperan a que la sesión padre
 * tenga `remoteId` — si no, no hay a qué colgarlos allá (`CashSessionService.
 * flushQueue()` corre antes en `SyncScheduler`). Los de la caja de la farmacia
 * no dependen de ningún turno y suben de inmediato.
 */
/**
 * Motivo con el que se marca un movimiento que ya no tiene a dónde subir.
 * Se escribe en `pushError`, así que aparece en la lista de bloqueados.
 */
const TURNO_YA_CERRADO =
  'El turno ya se cerró en el servidor: este movimiento no se puede subir. Requiere revisión de un administrador.';

/**
 * Un movimiento de un turno **ya cerrado en el servidor** no puede subir: el
 * backend responde 400 "el turno de caja ya está cerrado". Mandarlo igual es la
 * petición en rojo que se veía después del `close`.
 *
 * Se marca como bloqueado en vez de dejarlo en la cola:
 *
 * - **no se reintenta**, así que deja de salir esa petición condenada;
 * - **no desaparece**: `pushError` lo pone en la lista de bloqueados, donde un
 *   administrador lo ve. Sacarlo de la cola sin más escondería dinero — el
 *   contador de pendientes diría 0 con un gasto real sin registrar allá.
 *
 * "Cerrado en el servidor" es: el turno se cerró en local, su cierre ya subió
 * (`pendingClosePush` en false, sin error) y tiene `remoteId`. Un turno cerrado
 * cuyo cierre **sigue en cola** no entra aquí: sus movimientos todavía llegan a
 * tiempo, y de que suban antes se encarga el orden de `SyncScheduler`.
 */
async function bloquearLosDeTurnoCerrado(prisma, ownerUid) {
  const condenados = await prisma.cashMovement.findMany({
    where: {
      pendingPush: true,
      pushError: null,
      ...(ownerUid ? { createdBy: ownerUid } : {}),
      cashSession: {
        remoteId: { not: null },
        closedAtLocal: { not: null },
        pendingClosePush: false,
        closePushError: null,
      },
    },
    select: { id: true },
  });

  for (const row of condenados) {
    await prisma.cashMovement.updateMany({
      where: { id: row.id },
      data: { pushError: TURNO_YA_CERRADO },
    });
  }
  return condenados.length;
}

/**
 * Cerrojo del **momento del envío**: se consulta justo antes de emitir el
 * `POST`, no al armar la cola.
 *
 * El filtro de `getPendingPush` mira el estado cuando se lee la cola, y entre
 * esa lectura y el envío de cada movimiento cabe un cierre: basta que otro
 * empuje suba el `close` en esa ventana para que la petición salga condenada.
 * Esto la corta en seco y, de paso, la deja bloqueada con su motivo.
 *
 * Devuelve `false` **solo** cuando el turno ya cerró en el servidor. Un turno
 * abierto, o cerrado con su cierre todavía en cola, sigue aceptando el envío.
 */
async function assertPushable(prisma, id) {
  const row = await prisma.cashMovement.findUnique({ where: { id } });
  if (!row || !row.cashSessionId) {
    // Sin turno padre (caja de la farmacia) no hay nada que se pueda cerrar.
    return true;
  }
  const turno = await prisma.cashSession.findUnique({ where: { id: row.cashSessionId } });
  const cerradoEnServidor = Boolean(
    turno && turno.remoteId && turno.closedAtLocal && !turno.pendingClosePush && !turno.closePushError,
  );
  if (!cerradoEnServidor) {
    return true;
  }
  await prisma.cashMovement.updateMany({
    where: { id },
    data: { pushError: TURNO_YA_CERRADO },
  });
  return false;
}

/** `ownerUid`: solo los movimientos de ese cajero (ver `ownerFilter` en cash-sessions). */
async function getPendingPush(prisma, { ownerUid } = {}) {
  // Antes de entregar la cola: lo que ya no puede subir sale de ella.
  await bloquearLosDeTurnoCerrado(prisma, ownerUid);

  const rows = await prisma.cashMovement.findMany({
    where: {
      pendingPush: true,
      pushError: null,
      OR: [{ cashSessionId: null }, { cashSession: { remoteId: { not: null } } }],
      ...(ownerUid ? { createdBy: ownerUid } : {}),
    },
    include: { cashSession: { select: { remoteId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    ...toCashMovementDto(row),
    cashSessionRemoteId: row.cashSession?.remoteId ?? null,
  }));
}

/**
 * Borra un movimiento que el servidor rechazó y que **nunca llegó a existir**
 * allá. Si ya tiene `remoteId` no se borra: existe en el servidor y borrarlo
 * aquí lo dejaría fuera del corte local pero vivo en la auditoría del admin.
 *
 * A diferencia de la venta, no hay stock que reponer: un gasto solo mueve
 * efectivo, y el efectivo esperado se recalcula de las filas que queden.
 */
async function discard(prisma, id) {
  const row = await prisma.cashMovement.findUnique({ where: { id } });
  if (!row) {
    return;
  }
  if (row.remoteId) {
    throw new Error('Este movimiento ya existe en el servidor: no se puede descartar');
  }
  await prisma.cashMovement.delete({ where: { id } });
}

/** Gastos y movimientos que el servidor rechazó (ver `listBlocked` en sales.js). */
async function listBlocked(prisma) {
  const rows = await prisma.cashMovement.findMany({
    where: { pushError: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    kind: 'cashMovement',
    id: row.id,
    label: row.reason ?? row.type,
    detail: `$${Number(row.amount ?? 0).toFixed(2)}`,
    occurredAt: row.createdAt,
    reason: row.pushError,
  }));
}

async function markSynced(prisma, localId, remoteId) {
  await prisma.cashMovement.update({
    where: { id: localId },
    data: { remoteId: remoteId ?? null, pendingPush: false, pushError: null },
  });
}

async function markPushFailed(prisma, localId, message) {
  await prisma.cashMovement.update({ where: { id: localId }, data: { pushError: message } });
}

async function clearPushError(prisma, localId) {
  await prisma.cashMovement.update({ where: { id: localId }, data: { pushError: null } });
}

module.exports = {
  toCashMovementDto,
  addMovement,
  listForSession,
  listAllLocal,
  countAllLocal,
  getPendingPush,
  assertPushable,
  listBlocked,
  discard,
  updateExpense,
  markSynced,
  markPushFailed,
  clearPushError,
};
