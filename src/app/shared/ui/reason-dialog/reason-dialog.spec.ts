import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { ReasonDialog } from './reason-dialog';

/** Diálogo del motivo de anulación/descarte (SPEC 62). */
describe('ReasonDialog', () => {
  let fixture: ComponentFixture<ReasonDialog>;
  let component: ReasonDialog;
  let emitted: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ReasonDialog] }).compileComponents();
    fixture = TestBed.createComponent(ReasonDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('quickReasons', [
      'Error de captura',
      'Cliente desistió',
      'Producto equivocado',
      'Otro',
    ]);
    fixture.componentRef.setInput('otherOption', 'Otro');
    emitted = [];
    component.confirmed.subscribe((reason) => emitted.push(reason));
    fixture.detectChanges();
  });

  it('sin motivo no se puede confirmar', () => {
    expect(component.valid()).toBe(false);
    component.confirm();
    expect(emitted).toEqual([]);
  });

  it('una opción rápida basta como motivo', () => {
    component.choose('Cliente desistió');
    expect(component.valid()).toBe(true);
    component.confirm();
    expect(emitted).toEqual(['Cliente desistió']);
  });

  it('la opción y el texto libre se juntan como detalle', () => {
    component.choose('Producto equivocado');
    component.text.set('era la presentación de 500 mg');
    component.confirm();
    expect(emitted).toEqual(['Producto equivocado: era la presentación de 500 mg']);
  });

  it('"Otro" no vale solo: exige escribir al menos 5 caracteres', () => {
    component.choose('Otro');
    expect(component.valid()).toBe(false);
    component.text.set('abc');
    expect(component.valid()).toBe(false);
    component.text.set('Precio mal capturado');
    expect(component.valid()).toBe(true);
    component.confirm();
    expect(emitted).toEqual(['Precio mal capturado']);
  });

  it('mientras la acción viaja no se confirma dos veces', () => {
    component.choose('Error de captura');
    fixture.componentRef.setInput('busy', true);
    component.confirm();
    expect(emitted).toEqual([]);
  });
});
