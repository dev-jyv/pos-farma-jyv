import {
  CartLine,
  CartProductLine,
  CartServiceLine,
  PharmacyService,
  Product,
} from '../models';

/**
 * Utilidades para leer una línea del ticket sin ramificar por tipo en cada
 * plantilla y cada componente.
 *
 * `CartLine` es una unión discriminada (producto | servicio). Sin estas
 * funciones, cada sitio que pinta el ticket tendría su propio `if`, y el
 * primero que se olvide de uno lee `line.product` en una línea de servicio.
 * Son puras a propósito: se prueban solas, sin TestBed.
 */

export function isProductLine(line: CartLine): line is CartProductLine {
  return line.kind === 'product';
}

export function isServiceLine(line: CartLine): line is CartServiceLine {
  return line.kind === 'service';
}

/**
 * Identidad de la línea, y la clave con la que se indexan los descuentos
 * manuales y el `track` de la plantilla.
 *
 * **El doctor forma parte de la identidad**: dos consultas del mismo servicio
 * realizadas por dos doctores distintos son dos partidas con dos comisiones, no
 * una con cantidad 2. Cambiar el doctor de una línea, por tanto, la reemplaza.
 */
export function lineKey(line: CartLine): string {
  return isProductLine(line)
    ? `product:${line.product.id}`
    : `service:${line.service.id}:${line.provider?.id ?? '-'}`;
}

export function lineName(line: CartLine): string {
  return isProductLine(line) ? line.product.name : line.service.name;
}

/** Segunda línea del renglón: principio activo o el código del servicio. */
export function lineSubtitle(line: CartLine): string {
  return isProductLine(line) ? (line.product.activeIngredient ?? '') : line.service.code;
}

export function lineUnitPrice(line: CartLine): number {
  return isProductLine(line) ? line.product.salePrice : line.service.price;
}

/**
 * Tope de cantidad. `null` en un servicio: no hay existencias que agotar, así
 * que el botón "+" nunca se deshabilita.
 */
export function lineMaxQuantity(line: CartLine): number | null {
  return isProductLine(line) ? line.product.stock : null;
}

/** Importe cobrado por la línea, impuestos incluidos. */
export function lineGross(line: CartLine): number {
  return lineUnitPrice(line) * line.quantity - line.discountAmount;
}

/**
 * Comisión devengada por la línea. Se calcula sobre el importe neto y con la
 * tasa vigente del catálogo; el valor **congelado** se persiste al crear la
 * venta, porque la tasa puede cambiar después y lo devengado no.
 *
 * Si el servicio no define tasa, se usa la del doctor.
 */
export function lineCommission(line: CartLine): number {
  if (!isServiceLine(line)) {
    return 0;
  }
  const rate = line.service.commissionRate || line.provider?.defaultCommissionRate || 0;
  return Math.round(lineGross(line) * (rate / 100) * 100) / 100;
}

export function lineCommissionRate(line: CartLine): number {
  if (!isServiceLine(line)) {
    return 0;
  }
  return line.service.commissionRate || line.provider?.defaultCommissionRate || 0;
}

/** `true` si falta elegir el doctor de un servicio que lo exige: bloquea el cobro. */
export function lineNeedsProvider(line: CartLine): boolean {
  return isServiceLine(line) && line.service.requiresPerformer === true && line.provider === null;
}

/**
 * Banderas fiscales para `shared/utils/taxes.ts`, que tipa por forma
 * (`hasIva`/`hasIvaZero`/`hasIeps`/`iepsRate`). Un servicio no las tiene, así
 * que su `taxMode` se traduce aquí: `exempt` y `zero` dan $0 de IVA por igual,
 * y la distinción fiscal se conserva en el documento de la venta, no en el
 * cálculo. Gracias a esto, un ticket mixto desglosa impuestos sin tocar
 * `taxes.ts`.
 */
export function lineTaxable(
  line: CartLine,
): Pick<Product, 'hasIva' | 'hasIvaZero' | 'hasIeps' | 'iepsRate'> {
  if (isProductLine(line)) {
    return line.product;
  }
  return serviceTaxFlags(line.service);
}

export function serviceTaxFlags(
  service: PharmacyService,
): Pick<Product, 'hasIva' | 'hasIvaZero' | 'hasIeps' | 'iepsRate'> {
  return {
    hasIva: service.taxMode === 'iva16',
    hasIvaZero: service.taxMode !== 'iva16',
    hasIeps: service.hasIeps === true,
    iepsRate: service.iepsRate ?? undefined,
  };
}

/** Total de la parte de farmacia del ticket. */
export function pharmacyTotalOf(lines: CartLine[]): number {
  return round(lines.filter(isProductLine).reduce((total, line) => total + lineGross(line), 0));
}

/** Total de la parte de servicios del ticket. */
export function servicesTotalOf(lines: CartLine[]): number {
  return round(lines.filter(isServiceLine).reduce((total, line) => total + lineGross(line), 0));
}

export function commissionTotalOf(lines: CartLine[]): number {
  return round(lines.reduce((total, line) => total + lineCommission(line), 0));
}

/**
 * Reparto del efectivo entre los dos bloques del corte: **servicios primero**.
 * El efectivo cubre antes las consultas y el resto se atribuye a farmacia; en
 * un pago mixto, la tarjeta absorbe lo que quede de farmacia.
 *
 * Es la misma regla que aplica el backend de forma autoritativa y la que espeja
 * el corte local, y por eso vive aquí y no repetida en cada lado: si divergen,
 * el reporte y el corte dejan de cuadrar entre sí.
 */
export function splitCash(
  cashAmount: number,
  servicesTotal: number,
): { servicesCashAmount: number; pharmacyCashAmount: number } {
  const efectivo = Math.max(0, cashAmount);
  const servicios = round(Math.min(efectivo, Math.max(0, servicesTotal)));
  return { servicesCashAmount: servicios, pharmacyCashAmount: round(efectivo - servicios) };
}

/**
 * Rehidrata una línea guardada en `localStorage`. Un ticket autoguardado o en
 * pausa **antes** de los servicios no trae `kind`: sin esto, el primer cajero
 * que recupere un ticket viejo vería la pantalla romperse.
 */
export function normalizeStoredLine(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  // Forma cruda de `localStorage`: puede ser una línea vieja sin `kind`, así que
  // no se puede tipar como `CartLine` (la intersección de la unión es `never`).
  const line = raw as {
    kind?: string;
    product?: Product;
    service?: PharmacyService;
    provider?: CartServiceLine['provider'];
    quantity?: unknown;
    discountAmount?: unknown;
  };
  const quantity = Number(line.quantity);
  const discountAmount = Number(line.discountAmount ?? 0);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }

  if (line.kind === 'service') {
    return line.service
      ? { kind: 'service', service: line.service, provider: line.provider ?? null, quantity, discountAmount }
      : null;
  }
  // Sin `kind` o con `kind: 'product'`: línea de producto.
  return line.product ? { kind: 'product', product: line.product, quantity, discountAmount } : null;
}

function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}
