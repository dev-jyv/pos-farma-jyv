const { randomUUID } = require('node:crypto');
const { toDate } = require('./timestamps');
const { diagnoseReason } = require('./blocked-diagnosis');
const { appendSafe } = require('./sync-log');
const { isExpiredLocal } = require('./expiry');

/** Forma que consume el POS (búsqueda/carrito), igual a `shared/models`' `Product`. */
function toProductDto(row) {
  return {
    id: row.id,
    remoteId: row.remoteId ?? null,
    name: row.name,
    activeIngredient: row.activeIngredient ?? undefined,
    concentration: row.concentration ?? undefined,
    sku: row.sku,
    barcode: row.barcode ?? undefined,
    salePrice: row.salePrice,
    stock: Math.max(0, row.totalStock ?? 0),
    requiresPrescription: row.requiresPrescription,
    controlledGroup: row.controlledGroup ?? undefined,
    hasIva: row.hasIva,
    hasIvaZero: row.hasIvaZero,
    hasIeps: row.hasIeps,
    iepsRate: row.iepsRate ?? undefined,
    categoryId: row.categoryId ?? undefined,
    unit: row.unit ?? undefined,
    minStock: row.minStock,
    isActive: row.isActive,
    // Venta por caja (SPEC 46). Solo se exponen si están los dos: una caja sin
    // precio (o sin piezas) no se puede cobrar.
    ...boxFieldsOf(row),
  };
}

/** Piezas por caja válidas: entero 2..1000, igual que la validación del backend. */
function isValidBoxQuantity(value) {
  return Number.isInteger(value) && value >= 2 && value <= 1000;
}

function boxFieldsOf(row) {
  const ok = isValidBoxQuantity(row.boxQuantity) && typeof row.boxPrice === 'number' && row.boxPrice > 0;
  return {
    boxQuantity: ok ? row.boxQuantity : null,
    boxPrice: ok ? row.boxPrice : null,
    boxBarcode: row.boxBarcode ?? null,
  };
}

function productFieldsData(fields) {
  const data = {};
  if (fields.sku !== undefined) data.sku = fields.sku;
  if (fields.barcode !== undefined) data.barcode = fields.barcode ?? null;
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.activeIngredient !== undefined) data.activeIngredient = fields.activeIngredient ?? null;
  if (fields.concentration !== undefined) data.concentration = fields.concentration ?? null;
  if (fields.categoryId !== undefined) data.categoryId = fields.categoryId ?? null;
  if (fields.unit !== undefined) data.unit = fields.unit ?? null;
  if (fields.salePrice !== undefined) data.salePrice = fields.salePrice;
  if (fields.minStock !== undefined) data.minStock = fields.minStock;
  if (fields.hasIva !== undefined) data.hasIva = Boolean(fields.hasIva);
  if (fields.hasIvaZero !== undefined) data.hasIvaZero = Boolean(fields.hasIvaZero);
  if (fields.hasIeps !== undefined) data.hasIeps = Boolean(fields.hasIeps);
  if (fields.iepsRate !== undefined) data.iepsRate = fields.iepsRate ?? null;
  if (fields.controlledGroup !== undefined) data.controlledGroup = fields.controlledGroup ?? null;
  if (fields.requiresPrescription !== undefined) {
    data.requiresPrescription = Boolean(fields.requiresPrescription);
  }
  if (fields.isActive !== undefined) data.isActive = Boolean(fields.isActive);
  return data;
}

/**
 * El renderer puede mandar el id local de SQLite o el `remoteId` de Firestore
 * (según de dónde saque el producto): se resuelve por cualquiera de los dos
 * antes de escribir. Mismo bug real que ya rompió `recordStockEntry` con
 * "Record to update not found" — centralizado aquí para no repetirlo.
 */
async function resolveLocalProductId(prisma, idOrRemoteId) {
  const local = await prisma.product.findFirst({
    where: { OR: [{ id: idOrRemoteId }, { remoteId: idOrRemoteId }] },
  });
  if (!local) {
    throw new Error(`No se encontró el producto local para "${idOrRemoteId}"`);
  }
  return local.id;
}

/**
 * Nombre comparable. El servidor no admite dos productos con el mismo nombre:
 * un alta local repetida nunca sube y se queda rechazada en la cola para
 * siempre. Se compara sin mayúsculas ni espacios de más.
 */
function normalizeProductName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Nombre sugerido para desempatar: el nombre más el código de barras (o el SKU). */
function suggestProductName(fields) {
  const base = String(fields.name ?? '').trim().replace(/\s+/g, ' ');
  const suffix = String(fields.barcode ?? '').trim() || String(fields.sku ?? '').trim();
  return suffix ? `${base} ${suffix}` : base;
}

/**
 * Productos del catálogo local, activos o no (el servidor también cuenta los
 * inactivos), con el mismo nombre. `excludeId` deja fuera al propio producto
 * cuando se edita.
 */
async function findByName(prisma, name, excludeId = null) {
  const target = normalizeProductName(name);
  if (!target) {
    return [];
  }
  const rows = await prisma.product.findMany({
    where: { name: { contains: String(name).trim().split(/\s+/)[0] } },
  });
  return rows
    .filter((row) => normalizeProductName(row.name) === target)
    .filter((row) => !excludeId || (row.id !== excludeId && row.remoteId !== excludeId))
    .map(toProductDto);
}

/** Mensaje del alta rechazada por nombre repetido, con el nombre que se propone. */
function duplicateNameMessage(fields, existing) {
  const sku = String(fields.sku ?? '').trim();
  if (sku && sku.toLowerCase() === String(existing.sku ?? '').trim().toLowerCase()) {
    return `"${existing.name}" ya está en el catálogo con el SKU ${existing.sku}: ` +
      'búscalo y selecciónalo en lugar de darlo de alta.';
  }
  return `Ya existe "${existing.name}" con otro SKU (${existing.sku}). ` +
    `Usa otro nombre, por ejemplo "${suggestProductName(fields)}".`;
}

