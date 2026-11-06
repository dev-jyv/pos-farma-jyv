import { TestBed } from '@angular/core/testing';
import { NonNullableFormBuilder } from '@angular/forms';
import { beforeEach, describe, expect, it } from 'vitest';

import { InvoiceRagItem, Product } from '../../../../shared/models';
import {
  boxConversionLegend,
  buildStockRow,
  rowPieces,
  savesBarcode,
  stockRowErrors,
  toStockEntry,
} from './invoice-rag-stock-form';

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
      unit: 'piece',
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

  describe('caja → pieza (SPEC 59)', () => {
    const CAJA = {
      ...PRODUCT,
      boxQuantity: 20,
      boxPrice: 1500,
      boxBarcode: '17501234567897',
    } as Product;
    const PARTIDA: InvoiceRagItem = { ...ITEM, barcode: '17501234567897', quantity: 3, unitPrice: 250 };

    it('resuelta por boxBarcode: 3 cajas de 20 a $250 entran como 60 piezas a $12.50', () => {
      const row = buildStockRow(fb, PARTIDA, { ...CAJA, saleUnit: 'box' } as Product, TODAY);
      const value = row.getRawValue();

      expect(value.unit).toBe('box');
      // El producto del formulario no arrastra la marca de la búsqueda.
      expect(value.product).not.toHaveProperty('saleUnit');
      expect(rowPieces(value)).toBe(60);
      expect(boxConversionLegend(value)).toBe('3 cajas × 20 = 60 pzas · $12.50 c/pza');
      expect(toStockEntry(value, 'inv-1')).toMatchObject({ quantity: 60, costPrice: 12.5 });
    });

    it('el cajero cambia de Caja a Pieza a mano: no se convierte', () => {
      const row = buildStockRow(fb, PARTIDA, { ...CAJA, saleUnit: 'box' } as Product, TODAY);
      row.controls.unit.setValue('piece');
      const value = row.getRawValue();

      expect(boxConversionLegend(value)).toBeNull();
      expect(toStockEntry(value, 'inv-1')).toMatchObject({ quantity: 3, costPrice: 250 });
    });

    it('elegir Caja a mano en un producto que se vende por caja también convierte', () => {
      const row = buildStockRow(fb, PARTIDA, CAJA, TODAY);
      expect(row.controls.unit.value).toBe('piece');
      row.controls.unit.setValue('box');

      expect(toStockEntry(row.getRawValue(), 'inv-1')).toMatchObject({ quantity: 60, costPrice: 12.5 });
    });

    it('producto sin boxQuantity resuelto por código normal: entra en piezas, como hoy', () => {
      const row = buildStockRow(fb, PARTIDA, PRODUCT, TODAY);
      expect(row.controls.unit.value).toBe('piece');
      // Aunque la marque Caja, sin piezas por caja no hay con qué convertir.
      row.controls.unit.setValue('box');

      expect(boxConversionLegend(row.getRawValue())).toBeNull();
      expect(toStockEntry(row.getRawValue(), 'inv-1')).toMatchObject({ quantity: 3, costPrice: 250 });
    });

    it('el costo por pieza se redondea a centavos (lo que acepta el servidor)', () => {
      const row = buildStockRow(fb, { ...PARTIDA, quantity: 1, unitPrice: 100 }, { ...CAJA, boxQuantity: 3, saleUnit: 'box' } as Product, TODAY);
      expect(toStockEntry(row.getRawValue(), 'inv-1')).toMatchObject({ quantity: 3, costPrice: 33.33 });
      expect(boxConversionLegend(row.getRawValue())).toBe('1 caja × 3 = 3 pzas · $33.33 c/pza');
    });
  });
});
