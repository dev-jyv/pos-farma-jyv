function emptyMethod() {
  return { count: 0, total: 0 };
}

function emptyMovement() {
  return { count: 0, total: 0 };
}

/**
 * Espejo de `buildSummary()` en
 * `backend-farma-jyv/functions/src/services/cash-sessions.service.ts` —
 * MISMA aritmética, línea por línea, para que el "efectivo esperado" que ve
 * el cajero en vivo (sin red) coincida con el que el backend recalculará de
 * forma autoritativa al sincronizar. Si esa función cambia allá, hay que
 * actualizar esta a mano: no hay un solo lugar compartido entre Node (backend)
 * y este proceso Electron.
 *
 * A diferencia del backend, aquí no hay `returns` (las devoluciones no existen
 * en el modelo local del POS todavía) — el cierre real siempre usa el valor
 * autoritativo que regresa `POST /cash-sessions/:id/close`.
 */
function buildSummary(openingAmount, sales, movements) {
  const byMethod = {
    cash: emptyMethod(),
    card: emptyMethod(),
    transfer: emptyMethod(),
    mixed: emptyMethod(),
  };

  let salesCount = 0;
  let voidedCount = 0;
  let grandTotal = 0;
  let cashInDrawerNet = 0;

  // Bloque de servicios: se calcula a la par pero se reporta aparte. Sale de los
  // campos DENORMALIZADOS de la venta, nunca de sus partidas — este cálculo solo
  // proyecta la venta, igual que el del backend.
  const services = {
    count: 0,
    voidedCount: 0,
    byMethod: { cash: emptyMethod(), card: emptyMethod(), transfer: emptyMethod(), mixed: emptyMethod() },
    total: 0,
    commissionTotal: 0,
    cashInDrawer: 0,
  };
  let servicesCashNet = 0;

  for (const sale of sales) {
    // Toda venta anterior a los servicios cae a estos defaults y se comporta
    // como 100 % farmacia: el corte de ayer da exactamente lo mismo que antes.
    const servicesTotal = sale.servicesTotal ?? 0;
    const pharmacyCash =
      sale.pharmacyCashAmount ?? sale.cashAmount ?? (sale.amountReceived ?? 0) - (sale.change ?? 0);
    const servicesCash = sale.servicesCashAmount ?? 0;

    if (sale.voidedAt) {
      voidedCount += 1;
      if (servicesTotal > 0) {
        services.voidedCount += 1;
      }
      continue;
    }
    salesCount += 1;
    grandTotal += sale.total;
    const method = sale.paymentMethod;
    if (byMethod[method]) {
      byMethod[method].count += 1;
      byMethod[method].total += sale.total;
    }
    if (method === 'cash' || method === 'mixed') {
      cashInDrawerNet += pharmacyCash;
      servicesCashNet += servicesCash;
    }

    if (servicesTotal > 0) {
      services.count += 1;
      services.total += servicesTotal;
      services.commissionTotal += sale.commissionTotal ?? 0;
      if (services.byMethod[method]) {
        services.byMethod[method].count += 1;
        services.byMethod[method].total += servicesTotal;
      }
    }
  }

  const movementTotals = {
    deposits: emptyMovement(),
    withdrawals: emptyMovement(),
    expenses: emptyMovement(),
  };

  for (const movement of movements) {
    if (movement.type === 'deposit') {
      movementTotals.deposits.count += 1;
      movementTotals.deposits.total += movement.amount;
      cashInDrawerNet += movement.amount;
    } else if (movement.type === 'withdrawal') {
      movementTotals.withdrawals.count += 1;
      movementTotals.withdrawals.total += movement.amount;
      cashInDrawerNet -= movement.amount;
    } else {
      movementTotals.expenses.count += 1;
      movementTotals.expenses.total += movement.amount;
      cashInDrawerNet -= movement.amount;
    }
  }

  const cashInDrawer = round(openingAmount + cashInDrawerNet);
  // El fondo inicial es de farmacia; servicios abre en 0.
  services.cashInDrawer = round(servicesCashNet);
  services.total = round(services.total);
  services.commissionTotal = round(services.commissionTotal);

  return {
    // Conserva nombre y significado: es el esperado de FARMACIA. El esperado
    // total del cajón (que es lo que el cajero cuenta, porque es un solo cajón)
    // es la suma de los dos.
    expectedCashAmount: cashInDrawer,
    expectedServicesCashAmount: services.cashInDrawer,
    summary: {
      salesCount,
      voidedCount,
      byMethod,
      movements: movementTotals,
      grandTotal: round(grandTotal),
      cashInDrawer,
      // Se omite si el turno no vio servicios: una farmacia que no los usa no
      // debe encontrarse un bloque vacío en su corte.
      ...(services.count || services.voidedCount ? { services } : {}),
    },
  };
}

