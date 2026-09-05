import { Injectable } from '@angular/core';

import { CartLine, CartProductLine } from '../../../shared/models';
import { isProductLine, lineKey, lineUnitPrice } from '../../../shared/utils/cart-line';
import { environment } from '../../../../environments/environment';

export type PromoRule =
  | {
      type: 'nxm';
      buy: number;
      pay: number;
      skus?: string[];
      productIds?: string[];
    }
  | {
      type: 'percent';
      percent: number;
      minQty: number;
      skus?: string[];
      productIds?: string[];
    };

@Injectable({ providedIn: 'root' })
export class PromoService {
  /**
   * `manualByKey` se indexa por `lineKey`, no por id de producto: dos líneas de
   * servicio del mismo tipo pueden convivir en el ticket (una por doctor) y
   * necesitan descuentos independientes.
   */
  apply(lines: CartLine[], manualByKey: Record<string, number> = {}): CartLine[] {
    const rules = (environment.promos ?? []) as PromoRule[];
    return lines.map((line) => {
      const promoDiscount = this.promoDiscountForLine(line, rules);
      const manual = Math.max(0, manualByKey[lineKey(line)] ?? 0);
      const lineTotal = lineUnitPrice(line) * line.quantity;
      return {
        ...line,
        discountAmount: Math.min(lineTotal, promoDiscount + manual),
      };
    });
  }

  promoOnlyDiscount(line: CartLine): number {
    return this.promoDiscountForLine(line, (environment.promos ?? []) as PromoRule[]);
  }

  private promoDiscountForLine(line: CartLine, rules: PromoRule[]): number {
    // Las promociones son del catálogo de farmacia. Una regla sin filtros
    // aplica "a todo" (ver `matches`), y sin este corte una promo 2x1 general
    // regalaría consultas médicas.
    if (!isProductLine(line)) {
      return 0;
    }
    let best = 0;
    for (const rule of rules) {
      if (!this.matches(line, rule)) {
        continue;
      }
      if (rule.type === 'nxm') {
        if (rule.buy <= 0 || rule.pay < 0 || rule.pay >= rule.buy) {
          continue;
        }
        const freeUnits = Math.floor(line.quantity / rule.buy) * (rule.buy - rule.pay);
        best = Math.max(best, freeUnits * line.product.salePrice);
      } else if (rule.type === 'percent') {
        if (line.quantity < rule.minQty || rule.percent <= 0) {
          continue;
        }
        best = Math.max(best, (line.product.salePrice * line.quantity * rule.percent) / 100);
      }
    }
    return Math.round(best * 100) / 100;
  }

  private matches(line: CartProductLine, rule: PromoRule): boolean {
    const { skus, productIds } = rule;
    if ((!skus || skus.length === 0) && (!productIds || productIds.length === 0)) {
      return true;
    }
    if (productIds?.includes(line.product.id)) {
      return true;
    }
    if (skus?.includes(line.product.sku)) {
      return true;
    }
    return false;
  }
}
