import { describe, expect, it } from 'vitest';

import { PromotionRule } from '../models';
import { computePromotionDiscount, pickBestPromotion, promotionCostCents } from './promotions';

/**
 * Misma tabla que `backend-farma-jyv/functions/test/promotions-engine.spec.ts`.
 * Si un caso cambia aquí, cambia allá y en el POS: la vista previa del admin
 * tiene que mostrar el mismo centavo que cobra la caja.
 */
const PARACETAMOL: PromotionRule = { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] };
const ESCALONADO: PromotionRule = {
  type: 'tiered',
  tiers: [
    { quantity: 2, price: 60 },
    { quantity: 5, price: 140 },
  ],
};
const DOS_POR_UNO: PromotionRule = { type: 'nxm', buy: 2, pay: 1 };
const TRES_POR_DOS: PromotionRule = { type: 'nxm', buy: 3, pay: 2 };
const DIEZ_POR_CIENTO_DESDE_3: PromotionRule = { type: 'percent', percent: 10, minQty: 3 };

const CASES: Array<[string, PromotionRule, number, number, number]> = [
  ['paracetamol: 1 pieza no llega al paquete', PARACETAMOL, 35, 1, 0],
  ['paracetamol: 2 por $60', PARACETAMOL, 35, 2, 10],
  ['paracetamol: 3 = 60 + 35', PARACETAMOL, 35, 3, 10],
  ['paracetamol: 4 = 2 paquetes', PARACETAMOL, 35, 4, 20],
  ['escalonado: 5 toma el paquete grande', ESCALONADO, 35, 5, 35],
  ['escalonado: 7 = 140 + 60', ESCALONADO, 35, 7, 45],
  ['2x1 con 3 piezas', DOS_POR_UNO, 20, 3, 20],
  ['3x2 con 6 piezas', TRES_POR_DOS, 12.5, 6, 25],
  ['% debajo del mínimo', DIEZ_POR_CIENTO_DESDE_3, 33.33, 2, 0],
  ['% redondea al centavo', DIEZ_POR_CIENTO_DESDE_3, 33.33, 3, 10],
  ['paquete más caro que sueltas no aplica', PARACETAMOL, 25, 2, 0],
];

describe('shared/utils/promotions', () => {
  it.each(CASES)('%s', (_label, rule, unitPrice, quantity, expected) => {
    expect(computePromotionDiscount(rule, unitPrice, quantity)).toBe(expected);
  });

  it('promotionCostCents es lo que se cobra por k piezas', () => {
    expect(promotionCostCents(PARACETAMOL, 3500, 0)).toBe(0);
    expect(promotionCostCents(PARACETAMOL, 3500, 1)).toBe(3500);
    expect(promotionCostCents(PARACETAMOL, 3500, 2)).toBe(6000);
    expect(promotionCostCents(PARACETAMOL, 3500, 3)).toBe(9500);
  });

  it('pickBestPromotion elige la de mayor descuento y no acumula', () => {
    const best = pickBestPromotion(
      [
        { id: 'a', rule: PARACETAMOL },
        { id: 'b', rule: DOS_POR_UNO },
      ],
      35,
      2,
    );
    expect(best).toEqual({ promotion: { id: 'b', rule: DOS_POR_UNO }, discountAmount: 35 });
    expect(pickBestPromotion([{ id: 'a', rule: PARACETAMOL }], 35, 1)).toBeNull();
  });
});
