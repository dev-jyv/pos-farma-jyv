/**
 * Promociones por cantidad. **Solo-pull**, igual que `pharmacy-services.js`: las
 * administra el admin web y llegan por `GET /promotions/sync`, así que el `id`
 * local es el de Firestore y no hay colas de push.
 *
 * `productIds` son ids **remotos** de producto: el carrito compara contra
 * `product.remoteId ?? product.id`.
 */

const { toDate, toDateOrNow } = require('./timestamps');

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function toPromotionDto(row) {
  return {
    id: row.id,
    name: row.name,
    rule: parseJson(row.ruleJson, null),
    productIds: parseJson(row.productIdsJson, []),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    isActive: row.isActive,
  };
}

/** Lista blanca de lo que se persiste del documento remoto. */
function promotionData(remote) {
  return {
    name: remote.name ?? '',
    type: remote.rule?.type ?? 'tiered',
    ruleJson: JSON.stringify(remote.rule ?? null),
    productIdsJson: JSON.stringify(Array.isArray(remote.productIds) ? remote.productIds : []),
    startsAt: toDateOrNow(remote.startsAt),
    endsAt: toDate(remote.endsAt),
    isActive: remote.isActive !== false,
    deactivatedAt: toDate(remote.deactivatedAt),
    updatedAt: toDateOrNow(remote.updatedAt),
  };
}

/** Upsert por id en una sola transacción: el lote entra entero o no entra. */
async function upsertMany(prisma, remotes = []) {
  const validos = remotes.filter((remote) => remote?.id && remote?.rule);
  if (validos.length === 0) {
    return { count: 0 };
  }
  await prisma.$transaction(
    validos.map((remote) => {
      const data = promotionData(remote);
      return prisma.promotion.upsert({
        where: { id: remote.id },
        create: { id: remote.id, ...data },
        update: data,
      });
    }),
  );
  return { count: validos.length };
}

/**
 * Promociones aplicables en `now`: activas, ya iniciadas y sin terminar. La
 * vigencia se decide con la hora local porque la caja cobra sin red; el
 * backend la vuelve a validar al sincronizar.
 */
async function listActive(prisma, now = new Date()) {
  const rows = await prisma.promotion.findMany({
    where: {
      isActive: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gte: now } }],
    },
    orderBy: { name: 'asc' },
  });
  return rows.map(toPromotionDto).filter((promotion) => promotion.rule);
}

module.exports = { toPromotionDto, upsertMany, listActive };
