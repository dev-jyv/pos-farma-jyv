import { TestBed } from '@angular/core/testing';
import { NonNullableFormBuilder } from '@angular/forms';
import { beforeEach, describe, expect, it } from 'vitest';

import { InvoiceRagItem, Product } from '../../../../shared/models';
import { buildStockRow, savesBarcode, stockRowErrors, toStockEntry } from './invoice-rag-stock-form';

const TODAY = '2026-09-26';

const ITEM: InvoiceRagItem = {
  description: 'SERTRALINA TAB C/14 50MG AMSA',
  barcode: '7501234567890',
  lotNumber: 'L-77',
  expiryDate: '2028-01-31',
  quantity: 3,
  unitPrice: 41.456,
  amount: 124.37,
};

const PRODUCT = {
  id: 'local-1',
  remoteId: 'remote-1',
  name: 'Sertralina 50 mg',
  sku: 'SER-50',
  barcode: '7501234567890',
  salePrice: 90,
  stock: 4,
} as Product;

describe('invoice-rag-stock-form', () => {
  let fb: NonNullableFormBuilder;

  beforeEach(() => {
    fb = TestBed.inject(NonNullableFormBuilder);
  });

  it('prellena la partida con lo extraído y la incluye si hay producto y piezas', () => {
    const row = buildStockRow(fb, ITEM, PRODUCT, TODAY);
    expect(row.getRawValue()).toEqual({
      include: true,
      description: ITEM.description,
      barcode: ITEM.barcode,
      product: PRODUCT,
      quantity: 3,
      costPrice: 41.456,
      lotNumber: 'L-77',
      expiryDate: '2028-01-31',
    });
    expect(row.valid).toBe(true);
  });

  it('sin producto ligado o sin piezas enteras la deja fuera', () => {
    expect(buildStockRow(fb, ITEM, null, TODAY).controls.include.value).toBe(false);
    expect(buildStockRow(fb, { ...ITEM, quantity: 0.5 }, PRODUCT, TODAY).controls.include.value).toBe(false);
    expect(buildStockRow(fb, { ...ITEM, quantity: 2.9 }, PRODUCT, TODAY).controls.quantity.value).toBe(2);
  });

  it('una partida incluida exige producto, piezas, lote y caducidad vigente', () => {
    const row = buildStockRow(fb, { ...ITEM, lotNumber: null, expiryDate: '2026-01-01' }, null, TODAY);
    expect(stockRowErrors(row.getRawValue(), TODAY)).toEqual([]);

    row.controls.include.setValue(true);
    expect(stockRowErrors(row.getRawValue(), TODAY)).toEqual(['product', 'lotNumber', 'expiryDate']);
    expect(row.invalid).toBe(true);

    row.patchValue({ product: PRODUCT, lotNumber: 'A1', expiryDate: TODAY, quantity: 1.5 });
    expect(stockRowErrors(row.getRawValue(), TODAY)).toEqual(['quantity']);
  });

  it('arma la entrada con el id remoto y guarda el código solo si el producto no tiene', () => {
    const value = buildStockRow(fb, ITEM, PRODUCT, TODAY).getRawValue();
    expect(toStockEntry(value, 'inv-1')).toEqual({
      invoiceId: 'inv-1',
      productId: 'remote-1',
      lotNumber: 'L-77',
      expiryDate: '2028-01-31',
      quantity: 3,
      costPrice: 41.46,
    });

    const withoutBarcode = { ...value, product: { ...PRODUCT, barcode: undefined, remoteId: null } };
    expect(savesBarcode(withoutBarcode)).toBe(true);
    expect(toStockEntry(withoutBarcode, 'inv-1')).toMatchObject({
      productId: 'local-1',
      productUpdate: { barcode: '7501234567890' },
    });
    expect(savesBarcode({ ...withoutBarcode, barcode: 'SKU-1' })).toBe(false);
  });
});
