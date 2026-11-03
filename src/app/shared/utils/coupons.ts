/**
 * Motor de cupones (SPEC 47), en **centavos enteros**. Es copia del backend
 * (`functions/src/utils/coupons.ts`) y tiene que cobrar el mismo centavo: los
 * casos dorados `coupons-engine.cases.json` son el mismo archivo en los dos repos
 * (`npm run check:promo-engine` compara los sha256). Si cambia aquí, cambia allá.
 *
 * Puro a propósito: sin fechas, sin vigencia, sin `usedCount`. Esas reglas las
 * aplica quien llama (la caja con su reloj, el servidor con el suyo); el motor
 * solo dice cuánto descuenta un cupón sobre unas líneas dadas.
 */

export type CouponEngineDiscount =
  | { type: 'percent'; percent: number }
  | { type: 'amount'; amountCents: number };

export interface CouponEngineCoupon {
  scope: 'product' | 'sale';
  /** Ids **remotos** de producto. Solo cuentan en alcance de producto. */
  productIds: string[];
  discount: CouponEngineDiscount;
  /** Solo en alcance de venta: debajo de esto el cupón no descuenta nada. */
  minPurchaseCents: number | null;
}

export interface CouponEngineLine {
  productId: string;
  /** Piezas de la línea (una caja de 10 son 10): el monto de producto es por pieza. */
  pieces: number;
  /** Importe neto de la línea en centavos (después de sus descuentos de línea). */
  netCents: number;
  /** Una línea en promoción nunca recibe cupón de producto. */
  hasPromotion: boolean;
}

export interface CouponEngineResult {
  /** Centavos de cupón por línea, en el mismo orden. Todo 0 en alcance de venta. */
  lines: number[];
  /** Centavos de cupón sobre el total (alcance de venta). 0 en alcance de producto. */
  saleCents: number;
  totalCents: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Monto de la regla sobre `baseCents`, nunca negativo ni mayor que la base. */
function applyDiscount(discount: CouponEngineDiscount, baseCents: number, units: number): number {
  if (baseCents <= 0) {
    return 0;
  }
  let cents = 0;
  if (discount.type === 'percent' && isFiniteNumber(discount.percent) && discount.percent > 0) {
    cents = Math.round((baseCents * discount.percent) / 100);
  } else if (
    discount.type === 'amount' &&
    isFiniteNumber(discount.amountCents) &&
    discount.amountCents > 0
  ) {
    cents = Math.round(discount.amountCents * units);
  }
  return Math.max(0, Math.min(cents, baseCents));
}

/**
 * Una forma que este motor no conoce (alcance o tipo de descuento nuevo, campos
 * faltantes) da **cero**, no truena: el backend se actualiza antes que las cajas.
 */
export function computeCouponDiscount(
  coupon: CouponEngineCoupon,
  lines: CouponEngineLine[],
): CouponEngineResult {
  const zero: CouponEngineResult = { lines: lines.map(() => 0), saleCents: 0, totalCents: 0 };
  const discount = coupon?.discount;
  if (!discount || (discount.type !== 'percent' && discount.type !== 'amount')) {
    return zero;
  }

  if (coupon.scope === 'product') {
    const eligible = new Set(Array.isArray(coupon.productIds) ? coupon.productIds : []);
    const lineCents = lines.map((line) =>
      eligible.has(line.productId) && !line.hasPromotion
        ? applyDiscount(discount, line.netCents, line.pieces)
        : 0,
    );
    return { lines: lineCents, saleCents: 0, totalCents: sum(lineCents) };
  }

  if (coupon.scope === 'sale') {
    const base = sum(lines.map((line) => line.netCents));
    if (coupon.minPurchaseCents != null && base < coupon.minPurchaseCents) {
      return zero;
    }
    const saleCents = applyDiscount(discount, base, 1);
    return { lines: lines.map(() => 0), saleCents, totalCents: saleCents };
  }

  return zero;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
