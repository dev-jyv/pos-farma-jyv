import { Product, SaleItemTaxes, SaleTaxSummary } from '../models';
import { fromCents, toCents } from './money';

/**
 * Desglose fiscal para precios **con impuestos incluidos** — espejo de
 * `backend-farma-jyv/functions/src/utils/taxes.ts`.
 *
 * El precio de catálogo es precio al público: lo que dice la etiqueta es lo que se
 * cobra, y el desglose se calcula hacia atrás. Orden legal en México: el IEPS va
 * sobre la base y el IVA sobre (base + IEPS):
 *
 *   gross = base * (1 + iepsRate) * (1 + ivaRate)
 *
 * El residuo de redondeo se absorbe en la base para que `base + ieps + iva` sea
 * exactamente el importe cobrado; un desglose que no suma el total es rechazado al
 * timbrar el CFDI.
 *
 * En el POS se usa solo para **mostrar** el desglose antes de cobrar y para el
 * ticket de una venta encolada sin conexión. La venta persistida siempre lleva el
 * desglose que calculó el backend.
 */

export const IVA_RATE = 0.16;
export const IVA_ZERO_RATE = 0;

type TaxableProduct = Pick<Product, 'hasIva' | 'hasIvaZero' | 'hasIeps' | 'iepsRate'>;

/** Tasa de IVA efectiva; `hasIvaZero` gana sobre `hasIva` (medicinas de patente). */
export function resolveIvaRate(product: TaxableProduct): number {
  if (product.hasIvaZero) {
    return IVA_ZERO_RATE;
  }
  return product.hasIva ? IVA_RATE : 0;
}

export function resolveIepsRate(product: TaxableProduct): number {
  return product.hasIeps ? (product.iepsRate ?? 0) : 0;
}

export function breakdownWithRates(input: {
  grossAmount: number;
  ivaRate: number;
  iepsRate: number;
}): SaleItemTaxes {
  const { ivaRate, iepsRate } = input;
  const grossCents = toCents(input.grossAmount);

  const baseCents = Math.round(grossCents / ((1 + iepsRate) * (1 + ivaRate)));
  const iepsCents = Math.round(baseCents * iepsRate);
  const ivaCents = Math.round((baseCents + iepsCents) * ivaRate);

  return {
    base: fromCents(grossCents - iepsCents - ivaCents),
    ivaRate,
    ivaAmount: fromCents(ivaCents),
    iepsRate,
    iepsAmount: fromCents(iepsCents),
  };
}

export function breakdownLineTaxes(
  input: TaxableProduct & { grossAmount: number },
): SaleItemTaxes {
  return breakdownWithRates({
    grossAmount: input.grossAmount,
    ivaRate: resolveIvaRate(input),
    iepsRate: resolveIepsRate(input),
  });
}

export function sumTaxSummary(breakdowns: SaleItemTaxes[]): SaleTaxSummary {
  let baseCents = 0;
  let ivaCents = 0;
  let iepsCents = 0;

  for (const breakdown of breakdowns) {
    baseCents += toCents(breakdown.base);
    ivaCents += toCents(breakdown.ivaAmount);
    iepsCents += toCents(breakdown.iepsAmount);
  }

  return {
    base: fromCents(baseCents),
    ivaTotal: fromCents(ivaCents),
    iepsTotal: fromCents(iepsCents),
    taxTotal: fromCents(ivaCents + iepsCents),
    total: fromCents(baseCents + ivaCents + iepsCents),
  };
}

/**
 * Reparte un descuento a nivel venta proporcional al importe de cada partida. Debe
 * prorratearse **antes** de calcular impuestos: si no, se declara IVA sobre un
 * importe que nunca se cobró. Los centavos sobrantes se cargan a la partida mayor.
 */
export function prorateDiscount(lineAmounts: number[], discountAmount: number): number[] {
  const totalCents = lineAmounts.reduce((sum, amount) => sum + toCents(amount), 0);
  const discountCents = toCents(discountAmount);

  if (discountCents <= 0 || totalCents <= 0) {
    return lineAmounts.map(() => 0);
  }
  if (discountCents >= totalCents) {
    return [...lineAmounts];
  }

  const shares = lineAmounts.map((amount) =>
    Math.floor((toCents(amount) * discountCents) / totalCents),
  );
  let remainder = discountCents - shares.reduce((sum, share) => sum + share, 0);

  const order = lineAmounts
    .map((amount, index) => ({ index, cents: toCents(amount) }))
    .sort((a, b) => b.cents - a.cents);

  let cursor = 0;
  while (remainder > 0 && order.length > 0) {
    const { index } = order[cursor % order.length];
    if (shares[index] < toCents(lineAmounts[index])) {
      shares[index] += 1;
      remainder -= 1;
    }
    cursor += 1;
    if (cursor > order.length * 100) {
      break;
    }
  }

  return shares.map(fromCents);
}

export interface TaxPreviewLine {
  product: TaxableProduct;
  /** Importe cobrado por la partida, ya con descuentos de línea aplicados. */
  grossAmount: number;
}

/**
 * Desglose del ticket completo antes de cobrar: prorratea el descuento de venta y
 * suma las partidas con la misma secuencia que `createSale` en el backend.
 */
export function previewTaxSummary(
  lines: TaxPreviewLine[],
  saleDiscountAmount = 0,
): SaleTaxSummary {
  const shares = prorateDiscount(
    lines.map((line) => line.grossAmount),
    saleDiscountAmount,
  );
  return sumTaxSummary(
    lines.map((line, index) =>
      breakdownLineTaxes({
        ...line.product,
        grossAmount: fromCents(toCents(line.grossAmount) - toCents(shares[index])),
      }),
    ),
  );
}