async function assertNameAvailable(prisma, fields, excludeId = null) {
  const [existing] = await findByName(prisma, fields.name, excludeId);
  if (existing) {
    throw new Error(duplicateNameMessage(fields, existing));
  }
}

async function search(prisma, term) {
  const normalized = term?.trim() ?? '';
  const where = normalized
    ? {
        isActive: true,
        OR: [
          { name: { contains: normalized } },
          { sku: { contains: normalized } },
          { barcode: { contains: normalized } },
          { boxBarcode: { contains: normalized } },
          { activeIngredient: { contains: normalized } },
        ],
      }
    : { isActive: true };

  const rows = await prisma.product.findMany({ where, orderBy: { name: 'asc' }, take: 25 });
  return rows.map(toProductDto);
}

/** Productos por id local, para refrescar precio y stock de un ticket guardado. */
async function getByIds(prisma, ids) {
  const lista = [...new Set((ids ?? []).filter(Boolean))];
  if (!lista.length) {
    return [];
  }
  const rows = await prisma.product.findMany({ where: { id: { in: lista } } });
  return rows.map(toProductDto);
}

async function getByBarcode(prisma, code) {
  const normalized = code?.trim();
  if (!normalized) {
    return null;
  }
  const row = await prisma.product.findFirst({
    where: { isActive: true, OR: [{ barcode: normalized }, { sku: normalized }] },
  });
  if (row) {
    return toProductDto(row);
  }
  // El código de la caja (SPEC 46) va después: el de la pieza y el SKU siempre
  // ganan. Solo cuenta si el producto de verdad se vende por caja; si no, el
  // escaneo diría "caja" de algo que no se puede cobrar así.
  const box = await prisma.product.findFirst({
    where: { isActive: true, boxBarcode: normalized },
  });
  if (!box) {
    return null;
  }
  const dto = toProductDto(box);
  return dto.boxQuantity ? { ...dto, saleUnit: 'box' } : dto;
}

/**
 * Local-first de `POST /stock-entries`: mismo payload (`product` para alta,
 * `productId`+`productUpdate` para uno existente, `lotNumber`/`expiryDate`/
 * `quantity`/`costPrice`/`invoiceId`). El payload completo se guarda en el
 * lote para reenviarlo tal cual al sincronizar; el backend es quien valida y
 * asigna los ids reales.
 */
async function recordStockEntry(prisma, payload) {
  // Producto + lote + stock en una transacción: un corte a medias dejaba un
  // producto alta sin lote, o un lote sin sumar al stock.
  // Si ya viene dentro de una transacción (facturas-RAG), no se anida otra.
  if (typeof prisma.$transaction !== 'function') {
    return recordStockEntryTx(prisma, payload);
  }
  return prisma.$transaction((tx) => recordStockEntryTx(tx, payload));
}

async function recordStockEntryTx(prisma, payload) {
  let productId = payload.productId ?? null;

  if (productId) {
    // `payload.productId` viaja con el id de Firestore (`remoteId`) cuando el
    // producto ya sincronizó alguna vez — el renderer lo arma así porque es lo
    // que necesita el `POST /stock-entries` real al hacer push. Aquí, para
    // escribir en SQLite, hace falta el id LOCAL.
    productId = await resolveLocalProductId(prisma, productId);
  }

  if (payload.product) {
    await assertNameAvailable(prisma, payload.product);
    const created = await prisma.product.create({
      data: {
        ...productFieldsData(payload.product),
        isActive: true,
        pendingPush: true,
      },
    });
    productId = created.id;
  } else if (productId && payload.productUpdate) {
    await prisma.product.update({
      where: { id: productId },
      data: { ...productFieldsData(payload.productUpdate), pendingPush: true },
    });
  }

  if (!productId) {
    throw new Error('recordStockEntry requiere `product` o `productId`');
  }

  await prisma.batch.create({
    data: {
      productId,
      lotNumber: payload.lotNumber ?? null,
      expiryDate: payload.expiryDate ? new Date(payload.expiryDate) : null,
      quantity: payload.quantity,
      pendingPush: true,
      payloadJson: JSON.stringify(payload),
    },
  });

  const updatedProduct = await prisma.product.update({
    where: { id: productId },
    data: { totalStock: { increment: payload.quantity } },
  });

  return { product: toProductDto(updatedProduct), stock: updatedProduct.totalStock };
}

/**
 * Unidades que el servidor todavía no descuenta de cada producto: ventas sin
 * subir (incluidas las bloqueadas) menos las que se anularon en local pero siguen
 * vivas allá, más la mercancía de entradas de stock sin subir. `db` es el cliente
 * o la transacción. Con esto el pull no pisa el stock local con una foto del
 * servidor que no incluye lo recién vendido o recibido.
 */
async function pendingStockDelta(db, localProductId) {
  const sold = await db.saleItem.findMany({
    where: {
      productId: localProductId,
      kind: 'product',
      sale: { pendingPush: true, voidedAt: null },
    },
    select: { quantity: true },
  });
  const voidedPending = await db.saleItem.findMany({
    where: {
      productId: localProductId,
      kind: 'product',
      sale: { needsRemoteVoid: true, remoteId: { not: null } },
    },
    select: { quantity: true },
  });
  const entries = await db.batch.findMany({
    where: { productId: localProductId, pendingPush: true },
    select: { quantity: true },
  });
  const sum = (rows) => rows.reduce((total, row) => total + row.quantity, 0);
  return { sold: sum(sold) - sum(voidedPending), entries: sum(entries) };
}

/**
 * Campos de catálogo que un pull escribe y una edición local sube. Son los que
 * protege una edición pendiente (SPEC 56): el pull no los toca en esa fila.
 */
