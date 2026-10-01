const { codeFromReason } = require('./blocked-diagnosis');

/**
 * Ciclos de sync que una venta puede esperar a que su producto suba antes de
 * mandarla a revisión manual. Con los tres horarios fijos del día, son ~2 días.
 */
const MAX_RESOLVE_ATTEMPTS = 6;

/**
 * `pushError` que pone la propia caja al agotar `MAX_RESOLVE_ATTEMPTS`. Es un
 * bloqueo **local** (el servidor nunca vio la venta): `listBlocked` lo reconoce
 * por este texto para diagnosticar qué dependencia sigue sin subir.
 */
const BLOQUEO_POR_INTENTOS =
  'Esta venta espera a que su turno o alguno de sus productos ' +
  'sincronice, y ya lleva demasiados intentos. Revísala: ' +
  'reintenta cuando el catálogo esté al día o descártala.';

/**
 * Partidas que mueven inventario. **La regla de "los servicios no tocan stock"
 * vive solo aquí**: `createLocal`, `voidLocal`, `discard` y
 * `resolvePayloadProductIds` la consultan, ninguna la reimplementa.
 * `kind` ausente = partida anterior a los servicios = producto.
 */
function productItemsOf(items) {
  return (items ?? []).filter((item) => (item.kind ?? 'product') === 'product');
}

