import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../core/notifications/notification.service';
import { CashSession, CashSessionCut } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { TicketPrintService } from '../ticket/ticket-print.service';
import { CashSessionDialog } from './cash-session-dialog';

const session = {
  id: 's1',
  openedBy: 'u1',
  openingAmount: 500,
  expectedCashAmount: null,
  countedCashAmount: null,
  cashDifference: null,
  summary: null,
  openedAt: new Date('2026-08-08T14:00:00'),
  closedAt: null,
} as CashSession;

function cut(overrides: Partial<CashSessionCut> = {}): CashSessionCut {
  return {
    session,
    summary: {
      salesCount: 3,
      voidedCount: 0,
      byMethod: {
        cash: { count: 2, total: 700 },
        card: { count: 1, total: 300 },
        transfer: { count: 0, total: 0 },
        mixed: { count: 0, total: 0 },
      },
      movements: {
        deposits: { count: 0, total: 0 },
        withdrawals: { count: 0, total: 0 },
        expenses: { count: 0, total: 0 },
      },
      grandTotal: 1000,
      cashInDrawer: 1200,
    },
    expectedCashAmount: 1200,
    ...overrides,
  };
}

describe('CashSessionDialog', () => {
  let fixture: ComponentFixture<CashSessionDialog>;
  let component: CashSessionDialog;
  let open: (amount: number) => Observable<CashSession>;
  let close: (id: string, counted: number) => Observable<CashSessionCut>;
  let getSummary: () => Observable<CashSessionCut>;
  let printCashCut: ReturnType<typeof vi.fn>;
  let notifyError: ReturnType<typeof vi.fn>;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  async function build(currentSession: CashSession | null): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
        {
          provide: CashSessionService,
          // Envueltos en cierres: cada prueba puede reemplazar el doble antes de
          // llamar al componente sin volver a construir el TestBed.
          useValue: {
            open: (amount: number) => open(amount),
            close: (id: string, counted: number) => close(id, counted),
            getSummary: () => getSummary(),
          },
        },
        { provide: TicketPrintService, useValue: { printCashCut } },
      ],
    });

    fixture = TestBed.createComponent(CashSessionDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('session', currentSession);
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
  }

  beforeEach(() => {
    notifyError = vi.fn();
    printCashCut = vi.fn();
    open = vi.fn(() => of(session));
    close = vi.fn(() => of(cut({ session: { ...session, countedCashAmount: 1200, cashDifference: 0 } })));
    getSummary = () => of(cut());
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => confirmSpy.mockRestore());

  describe('apertura', () => {
    beforeEach(() => build(null));

    it('sin turno el diálogo abre en modo apertura', () => {
      expect(component.mode()).toBe('open');
      expect(component.openingAmount()).toBe(0);
    });

    it('abre el turno con el fondo capturado', () => {
      component.openingAmount.set(500);
      component.confirmOpen();

      expect(open).toHaveBeenCalledWith(500);
      expect(component.submitting()).toBe(false);
    });

    it('un fallo al abrir se avisa y deja reintentar', () => {
      open = vi.fn(() => throwError(() => new Error('500')));
      component.confirmOpen();

      expect(notifyError).toHaveBeenCalled();
      expect(component.submitting()).toBe(false);
    });
  });

  describe('cierre', () => {
    beforeEach(() => build(session));

    it('precarga el efectivo esperado pero exige que el cajero lo confirme', () => {
      expect(component.mode()).toBe('close');
      expect(component.expectedCash()).toBe(1200);
      expect(component.countedCashAmount()).toBe(1200);
      expect(component.countedTouched()).toBe(false);

      component.requestClose();
      expect(close).not.toHaveBeenCalled();
    });

    it('con el conteo confirmado y sin diferencia cierra sin preguntar', () => {
      component.setCountedCash(1200);
      component.requestClose();

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledWith('s1', 1200);
      expect(component.mode()).toBe('result');
    });

    it('con faltante pide confirmación explícita', () => {
      component.setCountedCash(1100);
      expect(component.difference()).toBe(-100);

      component.requestClose();

      expect(confirmSpy).toHaveBeenCalled();
      expect(String(confirmSpy.mock.calls[0][0])).toContain('faltante');
      expect(close).toHaveBeenCalled();
    });

    it('si el cajero cancela la confirmación, el turno no se cierra', () => {
      confirmSpy.mockReturnValue(false);
      component.setCountedCash(1300);

      component.requestClose();

      expect(close).not.toHaveBeenCalled();
    });

    it('un fallo al cerrar avisa y no deja el turno como cerrado', () => {
      close = vi.fn(() => throwError(() => new Error('500')));
      component.setCountedCash(1200);

      component.requestClose();

      expect(notifyError).toHaveBeenCalled();
      expect(component.mode()).toBe('close');
    });

    it('un fallo al cargar el resumen avisa en vez de mostrar un esperado en ceros', async () => {
      getSummary = () => throwError(() => new Error('500'));
      await build(session);

      expect(notifyError).toHaveBeenCalled();
      expect(component.summaryLoading()).toBe(false);
    });
  });

  describe('resultado del corte', () => {
    beforeEach(async () => {
      await build(session);
      component.setCountedCash(1200);
      component.requestClose();
    });

    it('imprime el corte con lo contado y lo esperado', () => {
      component.printCut();

      expect(printCashCut).toHaveBeenCalledWith(
        expect.objectContaining({ expectedCashAmount: 1200, countedCashAmount: 1200, cashDifference: 0 }),
      );
    });

    it('terminar cierra el diálogo y limpia el resultado', () => {
      const closed = vi.fn();
      component.closed.subscribe(closed);

      component.finish();

      expect(component.closeResult()).toBeNull();
      expect(closed).toHaveBeenCalled();
    });

    it('cancelar en modo resultado equivale a terminar', () => {
      const closed = vi.fn();
      component.closed.subscribe(closed);

      component.cancel();

      expect(component.closeResult()).toBeNull();
      expect(closed).toHaveBeenCalled();
    });
  });
});
