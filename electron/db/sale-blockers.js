/**
 * Qué detiene a una venta en la caja: su turno o alguno de sus productos sin
 * identidad remota.
 *
 * Antes, una venta que esperaba demasiado acababa con un mensaje genérico ("su
 * turno o alguno de sus productos no sincroniza") y nadie sabía **cuál** ni
 * **por qué**. Aquí se nombra el bloqueador y el error que lo detiene, para que
 * el panel de rechazados pueda arreglarlo y el admin lo vea en el diagnóstico.
 *
 * Este módulo no depende de `sales.js` (que sí depende de él), para no armar un
 * `require` circular.
 */

/**
 * Ids locales: los genera Prisma con `@default(uuid())` (36 caracteres con
 * guiones). Ningún id de Firestore tiene esa forma.
 */
const LOCAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids automáticos de Firestore (`doc()` sin id): 20 alfanuméricos. */
const REMOTE_ID_RE = /^[A-Za-z0-9]{20}$/;

function looksLikeLocalId(id) {
  return typeof id === 'string' && LOCAL_ID_RE.test(id);
}

function looksLikeRemoteId(id) {
  return typeof id === 'string' && REMOTE_ID_RE.test(id);
}

/** Misma regla que `productItemsOf` en sales.js: `kind` ausente = producto. */
function productItemsOf(items) {
  return (items ?? []).filter((item) => (item.kind ?? 'product') === 'product');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * `25/09 13:02`, en hora local del equipo. A mano y no con `toLocaleString`:
 * el formato de ICU cambia entre versiones de Node/Electron (coma, espacios
 * finos) y el mensaje se compara en pruebas y se lee en el panel.
 */
function formatShortDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function cashSessionLabel(session) {
  const who = session.openedByLabel || session.openedBy || 'cajero desconocido';
  return `Turno de ${who} del ${formatShortDate(session.openedAt)}`;
}

/**
 * Bloqueadores de un payload ya congelado. `saleItems` (las partidas de la
 * venta en SQLite) solo sirven para ponerle nombre a un producto que ya no
 * existe en local.
 *
 * Reglas, deterministas y alineadas con la resolución real de `sales.js`:
 * - turno con fila local y sin `remoteId` → bloquea; sin fila local, el id ya
 *   es remoto (turno nacido en el servidor) y no bloquea;
 * - producto con fila local (por `id` o `remoteId`) sin `remoteId` → bloquea;
 * - producto sin fila local con forma de id de Firestore → no bloquea (se manda
 *   tal cual, igual que el turno);
 * - producto sin fila local con cualquier otra forma → bloquea con
 *   `missingLocally: true`.
 */
async function blockersForPayload(prisma, payload, saleItems = []) {
  const blockers = [];

  const sessionId = payload?.cashSessionId;
  if (sessionId) {
    const session = await prisma.cashSession.findUnique({ where: { id: sessionId } });
    if (session && !session.remoteId) {
      blockers.push({
        kind: 'cashSession',
        localId: session.id,
        remoteId: null,
        label: cashSessionLabel(session),
        error: session.pushError ?? null,
        missingLocally: false,
      });
    }
  }

  const payloadItems = Array.isArray(payload?.items) ? payload.items : [];
  const productItems = productItemsOf(payloadItems);
  const ids = [...new Set(productItems.map((item) => item.productId).filter(Boolean))];
  if (!ids.length) {
    return blockers;
  }

  const products = await prisma.product.findMany({
    where: { OR: [{ id: { in: ids } }, { remoteId: { in: ids } }] },
  });
  const byAnyId = new Map();
  for (const product of products) {
    byAnyId.set(product.id, product);
    if (product.remoteId) {
      byAnyId.set(product.remoteId, product);
    }
  }

  const unsynced = products.filter((product) => !product.remoteId);
  const batchErrors = await batchErrorsFor(prisma, unsynced.map((product) => product.id));

  // Nombre de respaldo para un producto que ya no está en local: la partida de
  // la venta lo guardó al cobrar (por id, o por posición si el payload viaja
  // con el remoto y la partida con el local).
  const nameById = new Map();
  const productSaleItems = productItemsOf(saleItems);
  productSaleItems.forEach((item) => {
    if (item.productId) nameById.set(item.productId, item.productName);
  });
  productItems.forEach((item, index) => {
    if (!nameById.has(item.productId)) {
      const name = item.productName ?? productSaleItems[index]?.productName;
      if (name) nameById.set(item.productId, name);
    }
  });

  const seen = new Set();
  for (const id of ids) {
    const product = byAnyId.get(id);
    if (product) {
      if (product.remoteId || seen.has(product.id)) {
        continue;
      }
      seen.add(product.id);
      blockers.push({
        kind: 'product',
        localId: product.id,
        remoteId: null,
        label: product.name,
        error: product.catalogPushError ?? product.pushError ?? batchErrors.get(product.id) ?? null,
        missingLocally: false,
      });
      continue;
    }
    if (looksLikeRemoteId(id)) {
      continue;
    }
    blockers.push({
      kind: 'product',
      localId: id,
      remoteId: null,
      label: nameById.get(id) ?? id,
      error: null,
      missingLocally: true,
    });
  }

  return blockers;
}

/**
 * El alta de un producto desde "Entrada de stock" guarda su error en el
 * **lote** (`Batch.pushError`), no en el producto: sin esto el bloqueador
 * salía sin explicación.
 */
async function batchErrorsFor(prisma, productIds) {
  const errors = new Map();
  if (!productIds.length || !prisma.batch) {
    return errors;
  }
  const batches = await prisma.batch.findMany({
    where: { productId: { in: productIds }, pushError: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  for (const batch of batches) {
    if (!errors.has(batch.productId)) {
      errors.set(batch.productId, batch.pushError);
    }
  }
  return errors;
}

/** Bloqueadores de una venta local; `null` si la venta no existe. */
async function diagnoseSale(prisma, saleId) {
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true } });
  if (!sale) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(sale.payloadJson);
  } catch {
    return [];
  }
  return blockersForPayload(prisma, payload, sale.items ?? []);
}

