/**
 * Foto de la salud de sincronización de la caja (`PosDiagnosticsInput`), para
 * `POST /pos/diagnostics`.
 *
 * Existe porque una venta atorada en una caja solo se veía **en esa caja**: el
 * servidor no tenía rastro y el admin se enteraba cuando faltaba dinero en el
 * corte. Con esta foto el admin ve desde el panel web qué está bloqueado, por
 * qué, y puede mandar comandos (`PosCommand`) para destrabarlo.
 *
 * Solo lee SQLite; quien manda la foto y ejecuta los comandos es el renderer
 * (el proceso main nunca hace red).
 */

const { blockersForPayload } = require('./sale-blockers');
const syncLog = require('./sync-log');

/** Topes del contrato con el backend. */
const LIMITS = {
  blockedSales: 200,
  blockedCashSessions: 100,
  unsyncedProducts: 200,
  recentSyncRuns: 50,
  syncLog: 200,
  stockSample: 300,
};

/** Ventana de "más vendidos" para priorizar la muestra de stock (SPEC 67). */
const STOCK_SAMPLE_WINDOW_DAYS = 7;

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function waitingForOf(blockers) {
  if (blockers.some((blocker) => blocker.kind === 'cashSession')) return 'turno';
  if (blockers.some((blocker) => blocker.kind === 'product')) return 'catalogo';
  // Sin nada local que esperar: el bloqueo es un rechazo del servidor.
  return 'servidor';
}

async function blockedSalesOf(prisma) {
  const rows = await prisma.sale.findMany({
    where: { pendingPush: true, pushError: { not: null } },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
    take: LIMITS.blockedSales,
  });
  const result = [];
  for (const row of rows) {
    let blockers = [];
    try {
      blockers = await blockersForPayload(prisma, JSON.parse(row.payloadJson), row.items ?? []);
    } catch {
      // Payload ilegible: se reporta igual, sin bloqueadores.
    }
    result.push({
      localId: row.id,
      folio: row.folio,
      total: Number(row.total ?? 0),
      createdAt: iso(row.createdAt),
      cashSessionId: row.cashSessionId ?? null,
      pushError: row.pushError,
      waitingFor: waitingForOf(blockers),
      blockers,
    });
  }
  return result;
}

async function blockedCashSessionsOf(prisma) {
  const rows = await prisma.cashSession.findMany({
    where: { OR: [{ pushError: { not: null } }, { closePushError: { not: null } }] },
    orderBy: { openedAt: 'asc' },
    take: LIMITS.blockedCashSessions,
  });
  return rows.map((row) => ({
    localId: row.id,
    remoteId: row.remoteId ?? null,
    openedAt: iso(row.openedAt),
    openedByLabel: row.openedByLabel ?? null,
    pushError: row.pushError ?? null,
    closePushError: row.closePushError ?? null,
  }));
}

async function unsyncedProductsOf(prisma) {
  const rows = await prisma.product.findMany({
    where: { remoteId: null },
    orderBy: { createdAt: 'asc' },
    take: LIMITS.unsyncedProducts,
  });
  // El error del alta por "Entrada de stock" vive en el lote, no en el producto.
  const batchErrors = new Map();
  if (rows.length && prisma.batch) {
    const batches = await prisma.batch.findMany({
      where: { productId: { in: rows.map((row) => row.id) }, pushError: { not: null } },
    });
    for (const batch of batches) {
      if (!batchErrors.has(batch.productId)) batchErrors.set(batch.productId, batch.pushError);
    }
  }
  return rows.map((row) => ({
    localId: row.id,
    name: row.name,
    pushError: row.pushError ?? batchErrors.get(row.id) ?? null,
    catalogPushError: row.catalogPushError ?? null,
    // Para que el panel distinga dos altas con el mismo nombre y vea cuánto
    // stock no ha subido. El backend los acepta opcionales.
    sku: row.sku ?? null,
    barcode: row.barcode ?? null,
    stock: Math.max(0, row.totalStock ?? 0),
    createdAt: iso(row.createdAt),
  }));
}

async function recentSyncRunsOf(prisma) {
  const rows = await prisma.syncRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: LIMITS.recentSyncRuns,
  });
  return rows.map((row) => ({
    entity: row.entity,
    direction: row.direction,
    status: row.status,
    errorMessage: row.errorMessage ?? null,
    startedAt: iso(row.startedAt),
  }));
}

/**
 * Turno abierto en este equipo (de quien sea): `remoteId` si ya subió, si no el
 * id local, o `null` si no hay ninguno abierto.
 *
 * Con esto el backend sabe qué caja tiene un turno en curso (`cashSessions` no
 * guarda el equipo) y solo alerta por silencio a esas: una caja apagada fuera
 * de horario, sin turno, no debe mandar correo. Si la consulta falla se omite
 * el campo (no se manda `null`): `null` diría "sin turno" y apagaría el aviso
 * justo cuando no sabemos.
 */