function remoteCatalogData(remote) {
  return {
    sku: remote.sku,
    barcode: remote.barcode ?? null,
    name: remote.name,
    activeIngredient: remote.activeIngredient ?? null,
    concentration: remote.concentration ?? null,
    categoryId: remote.categoryId ?? null,
    unit: remote.unit ?? null,
    salePrice: remote.salePrice,
    minStock: remote.minStock ?? 0,
    hasIva: Boolean(remote.hasIva),
    hasIvaZero: Boolean(remote.hasIvaZero),
    hasIeps: Boolean(remote.hasIeps),
    iepsRate: remote.iepsRate ?? null,
    controlledGroup: remote.controlledGroup ?? null,
    requiresPrescription: Boolean(remote.requiresPrescription),
    isActive: remote.isActive !== false,
    // Venta por caja (SPEC 46). Un backend anterior no los manda: quedan en
    // null y el producto se vende solo por pieza, como siempre.
    boxQuantity: isValidBoxQuantity(remote.boxQuantity) ? remote.boxQuantity : null,
    boxPrice: typeof remote.boxPrice === 'number' && remote.boxPrice > 0 ? remote.boxPrice : null,
    boxBarcode: typeof remote.boxBarcode === 'string' && remote.boxBarcode.trim() ? remote.boxBarcode.trim() : null,
    // `suppliers` no se escribe: nada en la caja lo lee (`toProductDto` no lo
    // expone) y serializarlo por producto en cada pull era peso muerto. Por eso
    // `GET /products/sync` tampoco lo manda.
  };
}

/** Columnas de catálogo de `Product` (las de `remoteCatalogData`). */
const CATALOG_COLUMNS = Object.keys(remoteCatalogData({}));

/**
 * ¿La fila tiene una edición de catálogo que todavía no sube? Una edición desde
 * Productos (`pendingCatalogPush`) o una entrada de stock pendiente que trae
 * `productUpdate` (corrección de precio, código…). En ambos casos el pull no
 * debe pisar sus campos de catálogo: la edición se perdía sin aviso y el push
 * siguiente subía la fila ya pisada (SPEC 56, C2).
 */
async function hasPendingCatalogEdit(db, row) {
  if (row.pendingCatalogPush) {
    return true;
  }
  const entries = await db.batch.findMany({
    where: { productId: row.id, pendingPush: true, payloadJson: { not: null } },
    select: { payloadJson: true },
  });
  return entries.some((entry) => {
    try {
      const update = JSON.parse(entry.payloadJson)?.productUpdate;
      return Boolean(update) && typeof update === 'object' && Object.keys(update).length > 0;
    } catch {
      return false;
    }
  });
}

/** El más nuevo de dos `updatedAt` remotos (cualquiera puede faltar). */
function newestDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Upsert por `remoteId`: usado por el pull periódico desde `GET /products/sync`.
 *
 * - Fila sin edición pendiente: el servidor manda. Se guardan sus campos, la
 *   foto `baseFields` (lo que el PATCH compara después) y `remoteUpdatedAt`.
 * - Fila con edición pendiente (SPEC 56): solo stock, lotes y
 *   `remoteUpdatedAt`. Los campos de catálogo y la foto se quedan como estaban:
 *   el PATCH manda la diferencia contra esa foto vieja con su `baseUpdatedAt`, y
 *   el servidor avisa con 409 si el precio o el estado cambiaron en el panel.
 *
 * El upsert es idempotente: el cursor se traslapa (`serverTime − 120 s`) y el
 * mismo producto puede llegar en dos pulls seguidos sin efecto alguno.
 */
async function upsertMany(prisma, remoteProducts) {
  for (const remote of remoteProducts) {
    const catalog = remoteCatalogData(remote);
    const remoteUpdatedAt = toDate(remote.updatedAt);
    let totalStock = remote.stock ?? remote.totalStock ?? 0;
    // Producto + sus lotes en una sola transacción: si el proceso se interrumpe
    // a media pasada, este producto no queda con el catálogo actualizado pero
    // los lotes viejos borrados a medias (o viceversa). El cursor de sync solo
    // avanza si `upsertMany` completa sin lanzar, así que un producto fallido
    // se reintenta entero en el siguiente pull.
    await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { remoteId: remote.id } });
      let product;
      if (existing) {
        const { sold, entries } = await pendingStockDelta(tx, existing.id);
        totalStock = Math.max(0, totalStock + entries - sold);
        const stamp = newestDate(existing.remoteUpdatedAt ?? null, remoteUpdatedAt);
        if (await hasPendingCatalogEdit(tx, existing)) {
          product = await tx.product.update({
            where: { id: existing.id },
            data: { totalStock, ...(stamp ? { remoteUpdatedAt: stamp } : {}) },
          });
        } else {
          product = await tx.product.update({
            where: { id: existing.id },
            data: {
              ...catalog,
              totalStock,
              baseFields: serializeBase(remoteUpdatedAt, catalogFieldsOf(catalog)),
              remoteUpdatedAt: stamp,
              catalogConflict: null,
            },
          });
        }
      } else {
        product = await tx.product.create({
          data: {
            ...catalog,
            totalStock,
            remoteId: remote.id,
            pendingPush: false,
            baseFields: serializeBase(remoteUpdatedAt, catalogFieldsOf(catalog)),
            remoteUpdatedAt,
          },
        });
      }

      if (Array.isArray(remote.batches)) {
        await replaceSyncedBatches(tx, product.id, remote.batches);
      }
    });
  }
  return { count: remoteProducts.length };
}

/**
 * Los lotes remotos son la foto autoritativa del producto: se reemplazan
 * completos. `POST /stock-entries` no devuelve el id del lote creado, así que un
 * lote local ya sincronizado se queda con `remoteId: null` — filtrar solo por
 * `remoteId` lo duplicaría en cuanto ese mismo lote vuelva por el pull. Lo que de
 * verdad distingue "ya no hay nada que reemplazar en local" es
 * `pendingPush: false`; un lote todavía `pendingPush: true` sigue esperando su
 * propio push y no se toca.
 */
async function replaceSyncedBatches(tx, localProductId, remoteBatches) {
  await tx.batch.deleteMany({ where: { productId: localProductId, pendingPush: false } });
  if (remoteBatches.length) {
    await tx.batch.createMany({
      data: remoteBatches.map((batch) => ({
        remoteId: batch.id,
        productId: localProductId,
        lotNumber: batch.lotNumber ?? null,
        expiryDate: toDate(batch.expiryDate),
        quantity: batch.quantity,
        pendingPush: false,
      })),
    });
  }
}

