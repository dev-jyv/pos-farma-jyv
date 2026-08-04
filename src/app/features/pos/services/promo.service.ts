import { Injectable } from '@angular/core';

import { CartLine } from '../../../shared/models';
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
  apply(lines: CartLine[], manualByProductId: Record<string, number> = {}): CartLine[] {
    const rules = (environment.promos ?? []) as PromoRule[];
    return lines.map((line) => {
      const promoDiscount = this.promoDiscountForLine(line, rules);
      const manual = Math.max(0, manualByProductId[line.product.id] ?? 0);
      const lineTotal = line.product.salePrice * line.quantity;
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

  private matches(line: CartLine, rule: PromoRule): boolean {
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
