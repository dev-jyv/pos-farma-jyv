import { ExpenseCategory } from '../models';

/**
 * Rótulos de las categorías de gasto, en un solo sitio.
 *
 * Estaban escritos a fuego —y en español— en tres pantallas distintas (el
 * formulario de gasto, la auditoría de gastos y el corte), así que la app en
 * inglés mostraba "Sueldo" y cualquier categoría nueva había que agregarla tres
 * veces. Aquí se guarda la **llave** de i18n y la traducción se hace donde toca:
 * con el pipe en la plantilla, o con `instant()` cuando un `p-select` exige una
 * cadena ya resuelta.
 *
 * El orden es el del negocio (lo más frecuente primero) y es el que ven las
 * dos pantallas: si divergieran, el cajero tendría que buscar la categoría en
 * un sitio distinto según dónde estuviera.
 */
export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'salary',
  'food',
  'rent',
  'contingency',
  'electricity',
  'supplies',
  'supplier',
  'other',
] as const;

const KEYS: Record<ExpenseCategory, string> = {
  salary: 'expenses.categorySalary',
  food: 'expenses.categoryFood',
  rent: 'expenses.categoryRent',
  contingency: 'expenses.categoryContingency',
  electricity: 'expenses.categoryElectricity',
  supplies: 'expenses.categorySupplies',
  supplier: 'expenses.categorySupplier',
  other: 'expenses.categoryOther',
};

/**
 * Llave de i18n del rótulo. Cadena vacía si no hay categoría: un gasto viejo
 * puede no traerla, y pasar `''` al `TranslatePipe` no pinta nada — mejor que
 * pintar la llave cruda o reventar la tabla.
 */
export function expenseCategoryKey(category: ExpenseCategory | null | undefined): string {
  return category ? (KEYS[category] ?? '') : '';
}

/** Categorías que exigen describir en qué se gastó: el motivo corto no basta. */
export const CATEGORIES_REQUIRING_DESCRIPTION: ReadonlySet<ExpenseCategory> = new Set<ExpenseCategory>(
  ['supplies', 'supplier', 'other'],
);

export function expenseCategoryNeedsDescription(
  category: ExpenseCategory | null | undefined,
): boolean {
  return category !== null && category !== undefined && CATEGORIES_REQUIRING_DESCRIPTION.has(category);
}