function toSaleDto(row) {
  return {
    id: row.id,
    remoteId: row.remoteId ?? null,
    folio: row.folio,
    remoteFolio: row.remoteFolio ?? null,
    pendingPush: row.pendingPush,
    pushError: row.pushError ?? null,
    items: (row.items ?? []).map((item) => ({
      kind: item.kind ?? 'product',
      productId: item.productId ?? undefined,
      serviceId: item.serviceId ?? undefined,
      providerId: item.providerId ?? undefined,
      providerName: item.providerName ?? undefined,
      commissionRate: item.commissionRate ?? undefined,
      commissionAmount: item.commissionAmount ?? undefined,
      productName: item.productName,
      unitPrice: item.unitPrice,
      discountAmount: item.discountAmount,
      quantity: item.quantity,
      subtotal: item.subtotal,
      saleDiscountShare: item.saleDiscountShare ?? undefined,
      netAmount: item.netAmount ?? undefined,
      taxes: item.taxesJson ? JSON.parse(item.taxesJson) : undefined,
      promotionId: item.promotionId ?? undefined,
      promotionName: item.promotionName ?? undefined,
      promotionDiscount: item.promotionDiscount ?? undefined,
    })),
    subtotal: row.subtotal,
    discountTotal: row.discountTotal,
    total: row.total,
    taxSummary: row.taxSummaryJson ? JSON.parse(row.taxSummaryJson) : null,
    paymentMethod: row.paymentMethod,
    amountReceived: row.amountReceived,
    change: row.change,
    cashAmount: row.cashAmount,
    cardAmount: row.cardAmount,
    cardPaymentReference: row.cardPaymentReference,
    cashierId: row.cashierId,
    cashSessionId: row.cashSessionId,
    customerId: row.customerId,
    customerName: row.customerName,
    prescription: row.prescriptionJson ? JSON.parse(row.prescriptionJson) : null,
    prescriptionRetained: row.prescriptionRetained,
    controlledGroups: JSON.parse(row.controlledGroupsJson ?? '[]'),
    billing: row.billingJson ? JSON.parse(row.billingJson) : null,
    invoiceStatus: row.invoiceStatus ?? null,
    pharmacyTotal: row.pharmacyTotal ?? null,
    servicesTotal: row.servicesTotal ?? null,
    pharmacyCashAmount: row.pharmacyCashAmount ?? null,
    servicesCashAmount: row.servicesCashAmount ?? null,
    commissionTotal: row.commissionTotal ?? 0,
    unreconciledAt: row.unreconciledAt ?? null,
    unreconciledReason: row.unreconciledReason ?? null,
    voidedAt: row.voidedAt,
    voidedBy: row.voidedBy ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Escribe la venta ya compuesta por el renderer (mismos cálculos que hoy hace
 * `SaleService` para la cola offline: tender, preview fiscal, grupos
 * controlados). El proceso main solo persiste; no rehace esa lógica.
 */
async function createLocal(prisma, sale) {
  const created = await prisma.sale.create({
    data: {
      folio: sale.folio,
      idempotencyKey: sale.idempotencyKey,
      subtotal: sale.subtotal,
      discountTotal: sale.discountTotal,
      total: sale.total,
      taxSummaryJson: sale.taxSummary ? JSON.stringify(sale.taxSummary) : null,
      paymentMethod: sale.paymentMethod,
      amountReceived: sale.amountReceived,
      change: sale.change,
      cashAmount: sale.cashAmount,
      cardAmount: sale.cardAmount,
      cardPaymentReference: sale.cardPaymentReference,
      cashSessionId: sale.cashSessionId,
      cashierId: sale.cashierId,
      customerId: sale.customerId ?? null,
      customerName: sale.customerName ?? null,
      prescriptionJson: sale.prescription ? JSON.stringify(sale.prescription) : null,
      prescriptionRetained: Boolean(sale.prescriptionRetained),
      controlledGroupsJson: JSON.stringify(sale.controlledGroups ?? []),
      billingJson: sale.billing ? JSON.stringify(sale.billing) : null,
      invoiceStatus: sale.invoiceStatus ?? null,
      payloadJson: JSON.stringify(sale.payload),
      // Denormalizados: el corte proyecta la venta y nunca recorre partidas.
      pharmacyTotal: sale.pharmacyTotal ?? sale.total,
      servicesTotal: sale.servicesTotal ?? 0,
      pharmacyCashAmount: sale.pharmacyCashAmount ?? sale.cashAmount ?? 0,
      servicesCashAmount: sale.servicesCashAmount ?? 0,
      commissionTotal: sale.commissionTotal ?? 0,
      pendingPush: true,
      // Primer renglón de la bitácora: quién cobró y cuándo. El estado vive en la
      // venta; la historia, aquí.
      movements: {
        create: [
          {
            type: 'sale',
            userId: sale.cashierId,
            userLabel: sale.cashierLabel ?? null,
          },
        ],
      },
      items: {
        create: sale.items.map((item) => ({
          kind: item.kind ?? 'product',
          productId: (item.kind ?? 'product') === 'product' ? item.productId : null,
          serviceId: item.kind === 'service' ? item.serviceId : null,
          providerId: item.providerId ?? null,
          providerName: item.providerName ?? null,
          commissionRate: item.commissionRate ?? null,
          commissionAmount: item.commissionAmount ?? null,
          productName: item.productName,
          unitPrice: item.unitPrice,
          discountAmount: item.discountAmount,
          quantity: item.quantity,
          subtotal: item.subtotal,
          saleDiscountShare: item.saleDiscountShare ?? null,
          netAmount: item.netAmount ?? null,
          taxesJson: item.taxes ? JSON.stringify(item.taxes) : null,
          promotionId: item.promotionId ?? null,
          promotionName: item.promotionName ?? null,
          promotionDiscount: item.promotionDiscount ?? null,
        })),
      },
    },
    include: { items: true, movements: true },
  });

  // Descuento optimista de stock local: mantiene la búsqueda de ESTA caja
  // consistente entre sync; no evita sobreventa entre dos cajas distintas.
  // `item.productId` es el id LOCAL del producto (el que ve el carrito), no el remoto.
  //
  // `updateMany` y no `update`: devuelve `count: 0` en vez de lanzar P2025 si el
  // producto no existe. Antes esto era un `.catch(() => undefined)` que tragaba
  // cualquier error, y era asimétrico con la reposición del `voidLocal`, que sí
  // reventaba. Las partidas de servicio no entran: no hay stock que mover.
  //
  // En una sola transacción, como ya hacían `voidLocal` y `discard`. Antes era
  // un `await` por partida: en SQLite cada uno es su propia transacción con su
  // propio fsync, así que un carrito de 15 renglones pagaba 15 escrituras a
  // disco en el momento del cobro. Y si el proceso moría a mitad del bucle, el
  // stock quedaba descontado a medias. El orden se conserva: `$transaction` con
  // arreglo ejecuta en secuencia.
  const productItems = productItemsOf(sale.items);
  if (productItems.length) {
    await prisma.$transaction(
      productItems.map((item) =>
        prisma.product.updateMany({
          where: { id: item.productId },
          data: { totalStock: { decrement: item.quantity } },
        }),
      ),
    );
  }

  return toSaleDto(created);
}

/**
 * Anula localmente y repone el stock descontado. Si la venta nunca sincronizó
 * (`remoteId` null), no queda rastro que empujar: se anuló antes de existir en
 * el servidor. Si ya sincronizó, el llamador debe anularla también en el
 * backend (`POST /sales/:id/void`) — esta función solo refleja el resultado local.
 */
async function voidLocal(prisma, localId, voidedBy, voidedByLabel, reason) {
  const sale = await prisma.sale.findUnique({ where: { id: localId }, include: { items: true } });
  if (!sale || sale.voidedAt) {
    return sale ? toSaleDto(sale) : null;
  }

  const voidedAt = new Date();
  const [updated] = await prisma.$transaction([
    prisma.sale.update({
      where: { id: localId },
      data: {
        voidedAt,
        voidedBy,
        // Si ya existe en el servidor, el void remoto puede fallar (sin red) o
        // ni intentarse (lista con `pendingPush`/`remoteId` viejos). Encolar
        // siempre el cierre remoto: el éxito online lo limpia con
        // `markRemoteVoided`.
        ...(sale.remoteId ? { needsRemoteVoid: true } : {}),
        // La anulación se asienta como movimiento propio: el flag dice *que*
        // está anulada, el renglón dice *quién* y *cuándo* —que es lo que se
        // revisa cuando el turno no cuadra.
        movements: {
          create: [{ type: 'void', userId: voidedBy, userLabel: voidedByLabel ?? null, reason: reason ?? null, occurredAt: voidedAt }],
        },
      },
      include: { items: true },
    }),
    // Solo productos, y con `updateMany`: una partida cuyo producto ya no existe
    // en local devolvía P2025 y **abortaba la anulación entera**, dejando la
    // venta viva. Anular nunca puede fallar por un problema de catálogo.
    ...productItemsOf(sale.items).map((item) =>
      prisma.product.updateMany({
        where: { id: item.productId },
        data: { totalStock: { increment: item.quantity } },
      }),
    ),
  ]);

  return toSaleDto(updated);
}

async function list(prisma, filters = {}) {
  const where = {};
  if (filters.cashSessionId) {
    where.cashSessionId = filters.cashSessionId;
  }
  // La SQLite es del **equipo**, no del cajero: sin este filtro el historial
  // mostraba —y con permiso permitía anular— las ventas del turno de otro que
  // usó la misma caja. El admin no lo manda: para auditar necesita verlas todas.
  if (filters.cashierId) {
    where.cashierId = filters.cashierId;
  }
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to) where.createdAt.lte = new Date(filters.to);
  }
  if (filters.includeVoided === false) {
    where.voidedAt = null;
  }

  const rows = await prisma.sale.findMany({
    where,
    include: { items: true },
    orderBy: { createdAt: 'desc' },
  });

  let sales = rows.map(toSaleDto);

  const term = filters.search?.trim().toLowerCase();
  if (term) {
    sales = sales.filter(
      (sale) =>
        sale.folio.toLowerCase().includes(term) ||
        sale.items.some((item) => item.productName.toLowerCase().includes(term)),
    );
  }

  return sales;
}