/**
 * Existencia fresca de **un** producto (SPEC 57): la respuesta de
 * `GET /products/:id/stock` que el renderer pidió antes de negar una venta por
 * stock local insuficiente. Solo toca stock y lotes —nunca el catálogo ni
 * `remoteUpdatedAt`: la foto de SPEC 56 y el cursor del pull siguen siendo del
 * pull—, con la misma regla que el pull: gana el servidor más lo pendiente
 * (`pendingStockDelta`), también cuando el servidor trae menos que la copia local.
 *
 * Devuelve el producto y sus lotes ya con lo pendiente descontado, o `null` si el
 * producto no está en la caja (o la respuesta no sirve): la venta se niega igual.
 */
async function refreshOne(prisma, remoteId, snapshot) {
  if (!remoteId || !snapshot || typeof snapshot !== 'object') {
    return null;
  }
  const remoteStock = Number(snapshot.totalStock ?? snapshot.stock);
  if (!Number.isFinite(remoteStock)) {
    return null;
  }
  return prisma.$transaction(async (tx) => {
    const existing = await tx.product.findUnique({ where: { remoteId } });
    if (!existing) {
      return null;
    }
    const { sold, entries } = await pendingStockDelta(tx, existing.id);
    const totalStock = Math.max(0, remoteStock + entries - sold);
    const updated = await tx.product.update({
      where: { id: existing.id },
      data: { totalStock },
    });
    if (Array.isArray(snapshot.batches)) {
      await replaceSyncedBatches(tx, existing.id, snapshot.batches);
    }
    return {
      product: toProductDto(updated),
      batches: await getBatchesByProduct(tx, existing.id),
    };
  });
}

/** Lotes de un producto (local + ya sincronizados), para caducidad/FEFO al agregar al carrito. */
async function getBatchesByProduct(prisma, productId) {
  const rows = await prisma.batch.findMany({ where: { productId } });
  // Más próximo a vencer primero; los lotes sin caducidad al final (FEFO).
  rows.sort((a, b) => {
    if (!a.expiryDate && !b.expiryDate) return 0;
    if (!a.expiryDate) return 1;
    if (!b.expiryDate) return -1;
    return a.expiryDate.getTime() - b.expiryDate.getTime();
  });
  // La venta local solo baja `totalStock`; los lotes se refrescan en el pull. Sin
  // esto, una segunda venta pasaba la validación de lote con unidades que ya se
  // habían vendido. Lo pendiente de subir se descuenta de los lotes vigentes
  // (los vencidos no se consumen), igual que lo hará el servidor.
  let toConsume = Math.max(0, (await pendingStockDelta(prisma, productId)).sold);
  // Caducidad por día de México (SPEC 57): el lote que caduca hoy se vende hoy.
  const now = new Date();
  return rows.map((row) => {
    let quantity = row.quantity;
    const vencido = isExpiredLocal(row.expiryDate, now);
    if (!vencido && toConsume > 0 && !row.pendingPush) {
      const taken = Math.min(quantity, toConsume);
      quantity -= taken;
      toConsume -= taken;
    }
    return {
      id: row.id,
      productId: row.productId,
      lotNumber: row.lotNumber ?? '',
      expiryDate: row.expiryDate,
      quantity,
    };
  });
}

/**
 * Mensaje con que el backend rechaza una entrada cuyo `productId` no existe. Lo
 * dejó la versión que congelaba el id LOCAL en el payload: esos lotes quedaron
 * bloqueados aunque el producto ya subió.
 */
const PRODUCTO_NO_ENCONTRADO = 'Producto no encontrado';

/**
 * Entradas de stock listas para subir. El `productId` del payload se resuelve
 * **aquí**, al subir, contra el `remoteId` actual del producto (igual que las
 * ventas con `resolvePayloadProductIds`): al grabar la entrada el producto
 * puede no haber subido aún y el payload solo lleva su UUID local, que el
 * servidor no conoce (404 "Producto no encontrado" y stock solo en la caja).
 *
 * - Producto sin `remoteId` y sin `product` embebido: la entrada espera; sube
 *   cuando el catálogo suba al producto (el push va primero). Con `includeWaiting`
 *   también se devuelve (sin resolver) para contarla como pendiente.
 * - Con `product` embebido el alta viaja en la propia entrada: se envía tal cual,
 *   salvo que el producto ya tenga `remoteId` (SPEC 55): entonces va con
 *   `productId` y sin `product`.
 * - Un lote bloqueado por "Producto no encontrado" se reintenta una sola vez si
 *   ahora hay un `remoteId` distinto del que mandó; si ya iba con el correcto,
 *   el 404 es otro problema y no se reintenta en bucle.
 */
