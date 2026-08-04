/**
 * Aritmética de dinero en centavos.
 *
 * El backend (`functions/src/utils/taxes.ts`) compara y suma importes en
 * centavos enteros; el POS debe usar la misma regla o el cambio y el "faltan"
 * de la caja se separan del total que valida la API por errores de coma
 * flotante (`0.1 + 0.2`).
 */

/** Redondeo a centavo entero, estable para valores negativos. */
export function toCents(amount: number): number {
  return Math.round((Number.isFinite(amount) ? amount : 0) * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** Redondea un importe a 2 decimales sin arrastrar residuos binarios. */
export function roundMoney(amount: number): number {
  return fromCents(toCents(amount));
}

export function addMoney(...amounts: number[]): number {
  return fromCents(amounts.reduce((sum, amount) => sum + toCents(amount), 0));
}

export function subtractMoney(minuend: number, subtrahend: number): number {
  return fromCents(toCents(minuend) - toCents(subtrahend));
}

/** `-1 | 0 | 1` comparando en centavos. */
export function compareMoney(left: number, right: number): -1 | 0 | 1 {
  const difference = toCents(left) - toCents(right);
  if (difference === 0) {
    return 0;
  }
  return difference > 0 ? 1 : -1;
}

export function isMoneyGreaterOrEqual(left: number, right: number): boolean {
  return compareMoney(left, right) >= 0;
}
