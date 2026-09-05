import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashSession, Sale } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { SaleService } from '../services/sale.service';
import { TicketPrintService } from '../ticket/ticket-print.service';
import { SaleMovement } from '../../../core/electron/window.d';
import { SaleHistory } from './sale-history';

function sale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: 'v1',
    folio: 'V-000001',
    items: [],
    subtotal: 100,
    discountTotal: 0,
    total: 100,
    taxSummary: null,
    paymentMethod: 'cash',
    amountReceived: 100,
    change: 0,
    cashAmount: 100,
    cardAmount: null,
    cardPaymentReference: null,
    cashierId: 'u1',
    cashSessionId: 's1',
    customerId: null,
    customerName: null,
    prescription: null,
    prescriptionRetained: false,
    controlledGroups: [],
    billing: null,
    invoiceStatus: null,
    voidedAt: null,
    createdAt: new Date('2026-08-08T15:00:00'),
    ...overrides,
  } as Sale;
}

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

describe('SaleHistory', () => {
  let fixture: ComponentFixture<SaleHistory>;
  let component: SaleHistory;
  let list: (params: unknown) => Observable<Sale[]>;
  /** Parámetros con los que se pidió el listado, en orden. */
  let listCalls: Array<Record<string, unknown>>;
  let voidSale: (id: string) => Observable<Sale>;
  let current: ReturnType<typeof signal<CashSession | null>>;
  let isAdmin: ReturnType<typeof signal<boolean>>;
  let notifyError: ReturnType<typeof vi.fn>;
  let notifySuccess: ReturnType<typeof vi.fn>;
  let printSale: ReturnType<typeof vi.fn>;
  let movements: SaleMovement[];
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: notifySuccess } },
        {
          provide: SaleService,
          useValue: {
            list: (params: Record<string, unknown>) => {
              listCalls.push(params);
              return list(params);
            },
            void: (id: string) => voidSale(id),
            movements: () => of(movements),
            pendingSales: signal([]),
          },
        },
        { provide: CashSessionService, useValue: { current, refreshCurrent: () => of(current()) } },
        { provide: AuthService, useValue: { isAdmin, user: signal({ uid: 'u1', email: 'caja@farmajyv.mx' }) } },
        { provide: TicketPrintService, useValue: { printSale } },
      ],
    });

    fixture = TestBed.createComponent(SaleHistory);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    notifySuccess = vi.fn();
    printSale = vi.fn();
    movements = [];
    isAdmin = signal(true);
    current = signal<CashSession | null>(session);
    list = () => of([sale()]);
    voidSale = () => of(sale({ voidedAt: new Date('2026-08-08T16:00:00') }));
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    listCalls = [];
    await build();
  });

  afterEach(() => confirmSpy.mockRestore());

  describe('alcance', () => {
    it('con turno abierto lista el turno y lo dice', () => {
      expect(component.scope()).toBe('shift');
      expect(component.shiftOpenedAt()).toEqual(session.openedAt);
      expect(listCalls[0]).toMatchObject({ cashSessionId: 's1', includeVoided: true });
    });

    it('sin turno lista desde medianoche', async () => {
      current = signal<CashSession | null>(null);
      listCalls = [];
      await build();

      expect(component.scope()).toBe('day');
      expect(listCalls[0]).toHaveProperty('from');
    });
  });

  describe('carga', () => {
    it('deja la lista lista para usarse', () => {
      expect(component.sales()).toHaveLength(1);
      expect(component.loading()).toBe(false);
      expect(component.loadError()).toBeNull();
    });

    it('un fallo conserva la lista previa y marca el error de forma persistente', async () => {
      list = () => throwError(() => new Error('API caída'));
      component.reload();

      expect(component.loadError()).toBe('API caída');
      expect(component.sales()).toHaveLength(1);
      expect(component.loading()).toBe(false);
    });
  });

  describe('anulación', () => {
    it('el administrador anula y la fila se actualiza en el listado', () => {
      component.voidSale(component.sales()[0]);

      expect(confirmSpy).toHaveBeenCalled();
      expect(component.sales()[0].voidedAt).toBeInstanceOf(Date);
      expect(notifySuccess).toHaveBeenCalled();
    });

    it('sin confirmar no anula', () => {
      confirmSpy.mockReturnValue(false);
      const voidSpy = vi.fn(() => of(sale()));
      voidSale = voidSpy;

      component.voidSale(component.sales()[0]);

      expect(voidSpy).not.toHaveBeenCalled();
    });

    it('un rol no admin no puede anular', () => {
      isAdmin.set(false);
      const voidSpy = vi.fn(() => of(sale()));
      voidSale = voidSpy;

      component.voidSale(component.sales()[0]);

      expect(voidSpy).not.toHaveBeenCalled();
    });

    it('una venta ya anulada no se vuelve a anular', () => {
      const voidSpy = vi.fn(() => of(sale()));
      voidSale = voidSpy;

      component.voidSale(sale({ voidedAt: new Date() }));

      expect(voidSpy).not.toHaveBeenCalled();
    });

    it('un rechazo del servidor se muestra tal cual y libera el botón', () => {
      voidSale = () =>
        throwError(() => ({ message: 'Solo un administrador puede anular' }) as unknown as Error);

      component.voidSale(component.sales()[0]);

      expect(component.voiding()).toBeNull();
      expect(notifyError).toHaveBeenCalled();
    });
  });

  describe('detalle e impresión', () => {
    it('el cajero de la sesión se muestra por correo y no por UID', () => {
      expect(component.cashierLabel(sale())).toBe('caja@farmajyv.mx');
      expect(component.cashierLabel(sale({ cashierId: 'otro' }))).toBe('otro');
    });

    it('imprime el ticket con la etiqueta del cajero', () => {
      component.print(component.sales()[0]);
      expect(printSale).toHaveBeenCalledWith(component.sales()[0], 'caja@farmajyv.mx');
    });

    it('abrir el detalle guarda la venta seleccionada', () => {
      component.openDetail(component.sales()[0]);

      expect(component.detailVisible()).toBe(true);
      expect(component.detailSale()?.folio).toBe('V-000001');
    });
  });

  describe('bitácora', () => {
    const movement = (overrides: Partial<SaleMovement> = {}): SaleMovement => ({
      id: 'm1',
      saleId: 'v1',
      type: 'sale',
      userId: 'u1',
      userLabel: 'caja@farmajyv.mx',
      reason: null,
      occurredAt: '2026-09-03T18:00:00.000Z',
      ...overrides,
    });

    it('abrir el detalle carga los movimientos de la venta', async () => {
      movements = [movement(), movement({ id: 'm2', type: 'void', userId: 'u9', userLabel: 'ana@farmajyv.mx' })];

      component.openDetail(component.sales()[0]);
      await Promise.resolve();

      expect(component.detailMovements()).toHaveLength(2);
      expect(component.detailMovements()[1].type).toBe('void');
    });

    it('el autor se muestra por correo, no por uid', () => {
      expect(component.movementAuthor(movement())).toBe('caja@farmajyv.mx');
    });

    it('sin correo guardado cae al del cajero de la sesión y, si no, al uid', () => {
      // Venta vieja, anterior a que la bitácora guardara el correo.
      expect(component.movementAuthor(movement({ userLabel: null }))).toBe('caja@farmajyv.mx');
      expect(component.movementAuthor(movement({ userLabel: null, userId: 'otro' }))).toBe('otro');
    });

    it('la fila del listado dice quién anuló', () => {
      expect(component.voidedByLabel(sale({ voidedBy: 'u1' }))).toBe('caja@farmajyv.mx');
      expect(component.voidedByLabel(sale({ voidedBy: 'u9' }))).toBe('u9');
    });
  });

  it('methodLabelKey devuelve la llave i18n del método', () => {
    expect(component.methodLabelKey('mixed')).toBe('payment.mixed');
  });
});