/** Primera letra en minúscula: "Turno de Ana…" → "Espera al turno de Ana…". */
function lowerFirst(text) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function describeBlocker(blocker) {
  if (blocker.kind === 'cashSession') {
    const why = blocker.error
      ? `su apertura falló: ${blocker.error}`
      : 'su apertura aún no sube al servidor';
    return `Espera al ${lowerFirst(blocker.label)} (${why})`;
  }
  if (blocker.missingLocally) {
    return (
      `El producto ${blocker.label} no existe en esta caja (id ${blocker.localId}) ` +
      'y no se puede traducir al del servidor'
    );
  }
  const why = blocker.error
    ? `alta local sin subir: ${blocker.error}`
    : 'alta local sin subir todavía';
  return `Espera al producto ${blocker.label} (${why})`;
}

/**
 * `pushError` de una venta bloqueada por espera. Nombra hasta tres
 * bloqueadores para que quepa en el panel; el detalle completo sale en el
 * diagnóstico.
 */
function describeBlockers(blockers) {
  if (!blockers.length) {
    return (
      'Esta venta espera a que su turno o alguno de sus productos sincronice, y ya ' +
      'lleva demasiados intentos. Revísala: reintenta cuando el catálogo esté al día o descártala.'
    );
  }
  const shown = blockers.slice(0, 3).map(describeBlocker);
  const rest = blockers.length - shown.length;
  const tail = rest > 0 ? `; y ${rest} más` : '';
  const advice = blockers.some((b) => b.missingLocally)
    ? ' Descártala y vuelve a cobrarla, o mándala a conciliación.'
    : ' Pulsa "Arreglar" para reintentarlo.';
  return `${shown.join('; ')}${tail}.${advice}`;
}

module.exports = {
  blockersForPayload,
  diagnoseSale,
  describeBlocker,
  describeBlockers,
  formatShortDate,
  looksLikeLocalId,
  looksLikeRemoteId,
};
