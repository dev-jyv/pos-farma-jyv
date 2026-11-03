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

export function computeCouponDiscount(
  coupon: CouponEngineCoupon,
  lines: CouponEngineLine[],
): CouponEngineResult {
  if (coupon.scope === 'product') {
    const lineCents = lines.map((line) => {
      if (!coupon.productIds.includes(line.productId) || line.hasPromotion) {
        return 0;
      }
      return coupon.discount.type === 'percent'
        ? Math.round((line.netCents * coupon.discount.percent) / 100)
        : Math.min(coupon.discount.amountCents * line.pieces, line.netCents);
    });
    return { lines: lineCents, saleCents: 0, totalCents: sum(lineCents) };
  }

  const zeros = lines.map(() => 0);
  const base = sum(lines.map((line) => line.netCents));
  if (coupon.minPurchaseCents != null && base < coupon.minPurchaseCents) {
    return { lines: zeros, saleCents: 0, totalCents: 0 };
  }
  const saleCents =
    coupon.discount.type === 'percent'
      ? Math.round((base * coupon.discount.percent) / 100)
      : Math.min(coupon.discount.amountCents, base);
  return { lines: zeros, saleCents, totalCents: saleCents };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