function round(amount) {
  return Math.round(amount * 100) / 100;
}

function toCashSessionDto(row) {
  return {
    id: row.id,
    remoteId: row.remoteId ?? null,
    openedBy: row.openedBy,
    // Nombre de quien lo abrió: la caja de la farmacia (solo admin) necesita
    // decir a qué corte le va a cambiar el efectivo esperado, y un uid crudo no
    // le dice nada a nadie.
    openedByLabel: row.openedByLabel ?? null,
    openingAmount: row.openingAmount,
    expectedCashAmount: row.expectedCashAmount ?? null,
    expectedServicesCashAmount: row.expectedServicesCashAmount ?? null,
    countedCashAmount: row.countedCashAmount ?? null,
    cashDifference: row.cashDifference ?? null,
    summary: row.summaryJson ? JSON.parse(row.summaryJson) : null,
    closedBy: row.closedBy ?? null,
    openedAt: row.openedAt,
    closedAt: row.closedAtLocal ?? null,
    hasPendingAdjustment: row.hasPendingAdjustment,
    adjustmentStatus: row.adjustmentStatus ?? null,
    adjustmentReviewedBy: row.adjustmentReviewedBy ?? null,
    adjustmentReviewedAt: row.adjustmentReviewedAt ?? null,
    adjustmentNote: row.adjustmentNote ?? null,
    autoClosedByExpiry: row.autoClosedByExpiry,
  };
}

/** El único turno sin cerrar de este cajero, si existe. */
async function getOpenLocal(prisma, userId) {
  const row = await prisma.cashSession.findFirst({
    where: { openedBy: userId, closedAtLocal: null },
    orderBy: { openedAt: 'desc' },
  });
  return row ? toCashSessionDto(row) : null;
}

/**
 * Turno abierto en **este equipo**, de quien sea.
 *
 * Para las pantallas que mueven el efectivo del cajón físico sin ser el cajero
 * que lo abrió: la caja de la farmacia es solo de admin, así que preguntar por
 * `openedBy: adminUid` devolvía `null` y el retiro se registraba sin turno. Ese
 * dinero salía del mismo cajón, y el cajero cerraba con un faltante a su nombre
 * por algo que autorizó el admin.
 */
async function getOpenLocalAnyUser(prisma) {
  const row = await prisma.cashSession.findFirst({
    where: { closedAtLocal: null },
    orderBy: { openedAt: 'desc' },
  });
  return row ? toCashSessionDto(row) : null;
}

async function createLocal(prisma, { openedBy, openedByLabel, openingAmount }) {
  // Defensa contra doble apertura en el mismo equipo: dos turnos abiertos del
  // mismo cajero repartirían las ventas entre dos cortes y, al sincronizar,
  // los dos pelearían por el único turno abierto que admite el backend.
  const abierto = await prisma.cashSession.findFirst({
    where: { openedBy, closedAtLocal: null },
  });
  if (abierto) {
    throw new Error('Ya tienes un turno de caja abierto en este equipo');
  }
  const created = await prisma.cashSession.create({
    data: {
      openedBy,
      openedByLabel: openedByLabel ?? null,
      openingAmount,
      pendingPush: true,
    },
  });
  return toCashSessionDto(created);
}

