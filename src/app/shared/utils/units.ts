/**
 * Unidades de venta del catálogo. Es una lista cerrada a propósito: el mismo
 * empaque escrito de tres formas ("caja", "Caja", "cja") parte el inventario en
 * tres productos distintos a la hora de contar y reordenar.
 */
export const UNIT_OPTIONS = [
  'pieza',
  'caja',
  'frasco',
  'ampolleta',
  'sobre',
  'tubo',
  'kit',
] as const;

export type Unit = (typeof UNIT_OPTIONS)[number];

export const DEFAULT_UNIT: Unit = 'pieza';

export interface UnitOption {
  label: string;
  value: string;
}

/**
 * Opciones para el selector. Si el producto ya tiene una unidad fuera del
 * catálogo (capturada antes de cerrar la lista, o desde el admin web), se agrega
 * marcada como actual: un selector que no puede representar el valor guardado lo
 * borraría en silencio al primer guardado.
 */
export function buildUnitOptions(current?: string | null): UnitOption[] {
  const options: UnitOption[] = UNIT_OPTIONS.map((unit) => ({ label: unit, value: unit }));
  const normalized = current?.trim();
  if (normalized && !UNIT_OPTIONS.includes(normalized as Unit)) {
    options.push({ label: `${normalized} (actual)`, value: normalized });
  }
  return options;
}
