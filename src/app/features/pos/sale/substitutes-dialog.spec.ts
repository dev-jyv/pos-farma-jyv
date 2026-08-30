import { ComponentFixture, TestBed } from '@angular/core/testing';
import { providePrimeNG } from 'primeng/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Product } from '../../../shared/models';
import { SubstitutesDialog } from './substitutes-dialog';

function product(overrides: Partial<Product> = {}): Product {
  return { id: 'p2', name: 'Ibuprofeno', salePrice: 40, stock: 5, ...overrides } as Product;
}

describe('SubstitutesDialog', () => {
  let fixture: ComponentFixture<SubstitutesDialog>;
  let component: SubstitutesDialog;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [providePrimeNG({})] });

    fixture = TestBed.createComponent(SubstitutesDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('sourceName', 'Paracetamol');
    fixture.componentRef.setInput('ingredient', 'paracetamol');
    await fixture.whenStable();
  });

  it('sin alternativas lo dice en vez de mostrar una lista vacía', async () => {
    fixture.componentRef.setInput('alternatives', []);
    await fixture.whenStable();

    expect(document.body.textContent).toContain('No hay alternativas con stock.');
  });

  it('lista las alternativas con su stock y precio', async () => {
    fixture.componentRef.setInput('alternatives', [product()]);
    await fixture.whenStable();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Ibuprofeno');
    expect(text).toContain('Stock 5');
  });

  it('emite el producto elegido', () => {
    const selected = vi.fn();
    component.selected.subscribe(selected);

    component.selected.emit(product());

    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });
});
