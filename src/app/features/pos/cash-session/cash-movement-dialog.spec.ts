import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../core/notifications/notification.service';
import { CashMovement } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { CashMovementDialog } from './cash-movement-dialog';

describe('CashMovementDialog', () => {
  let fixture: ComponentFixture<CashMovementDialog>;
  let component: CashMovementDialog;
  let addMovement: (id: string, input: unknown) => Observable<CashMovement>;
  let notifyError: ReturnType<typeof vi.fn>;
  let notifySuccess: ReturnType<typeof vi.fn>;

  const movement = { id: 'm1' } as CashMovement;

  async function build(sessionId = 's1'): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: notifySuccess } },
        {
          provide: CashSessionService,
          // Cierre: cada prueba puede reemplazar el doble sin reconstruir el TestBed.
          useValue: { addMovement: (id: string, input: unknown) => addMovement(id, input) },
        },
      ],
    });

    fixture = TestBed.createComponent(CashMovementDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    notifySuccess = vi.fn();
    addMovement = vi.fn((): Observable<CashMovement> => of(movement));
    await build();
  });

  it('al abrir arranca en retiro, sin monto ni motivo', () => {
    expect(component.type()).toBe('withdrawal');
    expect(component.amount()).toBe(0);
    expect(component.reason()).toBe('');
  });

  it('registra el movimiento con el motivo recortado', () => {
    const saved = vi.fn();
    component.saved.subscribe(saved);

    component.type.set('expense');
    component.amount.set(150);
    component.reason.set('  Papelería  ');
    component.confirm();

    expect(addMovement).toHaveBeenCalledWith('s1', {
      type: 'expense',
      amount: 150,
      reason: 'Papelería',
    });
    expect(saved).toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalled();
  });

  it('sin monto no registra nada', () => {
    component.reason.set('Retiro parcial');
    component.confirm();

    expect(addMovement).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith('Completa tipo, monto y motivo.');
  });

  it('sin motivo no registra nada: un movimiento sin causa no se puede auditar', () => {
    component.amount.set(100);
    component.confirm();

    expect(addMovement).not.toHaveBeenCalled();
  });

  it('sin turno no registra nada', async () => {
    await build('');
    component.amount.set(100);
    component.reason.set('Retiro');

    component.confirm();

    expect(addMovement).not.toHaveBeenCalled();
  });

  it('un fallo del servidor avisa y deja reintentar', () => {
    addMovement = vi.fn(() => throwError(() => new Error('500')));
    component.amount.set(100);
    component.reason.set('Retiro');

    component.confirm();

    expect(notifyError).toHaveBeenCalledWith('No se pudo registrar el movimiento.');
    expect(component.submitting()).toBe(false);
  });
});
