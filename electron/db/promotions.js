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
 * Promociones activas que no han terminado en `now`, **incluidas las
 * programadas**. El renderer relee solo tras cada sync (10:30, 14:00, 20:00):
 * si aquí se filtrara `startsAt <= now`, una promo que empieza a las 08:00 y
 * bajó la noche anterior no aplicaría hasta las 10:30. La ventana exacta la
 * decide `PromoService` en cada cálculo, con la hora local.
 */
async function listActive(prisma, now = new Date()) {
  const rows = await prisma.promotion.findMany({
    where: {
      isActive: true,
      OR: [{ endsAt: null }, { endsAt: { gte: now } }],
    },
    orderBy: { name: 'asc' },
  });
  return rows.map(toPromotionDto).filter((promotion) => promotion.rule);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Borra las promociones que ya no pueden volver a aplicar y solo ocupan espacio:
 * las dadas de baja hace más de `days` días (por `deactivatedAt`, o por
 * `updatedAt` si una fila vieja llegó sin él) y las que terminaron (`endsAt`)
 * hace más de `days` días. La tabla es solo-pull y el admin nunca reactiva una
 * promo (la regla es inmutable: se da de baja y se crea otra), así que sin esto
 * crece para siempre con cada campaña.
 *
 * El margen de 30 días no es por la caja —`listActive` ya las ignora— sino por
 * si alguien necesita revisar en el equipo qué promo tenía una venta reciente.
 * No toca el cursor del sync: una baja más vieja que el cursor no vuelve a bajar,
 * y una que cambie después llega por `updatedSince` como cualquier otra.
 */
async function purgeStale(prisma, now = new Date(), days = 30) {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  return prisma.promotion.deleteMany({
    where: {
      OR: [
        { isActive: false, deactivatedAt: { lt: cutoff } },
        { isActive: false, deactivatedAt: null, updatedAt: { lt: cutoff } },
        { endsAt: { lt: cutoff } },
      ],
    },
  });
}

module.exports = { toPromotionDto, upsertMany, listActive, purgeStale };
