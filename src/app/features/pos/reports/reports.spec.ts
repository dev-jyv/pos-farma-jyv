import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashSession, Sale } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { SaleService } from '../services/sale.service';
import { PosReports } from './reports';

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

describe('PosReports', () => {
  let fixture: ComponentFixture<PosReports>;
  let component: PosReports;
  let sales: Sale[];
  let listAll: () => Observable<Sale[]>;
  let fetchCurrent: () => Observable<CashSession | null>;
  let current: ReturnType<typeof signal<CashSession | null>>;
  let notifyError: ReturnType<typeof vi.fn>;
  let listAllSpy: ReturnType<typeof vi.fn>;

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    listAllSpy = vi.fn(() => listAll());
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
        { provide: SaleService, useValue: { listAll: listAllSpy, lastListTruncated: signal(false) } },
        { provide: CashSessionService, useValue: { current, fetchCurrent: () => fetchCurrent() } },
        { provide: AuthService, useValue: { user: signal({ email: 'caja@farmajyv.mx' }) } },
      ],
    });

    fixture = TestBed.createComponent(PosReports);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    sales = [sale()];
    listAll = () => of(sales);
    current = signal<CashSession | null>(session);
    fetchCurrent = () => of(session);
    await build();
  });

  describe('carga', () => {
    it('con turno abierto reporta el turno', () => {
      expect(component.scope()).toBe('session');
      expect(component.loaded()).toBe(true);
      expect(listAllSpy).toHaveBeenCalledWith({ cashSessionId: 's1', includeVoided: true });
    });

    it('sin turno cae al día', async () => {
      current = signal<CashSession | null>(null);
      fetchCurrent = () => of(null);
      await build();

      expect(component.scope()).toBe('day');
      expect(listAllSpy.mock.calls[0][0]).toHaveProperty('from');
    });

    it('si el turno no se puede determinar avisa en vez de mostrar ceros imprimibles', async () => {
      fetchCurrent = () => throwError(() => new Error('sin red'));
      await build();

      expect(component.sessionError()).toBe(true);
      expect(component.loaded()).toBe(false);
      expect(component.sales()).toEqual([]);
      expect(notifyError).toHaveBeenCalled();
    });

    it('si el listado falla, el reporte anterior deja de darse por válido', async () => {
      listAll = () => throwError(() => new Error('500'));
      await build();

      expect(component.loaded()).toBe(false);
      expect(component.sales()).toEqual([]);
      expect(notifyError).toHaveBeenCalledWith('No se pudo cargar el reporte.');
    });
  });

  describe('totales', () => {
    it('las ventas anuladas no suman al neto pero sí se cuentan', async () => {
      sales = [sale(), sale({ id: 'v2', voidedAt: new Date() })];
      await build();

      expect(component.validSales()).toHaveLength(1);
      expect(component.voidedCount()).toBe(1);
      expect(component.netTotal()).toBe(100);
    });

    it('el ticket promedio es el neto entre ventas válidas', async () => {
      sales = [sale(), sale({ id: 'v2', total: 300 })];
      await build();

      expect(component.ticketAverage()).toBe(200);
    });

    it('sin ventas el promedio es cero y no NaN', async () => {
      sales = [];
      await build();

      expect(component.ticketAverage()).toBe(0);
      expect(component.netTotal()).toBe(0);
    });

    it('el efectivo cobrado excluye lo que pagó la tarjeta en una venta mixta', async () => {
      sales = [
        sale({ paymentMethod: 'mixed', total: 200, cashAmount: 80, cardAmount: 120, amountReceived: 100, change: 20 }),
        sale({ id: 'v2', paymentMethod: 'card', total: 300, cashAmount: null }),
      ];
      await build();

      expect(component.cashCollected()).toBe(80);
    });

    it('en ventas viejas sin `cashAmount` reconstruye el efectivo como recibido − cambio', async () => {
      sales = [sale({ cashAmount: null, amountReceived: 150, change: 50 })];
      await build();

      expect(component.cashCollected()).toBe(100);
    });
  });

  describe('desgloses', () => {
    it('agrupa por método de pago y ordena por importe', async () => {
      sales = [
        sale({ paymentMethod: 'cash', total: 100 }),
        sale({ id: 'v2', paymentMethod: 'card', total: 500 }),
        sale({ id: 'v3', paymentMethod: 'card', total: 100 }),
      ];
      await build();

      expect(component.byMethod().map((row) => [row.method, row.count, row.total])).toEqual([
        ['card', 2, 600],
        ['cash', 1, 100],
      ]);
    });

    it('en alcance turno las horas se ordenan desde la apertura, no desde el reloj', async () => {
      current = signal<CashSession | null>({ ...session, openedAt: new Date('2026-08-08T22:00:00') });
      fetchCurrent = () => of(current());
      sales = [
        sale({ id: 'v1', createdAt: new Date('2026-08-09T01:00:00') }),
        sale({ id: 'v2', createdAt: new Date('2026-08-08T22:30:00') }),
      ];
      await build();

      expect(component.byHour().map((row) => row.hour)).toEqual([22, 1]);
    });

    it('una hora con ventas nunca dibuja una barra de 0 %', async () => {
      sales = [
        sale({ id: 'v1', total: 1000, createdAt: new Date('2026-08-08T15:00:00') }),
        sale({ id: 'v2', total: 1, createdAt: new Date('2026-08-08T16:00:00') }),
      ];
      await build();

      expect(component.byHour().every((row) => row.pct >= 2)).toBe(true);
    });

    it('el top de productos suma cantidades e importes netos de la partida', async () => {
      sales = [
        sale({
          items: [
            { productId: 'p1', productName: 'Paracetamol', unitPrice: 50, discountAmount: 10, quantity: 2, subtotal: 100 },
            { productId: 'p2', productName: 'Ibuprofeno', unitPrice: 30, discountAmount: 0, quantity: 5, subtotal: 150 },
          ],
        }),
      ];
      await build();

      expect(component.topByQuantity()[0].productId).toBe('p2');
      expect(component.topByAmount()[0].productId).toBe('p2');
      expect(component.topByAmount()[1].total).toBe(90);
    });
  });

  it('cambiar de alcance recarga con los parámetros del alcance nuevo', () => {
    component.onScopeChange('day');

    expect(component.scope()).toBe('day');
    expect(listAllSpy.mock.calls.at(-1)?.[0]).toHaveProperty('from');
  });
});
