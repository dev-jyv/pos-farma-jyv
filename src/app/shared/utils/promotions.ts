import { PromotionRule } from '../models';

/**
 * Motor de promociones, **copia** de `backend-farma-jyv/functions/src/utils/promotions.ts`
 * (y del admin). Todo en centavos. Si se cambia una copia se cambian las tres: la
 * tabla de casos de `promotions.spec.ts` es la misma en los tres repos.
 */

const toCents = (value: number): number => Math.round(value * 100);

/**
 * ¿La regla tiene una forma que este motor sabe calcular? Una promo de un tipo
 * que esta versión no conoce (el backend se actualiza antes que las cajas) o con
 * campos faltantes se trata como **sin descuento**, en vez de tronar: un error
 * aquí dejaba sin poder vender el producto en cada cambio del ticket.
 */
export const isSupportedRule = (rule: unknown): rule is PromotionRule => {
  if (!rule || typeof rule !== 'object') {
    return false;
  }
  const candidate = rule as Record<string, unknown>;
  const isInt = (value: unknown, min: number): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value >= min;
  if (candidate['type'] === 'tiered') {
    const tiers = candidate['tiers'];
    return (
      Array.isArray(tiers) &&
      tiers.length > 0 &&
      tiers.every(
        (tier) =>
          Boolean(tier) &&
          isInt(tier.quantity, 1) &&
          typeof tier.price === 'number' &&
          Number.isFinite(tier.price) &&
          tier.price > 0,
      )
    );
  }
  if (candidate['type'] === 'nxm') {
    return isInt(candidate['buy'], 1) && isInt(candidate['pay'], 0);
  }
  if (candidate['type'] === 'percent') {
    const percent = candidate['percent'];
    return typeof percent === 'number' && Number.isFinite(percent) && isInt(candidate['minQty'], 1);
  }
  return false;
};

export const promotionCostCents = (
  rule: PromotionRule,
  unitCents: number,
  quantity: number,
): number => {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return quantity > 0 ? Math.round(unitCents * quantity) : 0;
  }
  const listCents = unitCents * quantity;
  if (!isSupportedRule(rule)) {
    return listCents;
  }

  if (rule.type === 'nxm') {
    if (rule.buy <= 0 || rule.pay < 0 || rule.pay >= rule.buy) {
      return listCents;
    }
    const bundles = Math.floor(quantity / rule.buy);
    return bundles * rule.pay * unitCents + (quantity % rule.buy) * unitCents;
  }

  if (rule.type === 'percent') {
    if (quantity < rule.minQty || rule.percent <= 0) {
      return listCents;
    }
    return listCents - Math.round((listCents * rule.percent) / 100);
  }

  const tiers = rule.tiers
    .filter((tier) => tier.quantity > 0)
    .map((tier) => ({ quantity: tier.quantity, cents: toCents(tier.price) }));
  const cost = new Array<number>(quantity + 1);
  cost[0] = 0;
  for (let k = 1; k <= quantity; k += 1) {
    let best = cost[k - 1] + unitCents;
    for (const tier of tiers) {
      if (tier.quantity <= k) {
        const candidate = cost[k - tier.quantity] + tier.cents;
        if (candidate < best) {
          best = candidate;
        }
      }
    }
    cost[k] = best;
  }
  return Math.min(cost[quantity], listCents);
};

/** ¿Llevar una pieza más nunca cuesta menos? El backend rechaza las que no. */
export const isPromotionMonotonic = (rule: PromotionRule, unitPrice: number): boolean => {
  const unitCents = toCents(unitPrice);
  const horizon =
    rule.type === 'tiered'
      ? 2 * Math.max(...rule.tiers.map((tier) => tier.quantity))
      : rule.type === 'nxm'
        ? 2 * rule.buy
        : rule.minQty + 1;
  let previous = 0;
  for (let k = 1; k <= horizon; k += 1) {
    const cost = promotionCostCents(rule, unitCents, k);
    if (cost < previous) {
      return false;
    }
    previous = cost;
  }
  return true;
};

export const computePromotionDiscount = (
  rule: PromotionRule,
  unitPrice: number,
  quantity: number,
): number => {
  const unitCents = toCents(unitPrice);
  const discount = unitCents * quantity - promotionCostCents(rule, unitCents, quantity);
  return Math.max(0, discount) / 100;
};

/** La de mayor descuento; no se acumulan. En empate gana la primera. */
export const pickBestPromotion = <T extends { rule: PromotionRule }>(
  candidates: T[],
  unitPrice: number,
  quantity: number,
): { promotion: T; discountAmount: number } | null => {
  let best: { promotion: T; discountAmount: number } | null = null;
  for (const promotion of candidates) {
    const discountAmount = computePromotionDiscount(promotion.rule, unitPrice, quantity);
    if (discountAmount > 0 && (!best || discountAmount > best.discountAmount)) {
      best = { promotion, discountAmount };
    }
  }
  return best;
};
