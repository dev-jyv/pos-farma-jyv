import { AbstractControl, NonNullableFormBuilder, ValidationErrors, ValidatorFn } from '@angular/forms';

import { InvoiceRagItem, Product } from '../../../../shared/models';
import { roundMoney } from '../../../../shared/utils/money';
import { CreateStockEntryPayload } from '../../services/stock-entry.service';
import { BARCODE_PATTERN } from '../invoice-rag-review/invoice-rag-form';

export interface StockRowValue {
  include: boolean;
  description: string;
  barcode: string;
  product: Product | null;
  quantity: number | null;
  costPrice: number | null;
  lotNumber: string;
  expiryDate: string;
}

export type StockRowError = 'product' | 'quantity' | 'lotNumber' | 'expiryDate';

const toPieces = (quantity: number | null | undefined): number | null =>
  quantity && quantity >= 1 ? Math.floor(quantity) : null;

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

export function buildStockRow(
  fb: NonNullableFormBuilder,
  item: InvoiceRagItem,
  product: Product | null,
  today: string,
) {
  const quantity = toPieces(item.quantity);
  return fb.group(
    {
      include: [!!product && quantity !== null],
      description: [item.description],
      barcode: [item.barcode ?? ''],
      product: fb.control<Product | null>(product),
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

export function toStockEntry(row: StockRowValue, invoiceId: string): CreateStockEntryPayload {
  const product = row.product!;
  return {
    invoiceId,
    productId: product.remoteId ?? product.id,
    lotNumber: row.lotNumber.trim(),
    expiryDate: row.expiryDate,
    quantity: row.quantity!,
    ...(row.costPrice ? { costPrice: roundMoney(row.costPrice) } : {}),
    ...(savesBarcode(row) ? { productUpdate: { barcode: row.barcode.trim() } } : {}),
  };
}