/**
 * Efectivo esperado en vivo, sin red: lee las ventas y movimientos LOCALES de
 * este turno y aplica `buildSummary`. Se recalcula cada vez que se pide (no se
 * cachea) porque el volumen por turno es bajo y siempre debe reflejar la
 * última venta/gasto capturado.
 */
async function getLiveSummary(prisma, cashSessionId) {
  const session = await prisma.cashSession.findUnique({ where: { id: cashSessionId } });
  if (!session) {
    throw new Error(`No se encontró el turno local "${cashSessionId}"`);
  }
  const [sales, movements] = await Promise.all([
    prisma.sale.findMany({
      where: { cashSessionId },
      select: {
        paymentMethod: true,
        amountReceived: true,
        change: true,
        cashAmount: true,
        total: true,
        voidedAt: true,
        // Denormalizados por rama; en ventas viejas vienen null y caen a los
        // defaults de `buildSummary`.
        servicesTotal: true,
        pharmacyCashAmount: true,
        servicesCashAmount: true,
        commissionTotal: true,
      },
    }),
    prisma.cashMovement.findMany({
      where: { cashSessionId },
      select: { type: true, amount: true },
    }),
  ]);
  const { summary, expectedCashAmount, expectedServicesCashAmount } = buildSummary(
    session.openingAmount,
    sales,
    movements,
  );
  return { summary, expectedCashAmount, expectedServicesCashAmount };
}

/**
 * Cierra el turno local. `countedCashAmount` viene del cajero (o, en el
 * auto-cierre, es igual al esperado — ver `autoClosedByExpiry`). El ajuste
 * pendiente NUNCA se marca en un auto-cierre: no hay cajero presente para
 * explicar una diferencia que, además, el propio auto-cierre ya evita al
 * mandar `countedCashAmount = expectedCashAmount`.
 */
async function closeLocal(prisma, sessionId, { countedCashAmount, closedBy, closedByLabel, autoClosedByExpiry = false }) {
  const { summary, expectedCashAmount, expectedServicesCashAmount } = await getLiveSummary(
    prisma,
    sessionId,
  );
  // Redondeo a centavos ANTES de comparar: en coma flotante `500.01 - 500` da
  // 0.00999…, así que un centavo real de diferencia no llegaba a `>= 0.01` y el
  // turno se cerraba como si cuadrara. Además evita guardar diferencias con
  // cola de decimales (-39.999999999) en el corte impreso.
  // Un solo cajón físico: el cajero cuenta una vez y la diferencia se mide
  // contra la SUMA de los dos esperados. Los dos por separado son informativos.
  const expectedTotal = expectedCashAmount + (expectedServicesCashAmount ?? 0);
  const cashDifference = Math.round((countedCashAmount - expectedTotal) * 100) / 100;
  const hasPendingAdjustment = !autoClosedByExpiry && Math.abs(cashDifference) >= 0.01;

  const updated = await prisma.cashSession.update({
    where: { id: sessionId },
    data: {
      closedAtLocal: new Date(),
      closedBy,
      closedByLabel: closedByLabel ?? null,
      countedCashAmount,
      expectedCashAmount,
      expectedServicesCashAmount,
      cashDifference,
      summaryJson: JSON.stringify(summary),
      hasPendingAdjustment,
      adjustmentStatus: hasPendingAdjustment ? 'pending' : null,
      autoClosedByExpiry,
      // El create ya pudo haber subido (remoteId no null); si es así, este
      // cierre necesita su propio push aparte (ver `pendingClosePush` en el
      // schema). Si el create SIGUE pendiente, `markCreateSynced` es quien
      // activará `pendingClosePush` cuando el create por fin suba.
      pendingClosePush: true,
    },
  });
  return toCashSessionDto(updated);
}

