import { describe, expect, it } from 'vitest';

import { PromotionRule } from '../models';
import cases from './promotions-engine.cases.json';
import { computePromotionDiscount, isPromotionMonotonic, pickBestPromotion } from './promotions';

/**
 * Casos dorados del motor. `promotions-engine.cases.json` es IDÉNTICO en el
 * backend, el admin y el POS (`npm run check:promo-engine` compara los sha256):
 * si esta prueba falla, la caja ya no cobra lo mismo que la vista previa del
 * admin ni que el backend. No se edita el JSON para que pase; se corrige el
 * motor en los tres.
 */
interface DiscountCase {
  rule: PromotionRule;
  unitPrice: number;
  quantity: number;
  discount: number;
}

interface MonotonicCase {
  rule: PromotionRule;
  unitPrice: number;
  monotonic: boolean;
}

interface PickBestCase {
  candidates: Array<{ id: string; rule: PromotionRule }>;
  unitPrice: number;
  quantity: number;
  expected: { id: string; discountAmount: number } | null;
}

const golden = cases as unknown as {
  version: number;
  discount: DiscountCase[];
  monotonic: MonotonicCase[];
  pickBest: PickBestCase[];
};

const label = (rule: PromotionRule): string => JSON.stringify(rule);

describe('motor de promociones: casos dorados', () => {
  it('el archivo trae casos de las tres funciones', () => {
    expect(golden.version).toBe(1);
    expect(golden.discount.length).toBeGreaterThan(0);
    expect(golden.monotonic.length).toBeGreaterThan(0);
    expect(golden.pickBest.length).toBeGreaterThan(0);
  });

  it.each(golden.discount.map((c) => [label(c.rule), c.unitPrice, c.quantity, c] as const))(
    'descuento de %s a $%s × %s',
    (_rule, _unitPrice, _quantity, c) => {
      expect(computePromotionDiscount(c.rule, c.unitPrice, c.quantity)).toBe(c.discount);
    },
  );

  it.each(golden.monotonic.map((c) => [label(c.rule), c.unitPrice, c] as const))(
    'monotonía de %s a $%s',
    (_rule, _unitPrice, c) => {
      expect(isPromotionMonotonic(c.rule, c.unitPrice)).toBe(c.monotonic);
    },
  );

  it.each(golden.pickBest.map((c, index) => [index, c] as const))(
    'mejor promoción, caso %s',
    (_index, c) => {
      const best = pickBestPromotion(c.candidates, c.unitPrice, c.quantity);
      expect(best ? { id: best.promotion.id, discountAmount: best.discountAmount } : null).toEqual(
        c.expected,
      );
    },
  );
});