/**
 * Traduce los `productId` del payload al id que conoce el backend.
 *
 * El payload se congela al cobrar, y si el producto era nuevo todavía no tenía
 * `remoteId`: quedaba grabado el uuid local, que el backend no conoce (404
 * "Producto"). La traducción tiene que pasar **al empujar**, cuando el catálogo
 * ya subió y el producto sí tiene identidad remota.
 *
 * Devuelve `null` si algún producto sigue sin `remoteId`: esa venta no se manda
 * todavía —se queda pendiente, no bloqueada— y sale en el push siguiente, ya
 * con el catálogo sincronizado. Pasado `MAX_RESOLVE_ATTEMPTS`, `getPendingPush`
 * deja de esperar y la manda a revisión manual.
 *
 * Las partidas de servicio se saltan: su `serviceId` ya es el id remoto (el
 * catálogo es solo-pull), así que no hay nada que traducir.
 */
async function resolvePayloadProductIds(prisma, payload, mapaPrecargado = null) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return payload;
  }

  const productItems = productItemsOf(items);
  if (!productItems.length) {
    return payload;
  }

  const remoteByAnyId = mapaPrecargado ?? (await buildRemoteIdMap(prisma, idsDePartidas(items)));

  const resolved = [];
  for (const item of items) {
    if ((item.kind ?? 'product') !== 'product') {
      resolved.push(item);
      continue;
    }
    const remoteId = remoteByAnyId.get(item.productId);
    if (!remoteId) {
      return null;
    }
    resolved.push({ ...item, productId: remoteId });
  }

  return { ...payload, items: resolved };
}

