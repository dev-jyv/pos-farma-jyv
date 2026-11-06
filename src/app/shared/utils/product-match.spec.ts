import { describe, expect, it } from 'vitest';

import { duplicateProductMessage, isSameProduct, productNameKey } from './product-match';

describe('product-match (SPEC 60)', () => {
  it('"Paracetamol 500 mg" y "paracetamol  500MG" chocan', () => {
    expect(productNameKey('Paracetamol 500 mg')).toBe(productNameKey('paracetamol  500MG'));
    expect(productNameKey('Paracetamol', '500 mg')).toBe(productNameKey('paracetamol  500MG'));
  });

  it('sin acentos, minúsculas y espacios colapsados', () => {
    expect(productNameKey('  Ácido   Fólico ', '5 mg')).toBe('acido folico 5mg');
  });

  it('mismo nombre y distinta concentración no chocan', () => {
    expect(productNameKey('Paracetamol', '500 mg')).not.toBe(productNameKey('Paracetamol', '750 mg'));
  });

  it('con código de barras en los dos, manda el código', () => {
    expect(isSameProduct({ name: 'A', barcode: '7501' }, { name: 'Otro', barcode: ' 7501 ' })).toBe(true);
    // Mismo nombre pero otro código: es otro producto.
    expect(isSameProduct({ name: 'Paracetamol', barcode: '7501' }, { name: 'Paracetamol', barcode: '7502' })).toBe(false);
  });

  it('si alguno no tiene código, compara el nameKey', () => {
    expect(
      isSameProduct({ name: 'Paracetamol', concentration: '500 mg' }, { name: 'PARACETAMOL 500MG', barcode: '7501' }),
    ).toBe(true);
    expect(isSameProduct({ name: 'Paracetamol', concentration: '500 mg' }, { name: 'Ibuprofeno', barcode: null })).toBe(
      false,
    );
    // Un nombre vacío nunca adopta.
    expect(isSameProduct({ name: '' }, { name: '' })).toBe(false);
  });

  it('mensaje visible del conflicto', () => {
    expect(duplicateProductMessage('Paracetamol 500 mg')).toBe('Ya existe otro producto con ese SKU: Paracetamol 500 mg');
    expect(duplicateProductMessage('Paracetamol', 'name')).toBe('Ya existe otro producto con ese nombre: Paracetamol');
  });
});