/**
 * Efectivo que quedó físicamente en el cajón, para precargar el fondo del
 * turno siguiente. No es "el fondo del turno anterior": es lo que se **contó**
 * al cerrarlo (`countedCashAmount`, el dinero real, no el esperado), más o
 * menos los movimientos de la caja de la farmacia hechos **entre turnos**
 * (`cashSessionId: null`) — meter o sacar efectivo con la caja cerrada cambia
 * lo que el cajero encontrará mañana.
 *
 * Es por equipo, no por cajero: el cajón es físico y lo hereda quien abra.
 */
async function getCashOnHand(prisma) {
  const ultimo = await prisma.cashSession.findFirst({
    where: { closedAtLocal: { not: null } },
    orderBy: { closedAtLocal: 'desc' },
  });

  // Sin cierres previos no hay nada heredado: la caja arranca en lo que el
  // cajero declare.
  const base = ultimo ? (ultimo.countedCashAmount ?? ultimo.expectedCashAmount ?? 0) : 0;

  const movimientos = await prisma.cashMovement.findMany({
    where: {
      cashSessionId: null,
      ...(ultimo?.closedAtLocal ? { createdAt: { gt: ultimo.closedAtLocal } } : {}),
    },
    select: { type: true, amount: true },
  });

  const neto = movimientos.reduce(
    (total, movimiento) => (movimiento.type === 'deposit' ? total + movimiento.amount : total - movimiento.amount),
    0,
  );

  return {
    amount: Math.round((base + neto) * 100) / 100,
    lastClosedAt: ultimo?.closedAtLocal ?? null,
    countedAtLastClose: ultimo ? (ultimo.countedCashAmount ?? null) : null,
    movementsSinceClose: neto,
  };
}

/** Turnos cuya alta (`POST /cash-sessions`) todavía no subió. */
/**
 * `ownerUid` acota la cola a lo que ese cajero puede subir. El backend solo
 * acepta el turno de quien lo abrió (o de un admin): si el cajero B sincroniza
 * el turno del cajero A, responde 403 y el POS se lo muestra a B como un
 * "rechazado" que B no puede resolver. Cada quien sube lo suyo; lo de A sube
 * cuando A entra. Sin `ownerUid` (admin) se sube todo.
 */
function ownerFilter(ownerUid) {
  return ownerUid ? { openedBy: ownerUid } : {};
}

async function getPendingPush(prisma, { ownerUid } = {}) {
  await healRemoteOpenConflicts(prisma);
  const rows = await prisma.cashSession.findMany({
    where: { pendingPush: true, pushError: null, ...ownerFilter(ownerUid) },
    orderBy: { openedAt: 'asc' },
  });
  return rows.map(toCashSessionDto);
}

/** Turnos cuyo cierre local todavía no se refleja en el backend. */
/**
 * Cierres pendientes de subir.
 *
 * `sinHijosPendientes` excluye los turnos que todavía tienen ventas o gastos sin
 * sincronizar. Es la primera pasada del ciclo, cuyo único fin es **liberar el
 * hueco** del cajero (el backend admite un turno abierto por persona) para que
 * el alta de hoy no choque. Cerrar ahí un turno con hijos en cola condenaba a
 * esos hijos: el backend los rechaza con "el turno de caja ya está cerrado".
 * Esos turnos se cierran en la pasada final, cuando sus hijos ya subieron.
 */