async function getPendingStockEntries(prisma, { includeWaiting = false } = {}) {
  const rows = await prisma.batch.findMany({
    // Igual que `getPendingPush` de ventas: un lote con `pushError` ya quedó
    // bloqueado a propósito y no debe reintentarse solo en cada horario fijo.
    where: {
      pendingPush: true,
      payloadJson: { not: null },
      OR: [{ pushError: null }, { pushError: PRODUCTO_NO_ENCONTRADO }],
    },
    orderBy: { createdAt: 'asc' },
    include: { product: { select: { remoteId: true } } },
  });

  const listos = [];
  for (const row of rows) {
    let payload = JSON.parse(row.payloadJson);
    const remoteId = row.product?.remoteId ?? null;

    if (!payload.product) {
      if (!remoteId) {
        // Espera a que suba su producto: no se envía, pero el aviso de pendientes
        // debe contarla (`includeWaiting`), o quedaría invisible: ni pendiente ni rechazada.
        if (includeWaiting && !row.pushError) {
          listos.push({ id: row.id, productId: row.productId, payload, pushError: null });
        }
        continue;
      }
      if (row.pushError && payload.productId === remoteId) {
        continue;
      }
      if (payload.productId !== remoteId) {
        // Se guarda el id ya resuelto: así el siguiente rechazo con este mismo
        // id se reconoce como otro problema y no se reintenta en bucle.
        payload.productId = remoteId;
        if (row.pushError) {
          // El 404 dejó la llave de idempotencia (el id del lote) reservada en
          // el backend: reenviarla da 409 "quedó a medio registrar". Un 404 no
          // registró nada, así que se reintenta con una llave nueva.
          payload.idempotencyKey = randomUUID();
        }
        await prisma.batch.update({
          where: { id: row.id },
          data: { payloadJson: JSON.stringify(payload) },
        });
      }
    } else if (row.pushError) {
      continue;
    } else if (remoteId) {
      // El producto ya existe en el servidor (lo subió el catálogo, otra
      // entrada o un enlace por el pull): reenviar el alta embebida chocaba con
      // su propio SKU (409) y la entrada se quedaba atorada (SPEC 55, B5). Va
      // como entrada de un producto existente. Se guarda resuelto para que el
      // siguiente intento no vuelva a decidirlo; la llave de idempotencia no
      // cambia: si un intento anterior sí se aplicó, el servidor lo reconoce.
      const { product: _altaEmbebida, ...resto } = payload;
      payload = { ...resto, productId: remoteId };
      await prisma.batch.update({
        where: { id: row.id },
        data: { payloadJson: JSON.stringify(payload) },
      });
    }

    listos.push({
      id: row.id,
      productId: row.productId,
      payload,
      pushError: row.pushError ?? null,
    });
  }
  return listos;
}

async function markStockEntrySynced(prisma, batchLocalId, remoteProductId) {
  await inTransaction(prisma, async (tx) => {
    const batch = await tx.batch.update({
      where: { id: batchLocalId },
      data: { pendingPush: false, pushError: null },
    });
    if (remoteProductId) {
      const local = await tx.product.findUnique({ where: { id: batch.productId } });
      await linkRemoteId(tx, batch.productId, remoteProductId, {
        preferLocalCatalog: Boolean(local) && (await hasPendingCatalogEdit(tx, local)),
        reason: 'entrada de stock',
      });
      await tx.product.update({
        where: { id: batch.productId },
        data: { pendingPush: false, pushError: null },
      });
    }
  });
}

/** Corre `fn` en una transacción, salvo que `prisma` ya sea una (no se anidan). */
function inTransaction(prisma, fn) {
  return typeof prisma.$transaction === 'function' ? prisma.$transaction(fn) : fn(prisma);
}

/**
 * Enlaza la fila local `localId` con el producto remoto `remoteId` (SPEC 56, B6).
 *
 * Si el pull ya había creado **otra** fila con ese `remoteId` (bajó el producto
 * antes de que esta caja confirmara su alta), `remoteId @unique` hacía fallar el
 * enlace: quedaban dos productos locales, el stock contado doble y las ventas
 * del id local esperando para siempre. Aquí se fusionan, dentro de la misma
 * transacción que el enlace:
 *
 * - las partidas de venta y los lotes de la fila del pull pasan a la local, que
 *   es la que conocen las ventas y entradas ya capturadas;
 * - los lotes ya subidos de la local se sustituyen por la foto del servidor que
 *   trajo el pull (si trajo lotes), como haría un pull normal;
 * - el stock es el del servidor (el de la fila del pull sin lo pendiente que ya
 *   llevaba) más todo lo que la fila fusionada tiene pendiente de subir;
 * - el catálogo es el del servidor, salvo que la local tenga una edición
 *   pendiente (`preferLocalCatalog`), que se conserva para subirla;
 * - se borra la fila del pull y queda un renglón en `SyncLog`.
 *
 * Devuelve `true` si fusionó.
 */
async function linkRemoteId(tx, localId, remoteId, { preferLocalCatalog = false, reason = 'enlace' } = {}) {
  const other = await tx.product.findUnique({ where: { remoteId } });
  if (!other || other.id === localId) {
    await tx.product.update({ where: { id: localId }, data: { remoteId } });
    return false;
  }
  const local = await tx.product.findUnique({ where: { id: localId } });
  if (!local) {
    // La fila local ya no existe: la del pull es la buena, no hay nada que fusionar.
    return false;
  }

  // Stock del servidor según el pull: lo que tenía la fila menos lo pendiente
  // que esa fila ya llevaba sumado o restado.
  const pendingOfOther = await pendingStockDelta(tx, other.id);
  const serverStock = (other.totalStock ?? 0) - (pendingOfOther.entries - pendingOfOther.sold);

  await tx.saleItem.updateMany({ where: { productId: other.id }, data: { productId: localId } });
  const otherBatches = await tx.batch.count({ where: { productId: other.id } });
  if (otherBatches > 0) {
    await tx.batch.deleteMany({ where: { productId: localId, pendingPush: false } });
  }
  await tx.batch.updateMany({ where: { productId: other.id }, data: { productId: localId } });
  await tx.product.delete({ where: { id: other.id } });

  const { sold, entries } = await pendingStockDelta(tx, localId);
  const catalog = {};
  if (!preferLocalCatalog) {
    for (const column of CATALOG_COLUMNS) {
      catalog[column] = other[column] ?? null;
    }
    catalog.isActive = other.isActive !== false;
    catalog.minStock = other.minStock ?? 0;
    catalog.hasIva = Boolean(other.hasIva);
    catalog.hasIvaZero = Boolean(other.hasIvaZero);
    catalog.hasIeps = Boolean(other.hasIeps);
    catalog.requiresPrescription = Boolean(other.requiresPrescription);
  }
  await tx.product.update({
    where: { id: localId },
    data: {
      ...catalog,
      remoteId,
      totalStock: Math.max(0, serverStock + entries - sold),
      baseFields: other.baseFields ?? local.baseFields ?? null,
      remoteUpdatedAt: newestDate(local.remoteUpdatedAt ?? null, other.remoteUpdatedAt ?? null),
    },
  });
  await appendSafe(tx, {
    level: 'warn',
    entity: 'product',
    ref: localId,
    message:
      `Fusión de producto duplicado (${reason}): la fila ${other.id} del pull ` +
      `con remoteId ${remoteId} se unió a la local ${localId} "${local.name}".`,
  });
  return true;
}

