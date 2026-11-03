import { Injectable, signal } from '@angular/core';

import { CartLine, CouponDto, SaleCoupon } from '../../../shared/models';
import { isProductLine, linePieces, lineUnitPrice } from '../../../shared/utils/cart-line';
import { CouponEngineCoupon, CouponEngineLine, computeCouponDiscount } from '../../../shared/utils/coupons';
import { fromCents, toCents } from '../../../shared/utils/money';
import { COUPONS_SYNCED_EVENT } from '../../../core/sync/sync-events';

/** Mensaje cuando el código no está en la SQLite de la caja. */
export const COUPON_NOT_FOUND_MESSAGE = 'Cupón no encontrado — sincroniza o revisa el código';

/** Aviso (no bloquea) cuando la foto local dice que ya se usaron todos. */
export const COUPON_MAYBE_EXHAUSTED_MESSAGE =
  'Este cupón puede estar agotado; el servidor lo revisará';

/** Por qué un cupón no descuenta nada en este momento. */
export type CouponIssueCode =
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'no_products'
  | 'all_promoted'
  | 'below_minimum'
  | 'no_effect';

export interface CouponIssue {
  code: CouponIssueCode;
  message: string;
}

/** Resultado de aplicar el cupón al ticket. */
export interface CouponPricing {
  /** Líneas con el cupón de producto ya dentro de `discountAmount`. */
  lines: CartLine[];
  /** Descuento a nivel venta (alcance de venta) → `saleDiscountAmount`. */
  saleDiscount: number;
  /** Total del cupón (suma de líneas o el de venta). */
  total: number;
  /** Por qué no descuenta; `null` si aplica. */
  issue: CouponIssue | null;
}

