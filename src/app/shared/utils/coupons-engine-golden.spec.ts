import { describe, expect, it } from 'vitest';

import cases from './coupons-engine.cases.json';
import { CouponEngineCoupon, CouponEngineLine, CouponEngineResult, computeCouponDiscount } from './coupons';

/**
 * Casos dorados del motor de cupones (SPEC 47). `coupons-engine.cases.json` es
 * el MISMO archivo en el backend y en el POS (`npm run check:promo-engine`
 * compara los sha256): si esta prueba falla, la caja ya no cobra lo mismo que el
 * servidor. No se edita el JSON para que pase; se corrige el motor en los dos.
 * El archivo lo genera el backend (`scripts/generate-coupons-engine-cases.mjs`)
 * e incluye formas que el motor no conoce (alcance `category`, tipos o campos
 * faltantes): una caja vieja debe darles cero, no tronar.
 */
interface CouponCase {
  name: string;
  coupon: CouponEngineCoupon;
  lines: CouponEngineLine[];
  expected: CouponEngineResult;
}

const golden = cases as unknown as { cases: CouponCase[] };

describe('motor de cupones: casos dorados', () => {
  it('el archivo trae casos de los dos alcances (y formas desconocidas a propósito)', () => {
    const scopes = new Set(golden.cases.map((c) => c.coupon.scope));
    expect(scopes).toContain('product');
    expect(scopes).toContain('sale');
    expect(golden.cases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(computeCouponDiscount(c.coupon, c.lines)).toEqual(c.expected);
  });
});