async function getPendingClosePush(prisma, { ownerUid, sinHijosPendientes = false } = {}) {
  await healRemoteOpenConflicts(prisma);
  const rows = await prisma.cashSession.findMany({
    where: {
      remoteId: { not: null },
      pendingClosePush: true,
      closePushError: null,
      ...ownerFilter(ownerUid),
    },
    orderBy: { closedAtLocal: 'asc' },
  });

  if (!sinHijosPendientes) {
    return rows.map(toCashSessionDto);
  }

  const conHijos = new Set();
  for (const row of rows) {
    /**
     * Solo hijos **recuperables** (`pushError: null`). Uno ya rechazado espera
     * intervención del admin (reintentar, corregir o descartar): contarlo aquí
     * dejaría el turno abierto en el servidor para siempre, y con él el hueco
     * del cajero, que es peor — su corte nunca aparecería en la auditoría.
     */
    const [ventas, movimientos, anulacionesRemotas] = await Promise.all([
      prisma.sale.count({
        where: { cashSessionId: row.id, pendingPush: true, pushError: null },
      }),
      prisma.cashMovement.count({
        where: { cashSessionId: row.id, pendingPush: true, pushError: null },
      }),
      /**
       * Ventas que el servidor ya tiene **activas** y que aquí se anularon: les
       * falta el `POST /sales/:id/void`. No llevan `pendingPush` —su alta sí
       * subió—, así que no las veía ninguno de los dos conteos de arriba, y el
       * cierre se les adelantaba. Después de cerrar, el backend responde "solo
       * un administrador puede anularla" (un turno cerrado tiene su arqueo
       * firmado) y el cajero se queda sin poder aplicarla: el servidor conserva
       * como buena una venta que en la caja no existe.
       */
      prisma.sale.count({ where: { cashSessionId: row.id, needsRemoteVoid: true } }),
    ]);
    if (ventas > 0 || movimientos > 0 || anulacionesRemotas > 0) {
      conHijos.add(row.id);
    }
  }
  return rows.filter((row) => !conHijos.has(row.id)).map(toCashSessionDto);
}

/**
 * El alta ya subió. Si el turno YA se cerró en local mientras el alta seguía
 * en vuelo (carrera equivalente a `markSynced` de ventas), este mismo paso
 * activa `pendingClosePush` para que el cierre se suba aparte en el siguiente
 * ciclo — nunca se pierde el cierre por haber llegado "tarde".
 */
async function markCreateSynced(prisma, localId, remoteId) {
  const session = await prisma.cashSession.findUnique({ where: { id: localId }, select: { closedAtLocal: true } });

  // `remoteId` es único. Adoptar uno que ya es de otro turno local reventaba
  // con P2002 (visto en producción): pasa cuando el turno anterior sigue
  // ABIERTO en el backend —su cierre no ha subido— y `GET /cash-sessions/current`
  // devolvía ese mismo id para el turno nuevo.
  const duenoActual = await prisma.cashSession.findFirst({ where: { remoteId } });
  if (duenoActual && duenoActual.id !== localId) {
    // El dueño ya cerró en local: el hueco en el servidor se libera subiendo
    // ese cierre. Reencolarlo y dejar el alta nueva en cola (sin pushError)
    // para el próximo ciclo: closes → creates.
    if (duenoActual.closedAtLocal) {
      await prisma.cashSession.update({
        where: { id: duenoActual.id },
        data: { pendingClosePush: true, closePushError: null },
      });
      await prisma.cashSession.update({
        where: { id: localId },
        data: { pushError: null },
      });
      return { conflict: true, requeuedClose: true };
    }
    await prisma.cashSession.update({
      where: { id: localId },
      data: {
        pushError:
          `El turno remoto ${remoteId} ya pertenece a otro turno de este equipo. ` +
          'Sincroniza el cierre del turno anterior antes de subir este.',
      },
    });
    return { conflict: true };
  }

  await prisma.cashSession.update({
    where: { id: localId },
    data: {
      remoteId,
      pendingPush: false,
      pushError: null,
      ...(session?.closedAtLocal ? { pendingClosePush: true } : {}),
    },
  });
  return { conflict: false };
}

/**
 * Desatranca altas bloqueadas por un `remoteId` que aún es el `current` remoto
 * de un turno ya cerrado en local: reencola ese cierre y limpia el pushError
 * del alta nueva para que el ciclo closes → creates las suba solas.
 */
async function healRemoteOpenConflicts(prisma) {
  const bloqueadas = await prisma.cashSession.findMany({
    where: { pushError: { not: null }, pendingPush: true },
  });
  for (const fila of bloqueadas) {
    const match = String(fila.pushError).match(/turno remoto (\S+)/i);
    if (!match) {
      continue;
    }
    const remoteId = match[1];
    const dueno = await prisma.cashSession.findFirst({ where: { remoteId } });
    if (!dueno?.closedAtLocal) {
      continue;
    }
    await prisma.cashSession.update({
      where: { id: dueno.id },
      data: { pendingClosePush: true, closePushError: null },
    });
    await prisma.cashSession.update({
      where: { id: fila.id },
      data: { pushError: null },
    });
  }
}