async function markStockEntryPushFailed(prisma, batchLocalId, message) {
  await prisma.batch.update({ where: { id: batchLocalId }, data: { pushError: message } });
}

/**
 * Lotes que el servidor rechazó, para el panel "Rechazados al sincronizar".
 * No eran ni pendientes (`getPendingStockEntries` excluye los que tienen
 * `pushError`) ni rechazados a la vista: el stock quedaba solo en la caja y
 * el aviso decía "Sincronizado".
 */
async function listBlockedStockEntries(prisma) {
  const rows = await prisma.batch.findMany({
    where: { pendingPush: true, pushError: { not: null }, payloadJson: { not: null } },
    orderBy: { createdAt: 'asc' },
    include: { product: { select: { name: true } } },
  });
  return rows.map((row) => ({
    kind: 'stockEntry',
    id: row.id,
    label: `Entrada ${row.lotNumber ?? 'sin lote'}`,
    detail: `${row.product?.name ?? 'Producto'} · ${row.quantity} pzas`,
    occurredAt: row.createdAt,
    reason: row.pushError,
    diagnosis: diagnoseReason(row.pushError),
  }));
}

/** Devuelve un lote rechazado a la cola normal (se usa tras corregir la causa). */
async function clearStockEntryPushError(prisma, batchLocalId) {
  await prisma.batch.update({ where: { id: batchLocalId }, data: { pushError: null } });
}

/**
 * Borra un lote que **nunca llegó** al servidor y le quita al producto las piezas
 * que había sumado en local. Reclama la fila con `deleteMany({ pendingPush })`:
 * un lote que ya subió no se toca (el servidor lo tiene) y dos descartes
 * simultáneos no restan dos veces.
 */
async function discardStockEntry(prisma, batchLocalId) {
  await prisma.$transaction(async (tx) => {
    const batch = await tx.batch.findUnique({ where: { id: batchLocalId } });
    if (!batch || !batch.pendingPush) {
      return;
    }
    const deleted = await tx.batch.deleteMany({ where: { id: batchLocalId, pendingPush: true } });
    if (deleted.count === 0) {
      return;
    }
    await tx.product.updateMany({
      where: { id: batch.productId },
      data: { totalStock: { decrement: batch.quantity } },
    });
  });
}

/**
 * Producto completo para el formulario de edición de catálogo (`/pos/productos`).
 * Acepta id local o `remoteId`, igual que el resto de esta capa.
 */
async function getProductById(prisma, id) {
  const row = await prisma.product.findFirst({
    where: { OR: [{ id }, { remoteId: id }] },
  });
  return row ? toProductDto(row) : null;
}

/**
 * Alta de producto **sin** lote/factura, desde el módulo de edición de
 * catálogo. `pendingCatalogPush` es un flag aparte de `pendingPush` a
 * propósito (ver comentario en `schema.prisma`): así el push de esta pantalla
 * nunca compite con el de `recordStockEntry`, que ya sube el producto nuevo
 * embebido en su propio `POST /stock-entries`.
 */
async function createCatalogProduct(prisma, fields) {
  await assertNameAvailable(prisma, fields);
  const created = await prisma.product.create({
    data: {
      ...productFieldsData(fields),
      isActive: true,
      pendingCatalogPush: true,
    },
  });
  return toProductDto(created);
}

/** Edición de un producto existente (activo o no) desde el módulo de catálogo. */
async function updateCatalogProduct(prisma, id, fields) {
  const productId = await resolveLocalProductId(prisma, id);
  const updated = await prisma.product.update({
    where: { id: productId },
    data: { ...productFieldsData(fields), pendingCatalogPush: true, catalogPushError: null },
  });
  return toProductDto(updated);
}

/**
 * `productFieldsData` sirve para escribir en Prisma, donde `null` es un valor
 * válido y explícito (borra el campo). El backend no lo acepta así: sus
 * campos opcionales son Zod `.optional()`, no `.nullable()` — un `iepsRate:
 * null` o `controlledGroup: null` en el body revienta con 400 aunque el
 * producto nunca haya tenido esos campos. Este serializador aparte omite por
 * completo cualquier campo opcional que esté vacío, en vez de mandarlo como
 * `null`.
 */
function toPushFields(row) {
  const fields = {
    name: row.name,
    sku: row.sku,
    categoryId: row.categoryId,
    unit: row.unit,
    salePrice: row.salePrice,
    minStock: row.minStock,
    hasIva: Boolean(row.hasIva),
    hasIvaZero: Boolean(row.hasIvaZero),
    hasIeps: Boolean(row.hasIeps),
    requiresPrescription: Boolean(row.requiresPrescription),
  };
  if (row.barcode) fields.barcode = row.barcode;
  if (row.activeIngredient) fields.activeIngredient = row.activeIngredient;
  if (row.concentration) fields.concentration = row.concentration;
  if (row.hasIeps && row.iepsRate != null) fields.iepsRate = row.iepsRate;
  if (row.controlledGroup) fields.controlledGroup = row.controlledGroup;
  // El backend no acepta `isActive` en el alta (`createProductSchema` no lo
  // declara); solo tiene sentido en la edición de un producto ya remoto.
  if (row.remoteId) fields.isActive = Boolean(row.isActive);
  return fields;
}

/**
 * Foto de catálogo comparable (SPEC 56): la forma de `toPushFields`, más
 * `isActive` siempre (el alta no lo manda, pero la foto debe saberlo para que el
 * PATCH no reactive un producto que el panel desactivó).
 */
function catalogFieldsOf(row) {
  return { ...toPushFields(row), isActive: row.isActive !== false };
}

/** `baseFields` = `{ updatedAt (ISO remoto o null), fields }`. */
function serializeBase(updatedAt, fields) {
  const iso = toDate(updatedAt)?.toISOString() ?? null;
  return JSON.stringify({ updatedAt: iso, fields });
}

