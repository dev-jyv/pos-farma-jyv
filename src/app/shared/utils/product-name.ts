/**
 * Mismas reglas que `electron/db/products.js`: el servidor no admite dos
 * productos con el mismo nombre, y un alta local repetida se queda rechazada
 * en la cola para siempre.
 */

/** Nombre comparable: sin mayúsculas ni espacios de más. */
export function normalizeProductName(name: string | null | undefined): string {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Nombre para desempatar: el nombre más el código de barras (o el SKU si no hay). */
export function suggestProductName(fields: {
  name: string;
  barcode?: string | null;
  sku?: string | null;
}): string {
  const base = fields.name.trim().replace(/\s+/g, ' ');
  const suffix = fields.barcode?.trim() || fields.sku?.trim() || '';
  return suffix ? `${base} ${suffix}` : base;
}
