import { AbstractControl, NonNullableFormBuilder, ValidationErrors, ValidatorFn } from '@angular/forms';

import { InvoiceRagItem, Product } from '../../../../shared/models';
import { roundMoney } from '../../../../shared/utils/money';
import { CreateStockEntryPayload } from '../../services/stock-entry.service';
import { BARCODE_PATTERN } from '../invoice-rag-review/invoice-rag-form';

/** Unidad en que viene la partida de la factura (SPEC 59). El inventario siempre es en piezas. */
export type StockRowUnit = 'piece' | 'box';

export interface StockRowValue {
  include: boolean;
  description: string;
  barcode: string;
  product: Product | null;
  /** Unidad de `quantity` y `costPrice` tal como vienen en la factura. */
  unit: StockRowUnit;
  quantity: number | null;
  /** Costo sin IVA de la unidad elegida: por caja si `unit` es `box`. */
  costPrice: number | null;
  lotNumber: string;
  expiryDate: string;
}

export type StockRowError = 'product' | 'quantity' | 'lotNumber' | 'expiryDate';

const toPieces = (quantity: number | null | undefined): number | null =>
  quantity && quantity >= 1 ? Math.floor(quantity) : null;

/** Piezas por caja del producto, si se puede convertir (entero 2..1000, como SPEC 46). */
export function piecesPerBox(product: Product | null | undefined): number | null {
  const value = product?.boxQuantity;
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 1000
    ? value
    : null;
}

/** ¿La partida se convierte de cajas a piezas? Solo si eligió Caja y el producto sabe cuántas trae. */
export function convertsBoxes(row: Pick<StockRowValue, 'unit' | 'product'>): boolean {
  return row.unit === 'box' && piecesPerBox(row.product) !== null;
}

/** Piezas que entran al inventario por la partida. */
export function rowPieces(row: Pick<StockRowValue, 'unit' | 'product' | 'quantity'>): number {
  const quantity = row.quantity ?? 0;
  return convertsBoxes(row) ? quantity * piecesPerBox(row.product)! : quantity;
}

/** Costo por pieza, sin IVA (2 decimales, como lo valida el backend), o `null`. */
export function rowCostPerPiece(
  row: Pick<StockRowValue, 'unit' | 'product' | 'costPrice'>,
): number | null {
  if (!row.costPrice) {
    return null;
  }
  return roundMoney(convertsBoxes(row) ? row.costPrice / piecesPerBox(row.product)! : row.costPrice);
}

/** Leyenda de la conversión: "3 cajas × 20 = 60 pzas · $12.50 c/pza". `null` si no convierte. */
export function boxConversionLegend(row: StockRowValue): string | null {
  if (!convertsBoxes(row) || !row.quantity) {
    return null;
  }
  const perBox = piecesPerBox(row.product)!;
  const boxes = row.quantity;
  const cost = rowCostPerPiece(row);
  const base = `${boxes} ${boxes === 1 ? 'caja' : 'cajas'} × ${perBox} = ${rowPieces(row)} pzas`;
  return cost === null ? base : `${base} · $${cost.toFixed(2)} c/pza`;
}

export function stockRowErrors(row: StockRowValue, today: string): StockRowError[] {
  if (!row.include) {
    return [];
  }
  const errors: StockRowError[] = [];
  if (!row.product) errors.push('product');
  if (!Number.isInteger(row.quantity) || (row.quantity ?? 0) < 1) errors.push('quantity');
  if (!row.lotNumber.trim()) errors.push('lotNumber');
  if (!row.expiryDate || row.expiryDate < today) errors.push('expiryDate');
  return errors;
}

function stockRowValidator(today: string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const errors = stockRowErrors(control.getRawValue() as StockRowValue, today);
    return errors.length ? { stockRow: errors } : null;
  };
}

/**
 * Partida editable. Si el producto se resolvió por su código de **caja**
 * (`saleUnit: 'box'` de `getByBarcode`, SPEC 46), arranca en Caja: la factura
 * trae cajas y su costo es el de la caja. El cajero puede cambiarlo.
 */
export function buildStockRow(
  fb: NonNullableFormBuilder,
  item: InvoiceRagItem,
  resolved: (Product & { saleUnit?: 'box' }) | null,
  today: string,
) {
  const quantity = toPieces(item.quantity);
  let product: Product | null = null;
  let unit: StockRowUnit = 'piece';
  if (resolved) {
    const { saleUnit, ...rest } = resolved;
    product = rest as Product;
    unit = saleUnit === 'box' && piecesPerBox(resolved) !== null ? 'box' : 'piece';
  }
  return fb.group(
    {
      include: [!!product && quantity !== null],
      description: [item.description],
      barcode: [item.barcode ?? ''],
      product: fb.control<Product | null>(product),
      unit: fb.control<StockRowUnit>(unit),
      quantity: fb.control<number | null>(quantity),
      costPrice: fb.control<number | null>(item.unitPrice),
      lotNumber: [item.lotNumber ?? ''],
      expiryDate: [item.expiryDate ?? ''],
    },
    { validators: stockRowValidator(today) },
  );
}

export type StockRowGroup = ReturnType<typeof buildStockRow>;

/** El código de la factura se guarda en el producto solo si este aún no tiene uno. */
export function savesBarcode(row: Pick<StockRowValue, 'barcode' | 'product'>): boolean {
  return !!row.product && !row.product.barcode && BARCODE_PATTERN.test(row.barcode.trim());
}

/**
 * Entrada de stock de la partida, **siempre en piezas** (SPEC 59): en Caja,
 * `quantity × boxQuantity` piezas a `costPrice / boxQuantity` cada una. Antes,
 * 3 cajas de 20 entraban como 3 piezas con el costo de la caja por pieza.
 */
export function toStockEntry(row: StockRowValue, invoiceId: string): CreateStockEntryPayload {
  const product = row.product!;
  const costPrice = rowCostPerPiece(row);
  return {
    invoiceId,
    productId: product.remoteId ?? product.id,
    lotNumber: row.lotNumber.trim(),
    expiryDate: row.expiryDate,
    quantity: rowPieces(row),
    ...(costPrice ? { costPrice } : {}),
    ...(savesBarcode(row) ? { productUpdate: { barcode: row.barcode.trim() } } : {}),
  };
}
