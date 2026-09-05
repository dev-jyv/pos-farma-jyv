/**
 * `expiryDate`/`updatedAt` llegan del backend como `Timestamp` de Firestore,
 * que por HTTP se serializa `{ _seconds, _nanoseconds }`, no como ISO string.
 * Mismo caso que resuelve `toDate()` en el frontend (`core/api/api.utils.ts`).
 */
function toDate(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'object' && '_seconds' in value) {
    return new Date(value._seconds * 1000);
  }
  return null;
}

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

async function search(prisma, term) {
  const normalized = term?.trim() ?? '';
  const where = normalized
    ? {
        isActive: true,
        OR: [
          { name: { contains: normalized } },
          { sku: { contains: normalized } },
          { barcode: { contains: normalized } },
          { activeIngredient: { contains: normalized } },
        ],
      }
    : { isActive: true };

  const rows = await prisma.product.findMany({ where, orderBy: { name: 'asc' }, take: 25 });
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
  return row ? toProductDto(row) : null;
}

/**
 * Local-first de `POST /stock-entries`: mismo payload (`product` para alta,
 * `productId`+`productUpdate` para uno existente, `lotNumber`/`expiryDate`/
 * `quantity`/`costPrice`/`invoiceId`). El payload completo se guarda en el
 * lote para reenviarlo tal cual al sincronizar; el backend es quien valida y
 * asigna los ids reales.
 */
async function recordStockEntry(prisma, payload) {
  let productId = payload.productId ?? null;

  if (productId) {
    // `payload.productId` viaja con el id de Firestore (`remoteId`) cuando el
    // producto ya sincronizó alguna vez — el renderer lo arma así porque es lo
    // que necesita el `POST /stock-entries` real al hacer push. Aquí, para
    // escribir en SQLite, hace falta el id LOCAL.
    productId = await resolveLocalProductId(prisma, productId);
  }

  if (payload.product) {
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
 * Upsert por `remoteId`: usado por el pull periódico desde `GET /products/sync`.
 * El backend manda solo los campos que esta tabla persiste, así que aquí no hay
 * nada que descartar: lo que llega es lo que se guarda.
 */
async function upsertMany(prisma, remoteProducts) {
  for (const remote of remoteProducts) {
    const data = {
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
      // `suppliers` no se escribe: nada en la caja lo lee (`toProductDto` no lo
      // expone) y serializarlo por producto en cada pull era peso muerto. Por eso
      // `GET /products/sync` tampoco lo manda.
      totalStock: remote.stock ?? remote.totalStock ?? 0,
    };
    // Producto + sus lotes en una sola transacción: si el proceso se interrumpe
    // a media pasada, este producto no queda con el catálogo actualizado pero
    // los lotes viejos borrados a medias (o viceversa). El cursor de sync solo
    // avanza si `upsertMany` completa sin lanzar, así que un producto fallido
    // se reintenta entero en el siguiente pull.
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.upsert({
        where: { remoteId: remote.id },
        update: data,
        create: { ...data, remoteId: remote.id, pendingPush: false },
      });

      if (Array.isArray(remote.batches)) {
        // Los remotos son la foto autoritativa de este producto: se reemplazan
        // completos en cada sync. `POST /stock-entries` no devuelve el id del
        // lote creado, así que un lote local ya sincronizado se queda con
        // `remoteId: null` — filtrar solo por `remoteId` lo duplicaría en cuanto
        // ese mismo lote vuelva por el pull. Lo que de verdad distingue "ya no
        // hay nada que reemplazar en local" es `pendingPush: false`; un lote
        // todavía `pendingPush: true` sigue esperando su propio push y no se toca.
        await tx.batch.deleteMany({ where: { productId: product.id, pendingPush: false } });
        if (remote.batches.length) {
          await tx.batch.createMany({
            data: remote.batches.map((batch) => ({
              remoteId: batch.id,
              productId: product.id,
              lotNumber: batch.lotNumber ?? null,
              expiryDate: toDate(batch.expiryDate),
              quantity: batch.quantity,
              pendingPush: false,
            })),
          });
        }
      }
    });
  }
  return { count: remoteProducts.length };
}

/** Lotes de un producto (local + ya sincronizados), para caducidad/FEFO al agregar al carrito. */
async function getBatchesByProduct(prisma, productId) {
  const rows = await prisma.batch.findMany({
    where: { productId },
    orderBy: { expiryDate: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    lotNumber: row.lotNumber ?? '',
    expiryDate: row.expiryDate,
    quantity: row.quantity,
  }));
}

async function getPendingStockEntries(prisma) {
  const rows = await prisma.batch.findMany({
    // Igual que `getPendingPush` de ventas: un lote con `pushError` ya quedó
    // bloqueado a propósito y no debe reintentarse solo en cada horario fijo.
    where: { pendingPush: true, pushError: null, payloadJson: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    payload: JSON.parse(row.payloadJson),
    pushError: row.pushError ?? null,
  }));
}

async function markStockEntrySynced(prisma, batchLocalId, remoteProductId) {
  const batch = await prisma.batch.update({
    where: { id: batchLocalId },
    data: { pendingPush: false, pushError: null },
  });
  if (remoteProductId) {
    await prisma.product.update({
      where: { id: batch.productId },
      data: { remoteId: remoteProductId, pendingPush: false, pushError: null },
    });
  }
}

async function markStockEntryPushFailed(prisma, batchLocalId, message) {
  await prisma.batch.update({ where: { id: batchLocalId }, data: { pushError: message } });
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

async function getPendingCatalogPush(prisma) {
  const rows = await prisma.product.findMany({
    // Igual que las otras colas: un producto con `catalogPushError` ya quedó
    // bloqueado a propósito, no se reintenta solo en cada horario fijo.
    where: { pendingCatalogPush: true, catalogPushError: null },
    orderBy: { updatedAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    remoteId: row.remoteId ?? null,
    fields: toPushFields(row),
    catalogPushError: row.catalogPushError ?? null,
  }));
}

async function markCatalogSynced(prisma, localId, remoteId) {
  await prisma.product.update({
    where: { id: localId },
    data: {
      ...(remoteId ? { remoteId } : {}),
      pendingCatalogPush: false,
      catalogPushError: null,
    },
  });
}

async function markCatalogPushFailed(prisma, localId, message) {
  await prisma.product.update({ where: { id: localId }, data: { catalogPushError: message } });
}

async function clearCatalogPushError(prisma, localId) {
  await prisma.product.update({ where: { id: localId }, data: { catalogPushError: null } });
}

module.exports = {
  search,
  getByBarcode,
  recordStockEntry,
  upsertMany,
  getBatchesByProduct,
  getPendingStockEntries,
  markStockEntrySynced,
  markStockEntryPushFailed,
  getProductById,
  createCatalogProduct,
  updateCatalogProduct,
  getPendingCatalogPush,
  markCatalogSynced,
  markCatalogPushFailed,
  clearCatalogPushError,
  toProductDto,
};