/** Ids de producto de las partidas de producto de un payload (sin repetir). */
function idsDePartidas(items) {
  return [...new Set(productItemsOf(items).map((item) => item.productId).filter(Boolean))];
}

/**
 * Mapa `id local | remoteId → remoteId` para los productos pedidos.
 *
 * Se construye de una vez para TODAS las ventas de la cola en vez de una
 * consulta por venta: tras una caída de red la cola trae cientos de ventas y
 * este `findMany` corría una vez por cada una, en cada horario de sync, casi
 * siempre pidiendo los mismos productos.
 */
async function buildRemoteIdMap(prisma, ids) {
  const remoteByAnyId = new Map();
  if (!ids.length) {
    return remoteByAnyId;
  }
  const products = await prisma.product.findMany({
    where: { OR: [{ id: { in: ids } }, { remoteId: { in: ids } }] },
    select: { id: true, remoteId: true },
  });
  for (const product of products) {
    if (product.remoteId) {
      remoteByAnyId.set(product.id, product.remoteId);
      remoteByAnyId.set(product.remoteId, product.remoteId);
    }
  }
  return remoteByAnyId;
}

/**
 * Parsea los payloads de las filas y precarga de una sola consulta el mapa de
 * ids remotos que necesitan todas ellas.
 */
async function prepararCola(prisma, rows) {
  const payloads = rows.map((row) => JSON.parse(row.payloadJson));
  const ids = [
    ...new Set(payloads.flatMap((payload) => idsDePartidas(payload?.items ?? []))),
  ];
  return { payloads, remoteByAnyId: await buildRemoteIdMap(prisma, ids) };
}

/**
 * Lo que el servidor **rechazó**. Se separa de la cola normal porque no se
 * reintenta solo: alguien tiene que leer el motivo y decidir. Sin esta consulta
 * los rechazos quedaban invisibles —ni pendientes ni avisados— y una venta ya
 * cobrada podía llevar días sin llegar al servidor.
 */
