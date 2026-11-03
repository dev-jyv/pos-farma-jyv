import {
  CartLine,
  CartProductLine,
  CartServiceLine,
  PharmacyService,
  Product,
  hasBoxSale,
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
  if (isProductLine(line)) {
    // La caja es otra partida del mismo producto (SPEC 46): una caja y piezas
    // sueltas conviven en el ticket con precio, cantidad y descuento propios.
    return isBoxLine(line) ? `product:${line.product.id}:box` : `product:${line.product.id}`;
  }
  return `service:${line.service.id}:${line.provider?.id ?? '-'}`;
}

/** `true` si la línea se cobra por caja completa (y el producto aún la admite). */
export function isBoxLine(line: CartLine): line is CartProductLine & { saleUnit: 'box' } {
  return isProductLine(line) && line.saleUnit === 'box';
}

/** Piezas por caja de la línea; 1 si es por pieza o un servicio. */
export function linePiecesPerUnit(line: CartLine): number {
  return isBoxLine(line) ? (line.product.boxQuantity ?? 1) : 1;
}

/**
 * Piezas que mueve la línea: lo que se descuenta del stock. Una caja de 10 son
 * 10; un servicio, 0 (no tiene existencias).
 */
export function linePieces(line: CartLine): number {
  return isProductLine(line) ? line.quantity * linePiecesPerUnit(line) : 0;
}

/** Cajas completas que caben en `pieces` (para "35 pzas · 3 cajas completas"). */
export function fullBoxes(product: Pick<Product, 'stock' | 'boxQuantity'>): number {
  const perBox = product.boxQuantity ?? 0;
  return perBox >= 2 ? Math.floor(Math.max(0, product.stock) / perBox) : 0;
}

/** Existencias en piezas y, si se vende por caja, en cajas completas. */
export function stockLabel(product: Product): string {
  const piezas = `${product.stock} ${product.stock === 1 ? 'pza' : 'pzas'}`;
  if (!hasBoxSale(product)) {
    return piezas;
  }
  const cajas = fullBoxes(product);
  return `${piezas} · ${cajas} ${cajas === 1 ? 'caja completa' : 'cajas completas'}`;
}

export function lineName(line: CartLine): string {
  return isProductLine(line) ? line.product.name : line.service.name;
}

/** Segunda línea del renglón: principio activo o el código del servicio. */
export function lineSubtitle(line: CartLine): string {
  return isProductLine(line) ? (line.product.activeIngredient ?? '') : line.service.code;
}

/** Precio de la unidad de la línea: pieza, caja (`boxPrice`) o servicio. */
export function lineUnitPrice(line: CartLine): number {
  if (isBoxLine(line)) {
    return line.product.boxPrice ?? 0;
  }
  return isProductLine(line) ? line.product.salePrice : line.service.price;
}

/**
 * Tope de cantidad **de la línea sola**, en su unidad (piezas o cajas
 * completas). `null` en un servicio: no hay existencias que agotar, así que el
 * botón "+" nunca se deshabilita. Si el mismo producto va también en otra línea
 * (caja y piezas), la pantalla descuenta lo que esa otra ya aparta.
 */
export function lineMaxQuantity(line: CartLine): number | null {
  if (!isProductLine(line)) {
    return null;
  }
  return isBoxLine(line) ? fullBoxes(line.product) : line.product.stock;
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
    saleUnit?: unknown;
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
  if (!line.product) {
    return null;
  }
  // Una caja guardada solo vuelve como caja si el producto la sigue trayendo;
  // si no, se descarta la línea en vez de cobrarla como piezas a otro precio
  // (`refreshStaleProducts` avisa si el catálogo cambió después).
  if (line.saleUnit === 'box') {
    return hasBoxSale(line.product)
      ? { kind: 'product', product: line.product, quantity, discountAmount, saleUnit: 'box' }
      : null;
  }
  return { kind: 'product', product: line.product, quantity, discountAmount };
}

function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}