/** Lee `baseFields`; `null` si no hay foto (fila anterior a SPEC 56) o es ilegible. */
function parseBaseFields(raw) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.fields || typeof parsed.fields !== 'object') {
      return null;
    }
    return {
      updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt ? parsed.updatedAt : null,
      fields: parsed.fields,
    };
  } catch {
    return null;
  }
}

/** Lee `catalogConflict`: `{ salePrice, isActive, force? }` o `null`. */
function parseConflict(raw) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return {
      salePrice: typeof parsed.salePrice === 'number' ? parsed.salePrice : null,
      isActive: typeof parsed.isActive === 'boolean' ? parsed.isActive : null,
      force: parsed.force === true,
    };
  } catch {
    return null;
  }
}

/**
 * Los impuestos se validan juntos en el backend (`hasIeps` exige `iepsRate`;
 * IVA 16 % y 0 % se excluyen): si cambia uno, viajan todos los que hay.
 */
const TAX_FIELDS = ['hasIva', 'hasIvaZero', 'hasIeps', 'iepsRate'];

/**
 * Lo que cambió en local respecto a la foto: solo eso sube en el PATCH (SPEC 56,
 * C3). Mandar el registro completo era "gana la última escritura": una caja con
 * datos viejos que corregía otro campo revertía el precio del admin, y además
 * reactivaba un producto desactivado. Un campo que se vació en local no viaja
 * (el backend no acepta `null`), igual que antes con el registro completo.
 */
function diffCatalogFields(current, base) {
  const changes = {};
  for (const [key, value] of Object.entries(current)) {
    if (value !== base[key]) {
      changes[key] = value;
    }
  }
  if (TAX_FIELDS.some((key) => key in changes)) {
    for (const key of TAX_FIELDS) {
      if (current[key] !== undefined) {
        changes[key] = current[key];
      }
    }
  }
  return changes;
}

/** Texto que ve el cajero cuando el panel cambió precio o estado (409 `CATALOG_CONFLICT`). */
function conflictMessage(row, current) {
  const partes = [];
  if (current.salePrice !== null && current.salePrice !== row.salePrice) {
    partes.push(`El precio cambió en el panel: $${current.salePrice.toFixed(2)}`);
  }
  if (current.isActive !== null && current.isActive !== row.isActive) {
    const estado = current.isActive ? 'se reactivó' : 'se desactivó';
    partes.push(partes.length ? `y el producto ${estado}` : `El producto ${estado} en el panel`);
  }
  if (!partes.length) {
    return current.salePrice !== null
      ? `El precio cambió en el panel: $${current.salePrice.toFixed(2)}`
      : 'El producto cambió en el panel';
  }
  return partes.join(' ');
}