async function openCashSessionIdOf(prisma) {
  try {
    const row = await prisma.cashSession.findFirst({
      where: { closedAtLocal: null },
      orderBy: { openedAt: 'desc' },
    });
    return row ? (row.remoteId ?? row.id) : null;
  } catch {
    return undefined;
  }
}

/**
 * Muestra de stock para que el backend detecte divergencias entre la caja y el
 * servidor (SPEC 67, E3): `[{ productId (remoto), localStock }]`, máximo 300,
 * primero los más vendidos de los últimos 7 días.
 *
 * Solo productos **sin pendientes de subida**: ni ventas sin subir (o anuladas
 * en local sin anular arriba), ni lotes de entrada pendientes, ni alta o edición
 * de catálogo pendiente. Con algo en vuelo la diferencia es esperada y el
 * backend la contaría como divergencia falsa.
 */
async function stockSampleOf(prisma, now) {
  const since = new Date(now.getTime() - STOCK_SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [products, pendingSales, pendingBatches, recentSales] = await Promise.all([
    prisma.product.findMany({ where: { remoteId: { not: null } } }),
    prisma.sale.findMany({
      where: { OR: [{ pendingPush: true }, { needsRemoteVoid: true }] },
      include: { items: true },
    }),
    prisma.batch.findMany({ where: { pendingPush: true } }),
    prisma.sale.findMany({
      where: { createdAt: { gte: since }, voidedAt: null },
      include: { items: true },
    }),
  ]);

  const withPending = new Set(pendingBatches.map((batch) => batch.productId));
  for (const sale of pendingSales) {
    for (const item of sale.items ?? []) {
      if (item.productId) withPending.add(item.productId);
    }
  }

  const sold = new Map();
  for (const sale of recentSales) {
    for (const item of sale.items ?? []) {
      if (item.kind === 'product' && item.productId) {
        sold.set(item.productId, (sold.get(item.productId) ?? 0) + Number(item.quantity ?? 0));
      }
    }
  }

  return products
    .filter(
      (row) =>
        !withPending.has(row.id) &&
        !row.pendingPush &&
        !row.pendingCatalogPush &&
        !row.pushError &&
        !row.catalogPushError,
    )
    .sort((a, b) => {
      const bySold = (sold.get(b.id) ?? 0) - (sold.get(a.id) ?? 0);
      return bySold !== 0 ? bySold : String(a.remoteId).localeCompare(String(b.remoteId));
    })
    .slice(0, LIMITS.stockSample)
    .map((row) => ({ productId: row.remoteId, localStock: Number(row.totalStock ?? 0) }));
}

/**
 * Arma el `PosDiagnosticsInput`. `device` lo pone el proceso main (identidad
 * del equipo y versión), que es quien la conoce; también `lastLocalBackupAt`
 * (ISO de la última copia local de rutina, SPEC 37), porque es main quien sabe
 * dónde están las copias. Sin él se reporta `null`.
 *
 * SPEC 67: `device.updateError`/`updateCheckedAt` (estado del actualizador, que
 * conoce main) viajan solo si hay dato. `includeStockSample` agrega la muestra
 * diaria de stock; si falla se omite (el renderer no da el día por cubierto).
 */
async function buildSnapshot(prisma, device, now = new Date(), { includeStockSample = false } = {}) {
  const [
    pendingSalesCount,
    blockedSales,
    blockedCashSessions,
    unsyncedProducts,
    recentSyncRuns,
    log,
    openCashSessionId,
  ] =
    await Promise.all([
      prisma.sale.count({ where: { pendingPush: true, pushError: null } }),
      blockedSalesOf(prisma),
      blockedCashSessionsOf(prisma),
      unsyncedProductsOf(prisma),
      recentSyncRunsOf(prisma),
      syncLog.listRecent(prisma, LIMITS.syncLog).catch(() => []),
      openCashSessionIdOf(prisma),
    ]);
  let stockSample;
  if (includeStockSample) {
    try {
      stockSample = await stockSampleOf(prisma, now);
    } catch {
      stockSample = undefined;
    }
  }
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    appVersion: device.appVersion,
    platform: device.platform,
    generatedAt: now.toISOString(),
    pendingSalesCount,
    blockedSales,
    blockedCashSessions,
    unsyncedProducts,
    recentSyncRuns,
    syncLog: log,
    // `undefined` (consulta fallida) desaparece al serializar a JSON.
    ...(openCashSessionId === undefined ? {} : { openCashSessionId }),
    lastLocalBackupAt: iso(device.lastLocalBackupAt),
    ...(device.updateError ? { updateError: String(device.updateError) } : {}),
    ...(iso(device.updateCheckedAt) ? { updateCheckedAt: iso(device.updateCheckedAt) } : {}),
    ...(stockSample === undefined ? {} : { stockSample }),
  };
}

module.exports = { buildSnapshot, stockSampleOf, LIMITS };
