import { describe, expect, it } from 'vitest';

import { toCents } from './money';
import {
  breakdownLineTaxes,
  prorateDiscount,
  previewTaxSummary,
  resolveIepsRate,
  resolveIvaRate,
  sumTaxSummary,
} from './taxes';

describe('resolveIvaRate / resolveIepsRate', () => {
  it('IVA 0% gana sobre IVA 16% (medicinas de patente)', () => {
    expect(resolveIvaRate({ hasIva: true, hasIvaZero: true })).toBe(0);
    expect(resolveIvaRate({ hasIva: true, hasIvaZero: false })).toBe(0.16);
    expect(resolveIvaRate({ hasIva: false, hasIvaZero: false })).toBe(0);
  });

  it('sin `hasIeps` la tasa es 0 aunque el producto traiga una', () => {
    expect(resolveIepsRate({ hasIeps: false, iepsRate: 0.08 })).toBe(0);
    expect(resolveIepsRate({ hasIeps: true, iepsRate: 0.08 })).toBe(0.08);
    expect(resolveIepsRate({ hasIeps: true })).toBe(0);
  });
});

describe('breakdownLineTaxes', () => {
  it('desglosa hacia atrás un precio con IVA incluido', () => {
    const taxes = breakdownLineTaxes({
      grossAmount: 116,
      hasIva: true,
      hasIvaZero: false,
      hasIeps: false,
    });

    expect(taxes.base).toBe(100);
    expect(taxes.ivaAmount).toBe(16);
    expect(taxes.iepsAmount).toBe(0);
  });

  it('medicina con IVA 0%: todo es base', () => {
    const taxes = breakdownLineTaxes({
      grossAmount: 87.5,
      hasIva: false,
      hasIvaZero: true,
      hasIeps: false,
    });

    expect(taxes.base).toBe(87.5);
    expect(taxes.ivaAmount).toBe(0);
  });

  it('IEPS va sobre la base y el IVA sobre base + IEPS', () => {
    const taxes = breakdownLineTaxes({
      grossAmount: 100,
      hasIva: true,
      hasIvaZero: false,
      hasIeps: true,
      iepsRate: 0.08,
    });

    // base * 1.08 * 1.16 = 100 → base ≈ 79.82, IEPS 8% sobre base, IVA 16% sobre base + IEPS
    expect(taxes.base).toBe(79.82);
    expect(taxes.iepsAmount).toBe(6.39);
    expect(taxes.ivaAmount).toBe(13.79);
    // Invariante que exige el PAC: el desglose suma el importe cobrado al centavo.
    expect(toCents(taxes.base + taxes.iepsAmount + taxes.ivaAmount)).toBe(toCents(100));
  });

  it('el residuo de redondeo se absorbe en la base', () => {
    const taxes = breakdownLineTaxes({
      grossAmount: 33.33,
      hasIva: true,
      hasIvaZero: false,
      hasIeps: false,
    });

    expect(toCents(taxes.base + taxes.ivaAmount)).toBe(toCents(33.33));
  });
});

describe('sumTaxSummary', () => {
  it('suma en centavos y el total cuadra con las partidas', () => {
    const summary = sumTaxSummary([
      breakdownLineTaxes({ grossAmount: 116, hasIva: true, hasIvaZero: false, hasIeps: false }),
      breakdownLineTaxes({ grossAmount: 50, hasIva: false, hasIvaZero: true, hasIeps: false }),
    ]);

    expect(summary.base).toBe(150);
    expect(summary.ivaTotal).toBe(16);
    expect(summary.taxTotal).toBe(16);
    expect(summary.total).toBe(166);
  });
});

describe('prorateDiscount', () => {
  it('reparte proporcional al importe', () => {
    expect(prorateDiscount([100, 300], 40)).toEqual([10, 30]);
  });

  it('los centavos sobrantes van a la partida mayor', () => {
    const shares = prorateDiscount([10, 20, 30], 0.01);

    expect(shares.reduce((sum, share) => sum + toCents(share), 0)).toBe(1);
    expect(shares[2]).toBe(0.01);
  });

  it('un descuento igual o mayor al total consume cada partida', () => {
    expect(prorateDiscount([10, 20], 100)).toEqual([10, 20]);
    expect(prorateDiscount([10, 20], 0)).toEqual([0, 0]);
  });
});

describe('previewTaxSummary', () => {
  it('prorratea el descuento de venta antes de calcular impuestos', () => {
    const lines = [
      { product: { hasIva: true, hasIvaZero: false, hasIeps: false }, grossAmount: 116 },
      { product: { hasIva: true, hasIvaZero: false, hasIeps: false }, grossAmount: 116 },
    ];

    const withoutDiscount = previewTaxSummary(lines);
    const withDiscount = previewTaxSummary(lines, 23.2);

    expect(withoutDiscount.total).toBe(232);
    expect(withDiscount.total).toBe(208.8);
    // El IVA baja con el descuento: declararlo completo sería IVA sobre dinero no cobrado.
    expect(withDiscount.ivaTotal).toBeLessThan(withoutDiscount.ivaTotal);
    expect(toCents(withDiscount.base + withDiscount.taxTotal)).toBe(toCents(withDiscount.total));
  });
});