async function getPendingCatalogPush(prisma) {
  const rows = await prisma.product.findMany({
    // Igual que las otras colas: un producto con `catalogPushError` ya quedó
    // bloqueado a propósito, no se reintenta solo en cada horario fijo.
    where: { pendingCatalogPush: true, catalogPushError: null },
    orderBy: { updatedAt: 'asc' },
  });
  return rows.map((row) => {
    const snapshot = catalogFieldsOf(row);
    const base = row.remoteId ? parseBaseFields(row.baseFields) : null;
    const conflict = parseConflict(row.catalogConflict);
    return {
      id: row.id,
      remoteId: row.remoteId ?? null,
      fields: toPushFields(row),
      // Edición con foto: solo lo cambiado. `null` = sin foto (alta, o fila de
      // antes de SPEC 56): sube completo, como siempre.
      changes: base ? diffCatalogFields(snapshot, base.fields) : null,
      // "Forzar el mío" sube sin `baseUpdatedAt`: el servidor ya no compara.
      baseUpdatedAt: base && !conflict?.force ? base.updatedAt : null,
      // Lo que queda en el servidor si el push sale bien: la foto nueva.
      snapshot,
      catalogPushError: row.catalogPushError ?? null,
      // Foto de la edición que se va a subir: `markCatalogSynced` la compara para no
      // dar por subida una edición que llegó mientras el PATCH estaba en vuelo.
      version: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  });
}

/**
 * Confirma un push de catálogo. `synced` (opcional) trae la foto que ya tiene el
 * servidor: `fields` (lo subido) y `remoteUpdatedAt` (el `updatedAt` que
 * respondió). Con ella se renueva `baseFields`, para que el siguiente PATCH
 * compare contra lo que de verdad quedó arriba.
 *
 * Si el `remoteId` ya lo tiene otra fila (el pull la creó antes de este enlace),
 * se fusionan (`linkRemoteId`) en vez de fallar por `remoteId @unique`.
 */
async function markCatalogSynced(prisma, localId, remoteId, pushedVersion, synced = null) {
  await inTransaction(prisma, async (tx) => {
    const current = await tx.product.findUnique({ where: { id: localId } });
    if (!current) {
      return;
    }
    // Si el producto se editó mientras el push estaba en vuelo, su `updatedAt` ya no
    // es el de la foto que se subió: se guarda el `remoteId` pero la edición nueva
    // sigue pendiente. Si no, se marcaba subida y el siguiente pull la pisaba con el
    // valor viejo del servidor.
    const editadoEnVuelo =
      Boolean(pushedVersion) &&
      Boolean(current.updatedAt) &&
      new Date(current.updatedAt).toISOString() !== pushedVersion;
    if (remoteId && current.remoteId !== remoteId) {
      // Lo recién subido es lo que tiene el servidor: se conserva el catálogo local.
      await linkRemoteId(tx, localId, remoteId, { preferLocalCatalog: true, reason: 'catálogo' });
    }
    const data = {
      ...(editadoEnVuelo ? {} : { pendingCatalogPush: false }),
      catalogPushError: null,
      catalogConflict: null,
    };
    if (synced && synced.fields && typeof synced.fields === 'object') {
      const after = await tx.product.findUnique({ where: { id: localId } });
      const previous = parseBaseFields(after?.baseFields);
      const remoteUpdatedAt = toDate(synced.remoteUpdatedAt);
      data.baseFields = serializeBase(remoteUpdatedAt ?? previous?.updatedAt ?? null, synced.fields);
      if (remoteUpdatedAt) {
        data.remoteUpdatedAt = newestDate(after?.remoteUpdatedAt ?? null, remoteUpdatedAt);
      }
    }
    await tx.product.update({ where: { id: localId }, data });
  });
}

async function markCatalogPushFailed(prisma, localId, message) {
  await prisma.product.update({ where: { id: localId }, data: { catalogPushError: message } });
}

/**
 * El PATCH respondió 409 `CATALOG_CONFLICT` (SPEC 56): el precio o el estado
 * cambiaron en el panel después de la foto. Se guarda el valor actual del
 * servidor y la edición queda **bloqueada visible** en "Rechazados" con el
 * texto "El precio cambió en el panel: $X", hasta que alguien elija "Usar el del
 * panel" o "Forzar el mío" (`resolveCatalogConflict`).
 */
async function markCatalogConflict(prisma, localId, current) {
  const row = await prisma.product.findUnique({ where: { id: localId } });
  if (!row) {
    return;
  }
  const panel = {
    salePrice: typeof current?.salePrice === 'number' ? current.salePrice : null,
    isActive: typeof current?.isActive === 'boolean' ? current.isActive : null,
  };
  await prisma.product.update({
    where: { id: localId },
    data: {
      catalogConflict: JSON.stringify(panel),
      catalogPushError: `${conflictMessage(row, panel)} [CATALOG_CONFLICT]`,
    },
  });
}

/**
 * Resuelve un conflicto de catálogo:
 *
 * - `panel` ("Usar el del panel"): la caja toma el precio y el estado del panel
 *   y los da por base; lo demás que se editó en local sigue pendiente y sube en
 *   el siguiente push (ya sin tocar precio ni estado). Si no queda nada, el push
 *   lo da por subido sin pedir nada al servidor.
 * - `mine` ("Forzar el mío"): la edición vuelve a la cola y sube **sin**
 *   `baseUpdatedAt`, así que el servidor la aplica aunque el panel haya cambiado.
 *
 * Devuelve `false` si no hay conflicto que resolver.
 */
async function resolveCatalogConflict(prisma, localId, choice) {
  const row = await prisma.product.findUnique({ where: { id: localId } });
  const conflict = parseConflict(row?.catalogConflict);
  if (!row || !conflict) {
    return false;
  }
  if (choice === 'mine') {
    await prisma.product.update({
      where: { id: localId },
      data: {
        catalogConflict: JSON.stringify({ ...conflict, force: true }),
        catalogPushError: null,
        pendingCatalogPush: true,
      },
    });
    return true;
  }
  if (choice !== 'panel') {
    throw new Error(`Opción de conflicto desconocida: ${choice}`);
  }
  const panel = {};
  if (conflict.salePrice !== null) panel.salePrice = conflict.salePrice;
  if (conflict.isActive !== null) panel.isActive = conflict.isActive;
  const base = parseBaseFields(row.baseFields);
  await prisma.product.update({
    where: { id: localId },
    data: {
      ...panel,
      ...(base ? { baseFields: JSON.stringify({ ...base, fields: { ...base.fields, ...panel } }) } : {}),
      catalogConflict: null,
      catalogPushError: null,
      pendingCatalogPush: true,
    },
  });
  return true;
}

/**
 * "Arreglar" de un producto que bloquea ventas: limpia **todos** sus errores de
 * subida para que su cola lo vuelva a intentar en el siguiente push. El alta
 * puede venir del catálogo (`catalogPushError`) o de una entrada de stock (el
 * error vive en el lote), y desde el panel no hay forma de saber cuál de las
 * dos falló, así que se reintentan ambas.
 *
 * Devuelve `false` si el producto no existe en local (un comando remoto puede
 * apuntar a un id que esta caja no tiene).
 */
async function retryProductPush(prisma, localId) {
  const product = await prisma.product.findUnique({ where: { id: localId } });
  if (!product) {
    return false;
  }
  await prisma.product.update({
    where: { id: localId },
    data: { pushError: null, catalogPushError: null },
  });
  await prisma.batch.updateMany({
    where: { productId: localId, pendingPush: true, pushError: { not: null } },
    data: { pushError: null },
  });
  return true;
}

async function clearCatalogPushError(prisma, localId) {
  await prisma.product.update({ where: { id: localId }, data: { catalogPushError: null } });
}

/** Altas o ediciones de catálogo que el servidor rechazó, para el panel de rechazados. */
async function listBlockedProducts(prisma) {
  const rows = await prisma.product.findMany({
    where: { pendingCatalogPush: true, catalogPushError: { not: null } },
    orderBy: { updatedAt: 'asc' },
  });
  return rows.map((row) => {
    const conflict = parseConflict(row.catalogConflict);
    return {
      kind: 'product',
      id: row.id,
      label: row.name,
      detail: `SKU ${row.sku}`,
      occurredAt: row.updatedAt,
      reason: row.catalogPushError,
      diagnosis: diagnoseReason(row.catalogPushError),
      // Solo con 409 `CATALOG_CONFLICT`: lo que dice el panel, para "Usar el del panel".
      ...(conflict ? { conflict: { salePrice: conflict.salePrice, isActive: conflict.isActive } } : {}),
    };
  });
}

module.exports = {
  retryProductPush,
  search,
  findByName,
  suggestProductName,
  getByBarcode,
  getByIds,
  recordStockEntry,
  upsertMany,
  refreshOne,
  getBatchesByProduct,
  getPendingStockEntries,
  markStockEntrySynced,
  markStockEntryPushFailed,
  listBlockedStockEntries,
  clearStockEntryPushError,
  discardStockEntry,
  listBlockedProducts,
  getProductById,
  createCatalogProduct,
  updateCatalogProduct,
  getPendingCatalogPush,
  markCatalogSynced,
  markCatalogPushFailed,
  markCatalogConflict,
  resolveCatalogConflict,
  clearCatalogPushError,
  toProductDto,
};
