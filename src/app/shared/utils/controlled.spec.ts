import { describe, expect, it } from 'vitest';

import { ControlledGroup, Product } from '../models';
import { resolveControlledRequirements, validatePrescription } from './controlled';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    name: 'Producto',
    sku: 'SKU1',
    salePrice: 100,
    stock: 10,
    ...overrides,
  };
}

const rx = {
  doctorName: 'Dra. Ruiz',
  doctorLicense: '1234567',
  folio: 'RX-001',
  retained: true,
};

describe('resolveControlledRequirements', () => {
  it('sin controlados no exige nada', () => {
    const requirements = resolveControlledRequirements([product({ controlledGroup: 'VI' })]);

    expect(requirements.requiresPrescription).toBe(false);
    expect(requirements.requiresFolio).toBe(false);
    expect(requirements.requiresRetention).toBe(false);
    expect(requirements.ledgerGroups).toEqual([]);
  });

  it('grupo IV exige receta y libro, pero no folio ni retención', () => {
    const requirements = resolveControlledRequirements([product({ controlledGroup: 'IV' })]);

    expect(requirements.requiresPrescription).toBe(true);
    expect(requirements.requiresFolio).toBe(false);
    expect(requirements.requiresRetention).toBe(false);
    expect(requirements.ledgerGroups).toEqual(['IV']);
  });

  it.each<ControlledGroup>(['I', 'II', 'III'])('grupo %s exige folio y retención', (group) => {
    const requirements = resolveControlledRequirements([product({ controlledGroup: group })]);

    expect(requirements.requiresFolio).toBe(true);
    expect(requirements.requiresRetention).toBe(true);
    expect(requirements.ledgerGroups).toEqual([group]);
  });

  it('el ticket mixto toma el requisito más estricto', () => {
    const requirements = resolveControlledRequirements([
      product({ controlledGroup: 'VI' }),
      product({ id: 'p2', controlledGroup: 'IV' }),
      product({ id: 'p3', controlledGroup: 'II' }),
    ]);

    expect(requirements.requiresFolio).toBe(true);
    expect(requirements.requiresRetention).toBe(true);
    expect(requirements.groups).toEqual(['VI', 'IV', 'II']);
    expect(requirements.ledgerGroups).toEqual(['IV', 'II']);
  });

  it('sin grupo capturado respeta el flag heredado del catálogo viejo', () => {
    const requirements = resolveControlledRequirements([product({ requiresPrescription: true })]);

    expect(requirements.requiresPrescription).toBe(true);
    expect(requirements.requiresFolio).toBe(false);
    expect(requirements.groups).toEqual([]);
  });
});

describe('validatePrescription', () => {
  it('no pide nada cuando no hay controlados', () => {
    const requirements = resolveControlledRequirements([product({ controlledGroup: 'V' })]);

    expect(
      validatePrescription(requirements, {
        doctorName: '',
        doctorLicense: '',
        folio: '',
        retained: false,
      }),
    ).toBeNull();
  });

  it('exige médico cuando el grupo pide receta', () => {
    const requirements = resolveControlledRequirements([product({ controlledGroup: 'IV' })]);

    expect(
      validatePrescription(requirements, { ...rx, doctorName: '  ' }),
    ).toMatch(/receta médica/);
  });

  it('valida la cédula profesional a 7 u 8 dígitos', () => {
    const requirements = resolveControlledRequirements([product({ controlledGroup: 'IV' })]);

    expect(validatePrescription(requirements, { ...rx, doctorLicense: '123456' })).toMatch(/cédula/);
    expect(validatePrescription(requirements, { ...rx, doctorLicense: '12345678' })).toBeNull();
    expect(validatePrescription(requirements, { ...rx, doctorLicense: '12A45678' })).toMatch(/cédula/);
  });

  it('exige folio y retención en grupos I a III', () => {
    const requirements = resolveControlledRequirements([product({ controlledGroup: 'I' })]);

    expect(validatePrescription(requirements, { ...rx, folio: '' })).toMatch(/folio/);
    expect(validatePrescription(requirements, { ...rx, retained: false })).toMatch(/retener/);
    expect(validatePrescription(requirements, rx)).toBeNull();
  });

  it('grupo IV no exige retención', () => {
    const requirements = resolveControlledRequirements([product({ controlledGroup: 'IV' })]);

    expect(validatePrescription(requirements, { ...rx, folio: '', retained: false })).toBeNull();
  });
});
