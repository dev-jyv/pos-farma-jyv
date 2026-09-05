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
async function getPendingPush(prisma) {
  const rows = await prisma.cashMovement.findMany({
    where: {
      pendingPush: true,
      pushError: null,
      OR: [{ cashSessionId: null }, { cashSession: { remoteId: { not: null } } }],
    },
    include: { cashSession: { select: { remoteId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    ...toCashMovementDto(row),
    cashSessionRemoteId: row.cashSession?.remoteId ?? null,
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
  updateExpense,
  markSynced,
  markPushFailed,
  clearPushError,
};