function money(amount: number): string {
  return amount.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** El cupón en la forma del motor (centavos). */
export function toEngineCoupon(coupon: CouponDto): CouponEngineCoupon {
  return {
    scope: coupon.scope,
    productIds: coupon.productIds,
    discount:
      coupon.discount.type === 'percent'
        ? { type: 'percent', percent: coupon.discount.percent }
        : { type: 'amount', amountCents: toCents(coupon.discount.amount) },
    minPurchaseCents:
      coupon.scope === 'sale' && coupon.minPurchase != null ? toCents(coupon.minPurchase) : null,
  };
}

/** Id con el que el cupón conoce al producto: el remoto (los ids locales no viajan). */
function remoteProductId(line: CartLine): string {
  return isProductLine(line) ? (line.product.remoteId ?? line.product.id) : `service:${line.service.id}`;
}

function hasPromotion(line: CartLine): boolean {
  return isProductLine(line) && !!line.promotion;
}

/**
 * Cupones de descuento en la caja (SPEC 47).
 *
 * La caja busca el código en su SQLite (llega por `GET /coupons/sync` cada hora
 * junto con las promociones), valida con **su reloj** la vigencia, los productos
 * y el mínimo, y calcula el descuento con el motor copiado del backend. El
 * servidor recalcula todo al subir la venta y, como `/sales/bulk` es offline,
 * nunca la rechaza por el cupón: si se pasó de vigencia o de usos la marca para
 * revisión. Por eso aquí `usedCount ≥ maxUses` solo avisa.
 */
@Injectable({ providedIn: 'root' })
export class CouponService {
  /** Cambia cada vez que baja un pull de cupones: la venta relee el aplicado. */
  readonly version = signal(0);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener(COUPONS_SYNCED_EVENT, () => this.version.update((value) => value + 1));
    }
  }

  /** Busca el código (normalizado allá) en la SQLite. `null` si no existe o no hay almacén. */
  async findByCode(raw: string): Promise<CouponDto | null> {
    const store = window.electronAPI?.coupons;
    if (!store || !raw.trim()) {
      return null;
    }
    try {
      return (await store.findByCode(raw)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Vigencia con el reloj local: activo y dentro de `[startsAt, endsAt]`. No
   * mira productos ni mínimo (eso depende del ticket).
   */
  windowIssue(coupon: CouponDto, now = new Date()): CouponIssue | null {
    if (!coupon.isActive) {
      return { code: 'inactive', message: `El cupón ${coupon.code} ya no está activo.` };
    }
    if (Date.parse(coupon.startsAt) > now.getTime()) {
      return {
        code: 'not_started',
        message: `El cupón ${coupon.code} es válido a partir del ${shortDate(coupon.startsAt)}.`,
      };
    }
    if (coupon.endsAt && Date.parse(coupon.endsAt) < now.getTime()) {
      return { code: 'expired', message: `El cupón ${coupon.code} ya venció.` };
    }
    return null;
  }

  /** `true` si la foto local dice que ya no quedan usos (el servidor decide). */
  maybeExhausted(coupon: CouponDto): boolean {
    return coupon.maxUses != null && coupon.usedCount >= coupon.maxUses;
  }

  /**
   * Aplica el cupón a líneas que ya traen su promoción y su descuento manual
   * (`PromoService.apply`).
   *
   * - **Producto**: cada línea de un producto del cupón y **sin promoción**
   *   recibe su parte dentro de `discountAmount` y pierde el manual (una línea
   *   con cupón no lleva descuento manual). El manual guardado no se borra:
   *   vuelve si se quita el cupón. El neto que ve el motor es entonces el
   *   importe de lista de la línea.
   * - **Venta**: las líneas quedan igual y el descuento sale sobre la suma de
   *   sus netos, como `saleDiscountAmount`.
   */
  apply(lines: CartLine[], coupon: CouponDto | null, now = new Date()): CouponPricing {
    const sinCupon = lines.map((line) => (isProductLine(line) && line.coupon ? { ...line, coupon: null } : line));
    if (!coupon) {
      return { lines: sinCupon, saleDiscount: 0, total: 0, issue: null };
    }
    const vigencia = this.windowIssue(coupon, now);
    if (vigencia) {
      return { lines: sinCupon, saleDiscount: 0, total: 0, issue: vigencia };
    }

    const engine = toEngineCoupon(coupon);
    const eligible = (line: CartLine): boolean =>
      coupon.scope === 'product' &&
      isProductLine(line) &&
      engine.productIds.includes(remoteProductId(line)) &&
      !hasPromotion(line);

    const engineLines: CouponEngineLine[] = lines.map((line) => ({
      productId: remoteProductId(line),
      pieces: linePieces(line),
      // Con cupón de producto la línea elegible no lleva manual: su neto es el
      // importe de lista. El resto conserva su neto real.
      netCents: eligible(line)
        ? toCents(lineUnitPrice(line) * line.quantity)
        : toCents(lineUnitPrice(line) * line.quantity - line.discountAmount),
      hasPromotion: hasPromotion(line),
    }));
    const result = computeCouponDiscount(engine, engineLines);

    if (result.totalCents <= 0) {
      return { lines: sinCupon, saleDiscount: 0, total: 0, issue: this.noEffectIssue(coupon, lines) };
    }

    if (coupon.scope === 'sale') {
      return {
        lines: sinCupon,
        saleDiscount: fromCents(result.saleCents),
        total: fromCents(result.totalCents),
        issue: null,
      };
    }

    const priced = lines.map((line, index) => {
      const cents = result.lines[index];
      if (!isProductLine(line) || cents <= 0) {
        return isProductLine(line) && line.coupon ? { ...line, coupon: null } : line;
      }
      const amount = fromCents(cents);
      return { ...line, discountAmount: amount, coupon: { code: coupon.code, discountAmount: amount } };
    });
    return { lines: priced, saleDiscount: 0, total: fromCents(result.totalCents), issue: null };
  }

  /**
   * `true` si la línea es de un producto del cupón pero no lo recibe porque ya
   * trae promoción: la pantalla lo explica con "ya tiene promoción".
   */
  skippedForPromotion(line: CartLine, coupon: CouponDto | null): boolean {
    return (
      !!coupon &&
      coupon.scope === 'product' &&
      isProductLine(line) &&
      hasPromotion(line) &&
      coupon.productIds.includes(remoteProductId(line))
    );
  }

  /** Resumen que se guarda con la venta y se imprime en el ticket. */
  summary(coupon: CouponDto, pricing: CouponPricing): SaleCoupon {
    return { code: coupon.code, name: coupon.name, scope: coupon.scope, discountAmount: pricing.total };
  }

  /** Explica por qué un cupón vigente no descontó nada en este ticket. */
  private noEffectIssue(coupon: CouponDto, lines: CartLine[]): CouponIssue {
    if (coupon.scope === 'product') {
      const delCupon = lines.filter(
        (line) => isProductLine(line) && coupon.productIds.includes(remoteProductId(line)),
      );
      if (delCupon.length === 0) {
        return {
          code: 'no_products',
          message: `El cupón ${coupon.code} no aplica a ningún producto del ticket.`,
        };
      }
      if (delCupon.every(hasPromotion)) {
        return {
          code: 'all_promoted',
          message: `El cupón ${coupon.code} no aplica: sus productos ya tienen promoción.`,
        };
      }
    }
    if (coupon.scope === 'sale' && coupon.minPurchase != null) {
      return {
        code: 'below_minimum',
        message: `El cupón ${coupon.code} pide una compra mínima de $${money(coupon.minPurchase)}.`,
      };
    }
    return { code: 'no_effect', message: `El cupón ${coupon.code} no tiene efecto en este ticket.` };
  }
}
