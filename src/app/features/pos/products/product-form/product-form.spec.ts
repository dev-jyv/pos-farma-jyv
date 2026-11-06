import { describe, expect, it } from 'vitest';

import { Product, ProductFieldsPayload } from '../../../../shared/models';
import { productChanges } from './product-form';

const EXISTENTE: Product = {
  id: 'local-1',
  remoteId: 'remote-1',
  name: 'Clonazepam 2 mg',
  sku: 'CLZ-2',
  salePrice: 120,
  stock: 10,
  categoryId: 'cat-1',
  unit: 'caja',
  minStock: 2,
  hasIva: false,
  hasIvaZero: true,
  hasIeps: false,
  requiresPrescription: true,
  controlledGroup: 'IV',
  isActive: true,
} as Product;

function campos(overrides: Partial<ProductFieldsPayload> = {}): ProductFieldsPayload {
  return {
    name: 'Clonazepam 2 mg',
    sku: 'CLZ-2',
    categoryId: 'cat-1',
    unit: 'caja',
    salePrice: 120,
    minStock: 2,
    hasIva: false,
    hasIvaZero: true,
    hasIeps: false,
    requiresPrescription: true,
    isActive: true,
    controlledGroup: 'IV',
    ...overrides,
  };
}

describe('productChanges (formulario de producto)', () => {
  it('quitar el grupo controlado deja controlledGroup: null, no undefined (SPEC 64)', () => {
    const { controlledGroup: _quitado, ...sinGrupo } = campos();

    const changes = productChanges(sinGrupo as ProductFieldsPayload, EXISTENTE);

    expect(changes).toEqual({ controlledGroup: null });
    expect('controlledGroup' in changes).toBe(true);
  });

  it('cambiar de grupo manda el grupo nuevo', () => {
    expect(productChanges(campos({ controlledGroup: 'II' }), EXISTENTE)).toEqual({ controlledGroup: 'II' });
  });

  it('sin cambios no manda nada', () => {
    expect(productChanges(campos(), EXISTENTE)).toEqual({});
  });
});
