/**
 * Regla única de adopción de productos entre cajas (SPEC 60).
 *
 * Dos cajas sin red pueden dar de alta el mismo producto, y el servidor responde
 * 409 al segundo (por SKU o por nombre). Antes la caja adoptaba **cualquier**
 * producto remoto con el mismo SKU —aunque fuera otro— y descartaba en silencio
 * su nombre y su precio. Ahora solo adopta si es el mismo producto:
 *
 * - el código de barras coincide, cuando los dos lo tienen; o
 * - el `nameKey` coincide, cuando alguno no tiene código de barras.
 *
 * Si no coincide, el alta queda bloqueada visible: "Ya existe otro producto con
 * ese SKU: <nombre>". El catálogo (`ProductCatalogService`) y las entradas
 * (`StockEntryService`) usan esta misma regla.
 */

/** Lo que la regla necesita de un producto, local o remoto. */
export interface MatchableProduct {
  name: string;
  concentration?: string | null;
  barcode?: string | null;
}

/** Marca del motivo cuando la caja deja bloqueada un alta por duplicado. */
export const PRODUCT_DUPLICATE = 'PRODUCT_DUPLICATE';

/**
 * Nombre comparable (SPEC 60): nombre + concentración, sin acentos, en
 * minúsculas, con espacios colapsados y sin el espacio entre una cifra y su
 * unidad, para que "Paracetamol 500 mg" y "paracetamol  500MG" sean el mismo.
 */
export function productNameKey(name: string | null | undefined, concentration?: string | null): string {
  return `${name ?? ''} ${concentration ?? ''}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\d) (?=[a-zµ%])/g, '$1');
}

function cleanBarcode(barcode: string | null | undefined): string {
  return String(barcode ?? '').trim();
}

/** ¿El remoto es el mismo producto que el local? Ver la regla arriba. */
export function isSameProduct(local: MatchableProduct, remote: MatchableProduct): boolean {
  const localBarcode = cleanBarcode(local.barcode);
  const remoteBarcode = cleanBarcode(remote.barcode);
  if (localBarcode && remoteBarcode) {
    return localBarcode === remoteBarcode;
  }
  const localKey = productNameKey(local.name, local.concentration);
  return localKey !== '' && localKey === productNameKey(remote.name, remote.concentration);
}

/** Texto del conflicto visible cuando el remoto es otro producto. */
export function duplicateProductMessage(existingName: string | null | undefined, by: 'sku' | 'name' = 'sku'): string {
  const name = String(existingName ?? '').trim() || 'sin nombre';
  return by === 'name'
    ? `Ya existe otro producto con ese nombre: ${name}`
    : `Ya existe otro producto con ese SKU: ${name}`;
}
