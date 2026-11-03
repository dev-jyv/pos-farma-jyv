/**
 * Cupones de descuento (SPEC 47). **Solo-pull**, igual que `promotions.js`: los
 * administra el panel y llegan por `GET /coupons/sync`, así que el `id` local es
 * el de Firestore — que además es el código normalizado.
 *
 * `productIds` son ids **remotos** de producto: el carrito compara contra
 * `product.remoteId ?? product.id`.
 *
 * La caja no decide si un cupón está agotado: `usedCount` es la foto del último
 * pull y otras cajas pueden haberlo usado después. Solo avisa; el servidor
 * acepta la venta offline y la marca para revisión si se pasó.
 */

const { toDate, toDateOrNow } = require('./timestamps');

/** Mismo formato que el backend: mayúsculas, dígitos y guion, 4 a 20. */
const COUPON_CODE_PATTERN = /^[A-Z0-9-]{4,20}$/;

/**
 * Normaliza lo que teclea o escanea el cajero: sin espacios alrededor ni dentro
 * (un lector de código a veces mete uno) y en mayúsculas.
 */
function normalizeCode(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const code = raw.replace(/\s+/g, '').toUpperCase();
  return COUPON_CODE_PATTERN.test(code) ? code : null;
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

/** Descuento remoto → forma guardada. Cualquier otra cosa invalida el cupón. */
function parseDiscount(discount) {
  if (discount?.type === 'percent' && typeof discount.percent === 'number' && discount.percent > 0) {
    return { type: 'percent', percent: discount.percent };
  }
  if (discount?.type === 'amount' && typeof discount.amount === 'number' && discount.amount > 0) {
    return { type: 'amount', amount: discount.amount };
  }
  return null;
}

function toCouponDto(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    scope: row.scope === 'sale' ? 'sale' : 'product',
    productIds: parseJson(row.productIdsJson, []),
    discount: parseJson(row.discountJson, null),
    minPurchase: row.minPurchase ?? null,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    maxUses: row.maxUses ?? null,
    usedCount: row.usedCount ?? 0,
    isActive: row.isActive,
    deactivatedAt: row.deactivatedAt ? row.deactivatedAt.toISOString() : null,
  };
}

/** Lista blanca de lo que se persiste del documento remoto. */
function couponData(remote, code) {
  return {
    code,
    name: remote.name ?? code,
    scope: remote.scope === 'sale' ? 'sale' : 'product',
    productIdsJson: JSON.stringify(Array.isArray(remote.productIds) ? remote.productIds : []),
    discountJson: JSON.stringify(parseDiscount(remote.discount)),
    minPurchase: typeof remote.minPurchase === 'number' ? remote.minPurchase : null,
    startsAt: toDateOrNow(remote.startsAt),
    endsAt: toDate(remote.endsAt),
    maxUses: Number.isInteger(remote.maxUses) ? remote.maxUses : null,
    usedCount: Number.isInteger(remote.usedCount) ? remote.usedCount : 0,
    isActive: remote.isActive !== false,
    deactivatedAt: toDate(remote.deactivatedAt),
    updatedAt: toDateOrNow(remote.updatedAt),
  };
}

/**
 * Upsert por código en una sola transacción. El id es el código normalizado:
 * si el documento trae `id` y `code` distintos manda el `code` (es el que teclea
 * el cajero). Se descarta lo que no tiene código válido o descuento legible: un
 * cupón que la caja no sabe calcular no debe aparecer como aplicable.
 */
async function upsertMany(prisma, remotes = []) {
  const validos = [];
  for (const remote of remotes ?? []) {
    const code = normalizeCode(remote?.code ?? remote?.id);
    if (code && parseDiscount(remote.discount)) {
      validos.push({ code, remote });
    }
  }
  if (validos.length === 0) {
    return { count: 0 };
  }
  await prisma.$transaction(
    validos.map(({ code, remote }) => {
      const data = couponData(remote, code);
      return prisma.coupon.upsert({
        where: { id: code },
        create: { id: code, ...data },
        update: data,
      });
    }),
  );
  return { count: validos.length };
}

/**
 * Busca por código **normalizado**, activo o no: la pantalla necesita saber si
 * el cupón existe pero está dado de baja para decirlo así, en vez de "no
 * encontrado" (que manda al cajero a sincronizar sin motivo).
 */
async function findByCode(prisma, raw) {
  const code = normalizeCode(raw);
  if (!code) {
    return null;
  }
  const row = await prisma.coupon.findUnique({ where: { id: code } });
  if (!row) {
    return null;
  }
  const dto = toCouponDto(row);
  return dto.discount ? dto : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Borra los cupones que ya no pueden volver a aplicar, con la misma regla que
 * `promotions.js#purgeStale`: dados de baja o terminados hace más de `days`
 * días. Un cupón no se reactiva (se desactiva y se crea otro), así que sin esto
 * la tabla crece con cada campaña.
 */
async function purgeStale(prisma, now = new Date(), days = 30) {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  return prisma.coupon.deleteMany({
    where: {
      OR: [
        { isActive: false, deactivatedAt: { lt: cutoff } },
        { isActive: false, deactivatedAt: null, updatedAt: { lt: cutoff } },
        { endsAt: { lt: cutoff } },
      ],
    },
  });
}

module.exports = { normalizeCode, toCouponDto, upsertMany, findByCode, purgeStale };