/** El cierre ya subió; se guardan los valores autoritativos que regresó el backend. */
async function markCloseSynced(prisma, localId, { expectedCashAmount, cashDifference }) {
  await prisma.cashSession.update({
    where: { id: localId },
    data: {
      pendingClosePush: false,
      closePushError: null,
      ...(expectedCashAmount !== undefined ? { expectedCashAmount } : {}),
      ...(cashDifference !== undefined ? { cashDifference } : {}),
    },
  });
}

/**
 * Turnos rechazados, tanto en su alta (`pushError`) como en su cierre
 * (`closePushError`): un cierre que no sube deja el corte solo en este equipo.
 */
async function listBlocked(prisma) {
  const rows = await prisma.cashSession.findMany({
    where: { OR: [{ pushError: { not: null } }, { closePushError: { not: null } }] },
    orderBy: { openedAt: 'asc' },
  });
  return rows.map((row) => ({
    kind: 'cashSession',
    id: row.id,
    label: row.closePushError ? 'Cierre de turno' : 'Apertura de turno',
    detail: row.openedBy ?? '',
    occurredAt: row.openedAt,
    reason: row.closePushError ?? row.pushError,
  }));
}

async function markPushFailed(prisma, localId, message) {
  await prisma.cashSession.update({ where: { id: localId }, data: { pushError: message } });
}

async function markClosePushFailed(prisma, localId, message) {
  await prisma.cashSession.update({ where: { id: localId }, data: { closePushError: message } });
}

async function clearPushError(prisma, localId) {
  await prisma.cashSession.update({ where: { id: localId }, data: { pushError: null } });
}

async function clearClosePushError(prisma, localId) {
  await prisma.cashSession.update({ where: { id: localId }, data: { closePushError: null } });
}

/** Todos los turnos locales, para la pantalla de auditoría del POS. */
async function listLocal(prisma, filters = {}) {
  const where = {};
  if (filters.openedBy) where.openedBy = filters.openedBy;
  if (filters.adjustmentStatus) where.adjustmentStatus = filters.adjustmentStatus;
  const rows = await prisma.cashSession.findMany({ where, orderBy: { openedAt: 'desc' } });
  return rows.map(toCashSessionDto);
}

/**
 * Solo la usa el pull (`SyncScheduler.pullAdjustmentStatus`): refleja lo que
 * un admin ya resolvió en el backend. Nunca la llama el cajero — la
 * aprobación de ajustes vive exclusivamente en el servidor.
 */
async function updateAdjustmentStatus(prisma, localId, { status, reviewedBy, reviewedAt, note }) {
  await prisma.cashSession.updateMany({
    where: { id: localId },
    data: {
      adjustmentStatus: status,
      adjustmentReviewedBy: reviewedBy ?? null,
      adjustmentReviewedAt: reviewedAt ? new Date(reviewedAt) : null,
      adjustmentNote: note ?? null,
      hasPendingAdjustment: status === 'pending',
    },
  });
}

module.exports = {
  // Exportada para poder probar la aritmética del corte sin pasar por SQLite:
  // es el espejo del `buildSummary` autoritativo del backend y cualquier
  // divergencia se paga en el arqueo del cajero.
  buildSummary,
  toCashSessionDto,
  getOpenLocal,
  getOpenLocalAnyUser,
  createLocal,
  getLiveSummary,
  getCashOnHand,
  closeLocal,
  getPendingPush,
  getPendingClosePush,
  markCreateSynced,
  healRemoteOpenConflicts,
  markCloseSynced,
  listBlocked,
  markPushFailed,
  markClosePushFailed,
  clearPushError,
  clearClosePushError,
  listLocal,
  updateAdjustmentStatus,
};