async function listBlocked(prisma) {
  const rows = await prisma.sale.findMany({
    where: { pushError: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  const registros = [];
  for (const row of rows) {
    registros.push({
      kind: 'sale',
      id: row.id,
      label: row.folio ?? row.id,
      detail: `$${Number(row.total ?? 0).toFixed(2)}`,
      occurredAt: row.createdAt,
      reason: row.pushError,
      diagnosis:
        row.pushError === BLOQUEO_POR_INTENTOS
          ? await diagnoseDependency(prisma, row)
          : { code: codeFromReason(row.pushError) },
    });
  }
  return registros;
}

/**
 * Qué le falta **hoy** a una venta bloqueada por intentos. Se mira en vivo, no
 * se guarda: entre el bloqueo y que el cajero abra el panel, el turno o el
 * producto pudieron haber subido (`listo-para-reintentar`).
 */
async function diagnoseDependency(prisma, row) {
  let payload;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    return { code: 'desconocido' };
  }
  const ids = idsDePartidas(payload?.items ?? []);
  const remoteByAnyId = await buildRemoteIdMap(prisma, ids);
  const faltantes = ids.filter((id) => !remoteByAnyId.has(id));
  if (faltantes.length) {
    const productos = await prisma.product.findMany({
      where: { id: { in: faltantes } },
      select: { id: true, name: true, catalogPushError: true },
    });
    if (productos.length < faltantes.length) {
      return { code: 'producto-no-encontrado' };
    }
    const rechazado = productos.find((producto) => producto.catalogPushError);
    const producto = rechazado ?? productos[0];
    return {
      code: rechazado ? 'producto-rechazado' : 'producto-sin-subir',
      dependency: { kind: 'product', label: producto.name ?? 'Producto' },
    };
  }
  const sessionId = payload?.cashSessionId;
  const session = sessionId ? await prisma.cashSession.findUnique({ where: { id: sessionId } }) : null;
  if (session && !session.remoteId) {
    return {
      code: session.pushError ? 'turno-rechazado' : 'turno-sin-subir',
      dependency: { kind: 'cashSession', label: etiquetaTurno(session) },
    };
  }
  return { code: 'listo-para-reintentar' };
}

/** Cómo reconoce el cajero un turno: quién lo abrió y cuándo. */
function etiquetaTurno(session) {
  const abierto = session.openedAt ? new Date(session.openedAt) : null;
  const cuando = abierto
    ? abierto.toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  const quien = session.openedByLabel ?? '';
  return ['Turno', quien && `de ${quien}`, cuando && `abierto el ${cuando}`].filter(Boolean).join(' ');
}

/**
 * Traduce el turno del payload al id que conoce el servidor.
 *
 * La venta se guarda con el id **local** del turno (SQLite), porque al cobrar el
 * turno puede no haber sincronizado todavía. Sin esta traducción el backend
 * buscaba ese uuid, no lo encontraba y respondía "Turno de caja no encontrado":
 * le pasaba a **toda** venta de un turno abierto sin conexión. Es la misma
 * traducción que ya se hacía con los productos, que faltaba aquí.
 *
 * Devuelve `null` si el turno aún no sube: la venta espera al siguiente ciclo en
 * vez de viajar con un id condenado.
 */
async function resolvePayloadCashSession(prisma, payload) {
  const localId = payload?.cashSessionId;
  if (!localId) {
    return payload;
  }
  const session = await prisma.cashSession.findUnique({ where: { id: localId } });
  // Sin fila local, el id ya es remoto (venta de un turno que nació en el
  // servidor): se manda tal cual.
  if (!session) {
    return payload;
  }
  if (!session.remoteId) {
    return null;
  }
  return { ...payload, cashSessionId: session.remoteId };
}

/**
 * ¿Lo que le falta a esta venta va **en camino** o está **atorado**?
 *
 * En camino = el turno o el producto siguen en su propia cola sin rechazo: van a
 * subir en este mismo ciclo o en el siguiente, y la venta solo tiene que
 * esperar. Contar ese intento la condenaba sin motivo: `SyncScheduler.runPush`
 * empuja ventas antes del alta de turnos (paso 2), así que una venta de turno
 * nuevo gastaba un intento en **cada** ciclo aunque todo fuera bien, y con el
 * alta fallando por red cada "sincronizar" gastaba dos. Con tres clics, la
 * venta salía como rechazada sin que el servidor la hubiera visto.
 *
 * Atorado = rechazado, o fuera de toda cola (nunca va a subir solo): ahí sí se
 * cuenta, para que acabe visible en el panel de rechazadas.
 *
 * `cache` evita repetir la consulta del turno: tras una caída de red, cientos de
 * ventas esperan al mismo.
 */
async function dependenciaEnCamino(prisma, payload, conProductos, remoteByAnyId, cache) {
  if (!conProductos) {
    const faltantes = idsDePartidas(payload?.items ?? []).filter((id) => !remoteByAnyId.has(id));
    if (!faltantes.length) {
      return false;
    }
    const productos = await prisma.product.findMany({
      where: { id: { in: faltantes } },
      select: { id: true, pendingCatalogPush: true, catalogPushError: true },
    });
    return (
      productos.length === faltantes.length &&
      productos.every((producto) => producto.pendingCatalogPush && !producto.catalogPushError)
    );
  }
  const sessionId = payload?.cashSessionId;
  if (!sessionId) {
    return false;
  }
  if (!cache.has(sessionId)) {
    const session = await prisma.cashSession.findUnique({ where: { id: sessionId } });
    cache.set(sessionId, Boolean(session?.pendingPush && !session.pushError));
  }
  return cache.get(sessionId);
}

/**
 * Ventas que quedaron bloqueadas con "turno cerrado" no se arreglan
 * reintentando el mismo POST: el Angular las manda a `unreconciled`. Limpiar
 * el `pushError` las vuelve a poner en cola para ese camino (antes quedaban
 * atrapadas para siempre en el badge de rechazados).
 */
async function healClosedShiftBlocks(prisma) {
  const bloqueadas = await prisma.sale.findMany({
    where: { pendingPush: true, pushError: { not: null } },
    select: { id: true, pushError: true },
  });
  for (const fila of bloqueadas) {
    const msg = String(fila.pushError).toLowerCase();
    if (!(msg.includes('turno') && msg.includes('cerrado'))) {
      continue;
    }
    await prisma.sale.update({
      where: { id: fila.id },
      data: { pushError: null },
    });
  }
}

/**
 * Ventas listas para subir.
 *
 * `ownerUid`: solo las de ese cajero (ver `ownerFilter` en cash-sessions).
 *
 * `contarIntentos`: **solo el push real debe pasarlo en `true`**. El contador de
 * `payloadResolveAttempts` existe para que una venta cuyo producto o turno nunca
 * sincronice acabe visible en el panel de rechazadas en vez de quedar invisible
 * para siempre; pero esta misma consulta la usan la barra de pendientes y el
 * conteo del shell, que se refrescan al cobrar, al descartar y al reintentar.
 * Contando ahí, el cupo se gastaba en ~6 refrescos de pantalla en vez de 6
 * ciclos de sync: con el turno todavía sin `remoteId` (caja sin red), a la sexta
 * venta cobrada la primera ya estaba bloqueada y salía de la cola.
 */
async function getPendingPush(prisma, { ownerUid, contarIntentos = false } = {}) {
  await healClosedShiftBlocks(prisma);
  const rows = await prisma.sale.findMany({
    // Una venta anulada que nunca llegó a existir en el servidor va por otro
    // camino (`getPendingVoided`: se crea y se anula, para que quede el rastro
    // completo). Y una venta con `pushError` quedó bloqueada a propósito: no se
    // reintenta sola, solo cuando el cajero la revisa (`clearPushError`).
    where: {
      pendingPush: true,
      pushError: null,
      NOT: { remoteId: null, voidedAt: { not: null } },
      ...(ownerUid ? { cashierId: ownerUid } : {}),
    },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  });

  const { payloads, remoteByAnyId } = await prepararCola(prisma, rows);

  const pending = [];
  const turnosEnCamino = new Map();
  for (const [indice, row] of rows.entries()) {
    const conProductos = await resolvePayloadProductIds(prisma, payloads[indice], remoteByAnyId);
    const payload = conProductos && (await resolvePayloadCashSession(prisma, conProductos));
    if (!payload) {
      // Su producto aún no sube; entra en el push siguiente... pero no para
      // siempre. Antes esto era un `continue` sin memoria: una venta cuyo
      // producto nunca sincronizara quedaba invisible, sin aparecer como
      // pendiente ni como bloqueada, y nadie se enteraba.
      if (!contarIntentos) {
        // Lectura para la UI: no consume cupo, pero **sí** se reporta. Omitirla
        // dejaba a la cajera sin señal alguna: una venta cobrada cuyo turno
        // todavía no sube no salía en la barra de pendientes ni en el conteo,
        // así que el aviso del corte decía "Quedan 1" con dos movimientos sin
        // subir. Solo se hacía visible al agotar los intentos, ya bloqueada.
        // Va sin `payload` a propósito: todavía no se puede enviar.
        pending.push({
          ...toSaleDto(row),
          payload: null,
          esperandoPor: conProductos ? 'turno' : 'catalogo',
        });
        continue;
      }
      if (await dependenciaEnCamino(prisma, payloads[indice], conProductos, remoteByAnyId, turnosEnCamino)) {
        continue;
      }
      const attempts = (row.payloadResolveAttempts ?? 0) + 1;
      await prisma.sale.update({
        where: { id: row.id },
        data:
          attempts >= MAX_RESOLVE_ATTEMPTS
            ? {
                payloadResolveAttempts: attempts,
                pushError: BLOQUEO_POR_INTENTOS,
              }
            : { payloadResolveAttempts: attempts },
      });
      continue;
    }
    if (contarIntentos && row.payloadResolveAttempts) {
      await prisma.sale.update({ where: { id: row.id }, data: { payloadResolveAttempts: 0 } });
    }
    pending.push({ ...toSaleDto(row), payload });
  }
  return pending;
}

/**
 * Ventas anuladas que **nunca** llegaron al servidor. Se crean y se anulan allá
 * en dos pasos, para que el movimiento exista completo: la venta, su anulación,
 * el contra-asiento del libro de control y la auditoría. Sin esto, el backend no
 * se entera de que esa venta ocurrió.
 */
async function getPendingVoided(prisma) {
  const rows = await prisma.sale.findMany({
    where: { pendingPush: true, pushError: null, remoteId: null, voidedAt: { not: null } },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  });

  const { payloads, remoteByAnyId } = await prepararCola(prisma, rows);

  const pending = [];
  for (const [indice, row] of rows.entries()) {
    const conProductos = await resolvePayloadProductIds(prisma, payloads[indice], remoteByAnyId);
    // Misma traducción de turno que en `getPendingPush`: esta ruta también manda
    // la venta al servidor (la crea y la anula), así que sin esto viajaba con el
    // id local del turno y moría igual con "Turno de caja no encontrado".
    const payload = conProductos && (await resolvePayloadCashSession(prisma, conProductos));
    if (!payload) {
      continue;
    }
    pending.push({
      ...toSaleDto(row),
      payload,
      voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
      voidedBy: row.voidedBy ?? null,
    });
  }
  return pending;
}

async function markSynced(prisma, localId, remoteId, remoteFolio) {
  const current = await prisma.sale.findUnique({ where: { id: localId }, select: { voidedAt: true } });
  if (current?.voidedAt) {
    // El cajero anuló esta venta en local mientras el push ya estaba en vuelo:
    // el servidor la acaba de crear como ACTIVA. No se puede dar por
    // sincronizada sin más —quedaría viva en el backend sin que nadie se
    // entere—, así que se guarda el remoteId y se marca para un
    // `POST /sales/:id/void` remoto explícito en el próximo sync.
    await prisma.sale.update({
      where: { id: localId },
      data: { remoteId, remoteFolio, pushError: null, pendingPush: false, needsRemoteVoid: true },
    });
    return;
  }
  await prisma.sale.update({
    where: { id: localId },
    data: { remoteId, remoteFolio, folio: remoteFolio, pendingPush: false, pushError: null },
  });
}

/**
 * La venta quedó guardada en `unreconciledSales` del servidor: sale de la cola
 * de push —insistir no la va a registrar— pero conserva el motivo para que el
 * historial pueda explicarla.
 */
async function markUnreconciled(prisma, localId, reason) {
  await prisma.sale.update({
    where: { id: localId },
    data: {
      unreconciledAt: new Date(),
      unreconciledReason: reason,
      pendingPush: false,
      pushError: null,
    },
  });
}

async function markPushFailed(prisma, localId, message) {
  await prisma.sale.update({ where: { id: localId }, data: { pushError: message } });
}

/** Ventas ya sincronizadas que se anularon en local durante la carrera de `markSynced`. */
async function getNeedingRemoteVoid(prisma) {
  const rows = await prisma.sale.findMany({
    where: { needsRemoteVoid: true, remoteId: { not: null } },
    // El instante y el cajero de **entonces**: el backend los usa para no sellar
    // la anulación con la hora del sync ni a nombre de quien sincronizó.
    select: { id: true, remoteId: true, voidedAt: true, voidedBy: true },
  });
  return rows.map((row) => ({
    id: row.id,
    remoteId: row.remoteId,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedBy: row.voidedBy ?? null,
  }));
}

/**
 * Marca una venta **ya sincronizada** para anularse también en el servidor en el
 * próximo sync. Es el camino de la anulación sin red: en local ya quedó anulada
 * y el stock repuesto, pero el backend todavía la tiene activa.
 *
 * `updateMany` con `remoteId: { not: null }` en vez de `update`: si la venta
 * nunca sincronizó no hay nada que anular allá, y marcarla dejaría a
 * `reconcileRemoteVoids` girando contra un id inexistente.
 */
/** Bitácora de una venta, del movimiento más viejo al más nuevo. */
async function listMovements(prisma, saleId) {
  const rows = await prisma.saleMovement.findMany({
    where: { saleId },
    orderBy: { occurredAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    saleId: row.saleId,
    type: row.type,
    userId: row.userId,
    userLabel: row.userLabel ?? null,
    reason: row.reason ?? null,
    occurredAt: row.occurredAt.toISOString(),
  }));
}

async function markNeedsRemoteVoid(prisma, localId) {
  await prisma.sale.updateMany({
    where: { id: localId, remoteId: { not: null } },
    data: { needsRemoteVoid: true },
  });
}

async function markRemoteVoided(prisma, localId) {
  await prisma.sale.update({ where: { id: localId }, data: { needsRemoteVoid: false } });
}

/**
 * Una sola vez (ver `client.js`): reencola voids que quedaron solo en local
 * porque la UI anuló con `pendingPush` viejo sin mirar el `remoteId` ya
 * guardado. El sync siguiente hace `POST /void`; si allá ya estaba anulada,
 * cuenta como éxito.
 */
async function requeueOrphanRemoteVoids(prisma) {
  await prisma.sale.updateMany({
    where: {
      voidedAt: { not: null },
      remoteId: { not: null },
      needsRemoteVoid: false,
    },
    data: { needsRemoteVoid: true },
  });
}

/**
 * Reintentar de verdad: además del error, repone el cupo de intentos. Sin esto,
 * una venta bloqueada por "su turno o su producto no sincroniza" volvía a
 * bloquearse en el primer push siguiente, porque el contador seguía en el tope.
 */
async function clearPushError(prisma, localId) {
  await prisma.sale.update({
    where: { id: localId },
    data: { pushError: null, payloadResolveAttempts: 0 },
  });
}

/** Descarta una venta que el servidor rechazó (nunca sincronizó): repone stock y borra. */
async function discard(prisma, localId) {
  const sale = await prisma.sale.findUnique({ where: { id: localId }, include: { items: true } });
  if (!sale) {
    return;
  }
  await prisma.$transaction([
    ...productItemsOf(sale.items).map((item) =>
      prisma.product.updateMany({
        where: { id: item.productId },
        data: { totalStock: { increment: item.quantity } },
      }),
    ),
    prisma.sale.delete({ where: { id: localId } }),
  ]);
}

module.exports = {
  createLocal,
  list,
  voidLocal,
  getPendingPush,
  listBlocked,
  getPendingVoided,
  markSynced,
  markPushFailed,
  markUnreconciled,
  clearPushError,
  discard,
  toSaleDto,
  getNeedingRemoteVoid,
  listMovements,
  markNeedsRemoteVoid,
  markRemoteVoided,
  requeueOrphanRemoteVoids,
};
