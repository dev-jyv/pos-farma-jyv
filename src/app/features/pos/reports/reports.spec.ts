import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashMovement, CashSession, Sale } from '../../../shared/models';
import { CashMovementService } from '../services/cash-movement.service';
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
  let movements: CashMovement[];
  let listScope: () => Observable<CashMovement[]>;
  let scopeCalls: Array<{ cashSessionId?: string; from?: string }>;

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
        { provide: CashSessionService, useValue: { current, refreshCurrent: () => fetchCurrent() } },
        {
          provide: CashMovementService,
          useValue: {
            listForScope: (scope: { cashSessionId?: string; from?: string }) => {
              scopeCalls.push(scope);
              return listScope();
            },
          },
        },
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
    movements = [];
    scopeCalls = [];
    listScope = () => of(movements);
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

    /** Misma regla que el efectivo: en mixta solo la parte de la terminal. */
    it('la tarjeta cobrada excluye lo que pagó el efectivo en una venta mixta', async () => {
      sales = [
        sale({ paymentMethod: 'mixed', total: 200, cashAmount: 80, cardAmount: 120 }),
        sale({ id: 'v2', paymentMethod: 'card', total: 300, cashAmount: null, cardAmount: 300 }),
        sale({ id: 'v3', paymentMethod: 'cash', total: 50 }),
      ];
      await build();

      expect(component.cardCollected()).toBe(420);
    });

    it('una venta con tarjeta sin desglose cuenta por su total', async () => {
      sales = [sale({ paymentMethod: 'card', total: 300, cashAmount: null, cardAmount: null })];
      await build();

      expect(component.cardCollected()).toBe(300);
    });
  });

  describe('movimientos de caja', () => {
    function movement(overrides: Partial<CashMovement> = {}): CashMovement {
      return {
        id: 'm1',
        cashSessionId: 's1',
        type: 'expense',
        amount: 100,
        reason: 'Comida',
        createdBy: 'u1',
        createdAt: new Date('2026-08-08T16:00:00'),
        ...overrides,
      } as CashMovement;
    }

    it('suma los gastos del alcance y los cuenta', async () => {
      movements = [movement(), movement({ id: 'm2', amount: 50 })];
      await build();

      expect(component.expenseTotal()).toBe(150);
      expect(component.expenseCount()).toBe(2);
    });

    it('separa entradas y retiros de los gastos', async () => {
      movements = [
        movement({ id: 'm1', type: 'deposit', amount: 200 }),
        movement({ id: 'm2', type: 'withdrawal', amount: 80 }),
        movement({ id: 'm3', type: 'expense', amount: 30 }),
      ];
      await build();

      expect(component.depositTotal()).toBe(200);
      expect(component.withdrawalTotal()).toBe(80);
      expect(component.expenseTotal()).toBe(30);
    });

    /**
     * Es la cuenta que el admin hacía a mano: sin ella, "Efectivo cobrado" se
     * lee como lo que debe haber en el cajón, y con gastos del turno no cuadra.
     */
    it('el efectivo en cajón descuenta gastos y retiros y suma las entradas', async () => {
      sales = [sale({ total: 500, cashAmount: 500, amountReceived: 500, change: 0 })];
      movements = [
        movement({ id: 'm1', type: 'expense', amount: 100 }),
        movement({ id: 'm2', type: 'withdrawal', amount: 50 }),
        movement({ id: 'm3', type: 'deposit', amount: 20 }),
      ];
      await build();

      expect(component.cashInDrawer()).toBe(370);
    });

    it('sin movimientos la sección no se pinta y los totales son cero', () => {
      expect(component.hasMovements()).toBe(false);
      expect(component.expenseTotal()).toBe(0);
      expect(component.cashInDrawer()).toBe(component.cashCollected());
    });

    /**
     * Mezclar los gastos del día con las ventas de un turno daría un efectivo en
     * cajón que no cuadra con ningún corte.
     */
    it('pide los movimientos con el mismo alcance que las ventas', async () => {
      expect(scopeCalls.at(-1)).toEqual({ cashSessionId: 's1' });

      current = signal<CashSession | null>(null);
      fetchCurrent = () => of(null);
      await build();

      expect(scopeCalls.at(-1)).toHaveProperty('from');
    });

    /**
     * Van en el mismo `forkJoin`: un reporte con las ventas pero sin los gastos
     * mostraría un efectivo en cajón inflado, y es imprimible.
     */
    it('si los movimientos fallan, el reporte entero deja de darse por válido', async () => {
      listScope = () => throwError(() => new Error('IPC caído'));
      await build();

      expect(component.loaded()).toBe(false);
      expect(component.sales()).toEqual([]);
      expect(component.movements()).toEqual([]);
      expect(notifyError).toHaveBeenCalledWith('No se pudo cargar el reporte.');
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

  /**
   * Servicios: se reportan aparte de la farmacia. Lo primero que hay que fijar
   * no es una función nueva sino una corrección — agrupar ciego por id metía
   * los servicios en el Top 10 de medicamentos.
   */
  describe('servicios', () => {
    const partidaProducto = {
      kind: 'product' as const,
      productId: 'p1',
      productName: 'Paracetamol',
      unitPrice: 50,
      discountAmount: 0,
      quantity: 2,
      subtotal: 100,
    };
    const partidaServicio = {
      kind: 'service' as const,
      serviceId: 'sv-1',
      productName: 'Consulta general',
      providerId: 'dr-1',
      providerName: 'Dra. Ruiz',
      commissionRate: 40,
      commissionAmount: 80,
      unitPrice: 200,
      discountAmount: 0,
      quantity: 1,
      subtotal: 200,
    };

    async function conVentaMixta(): Promise<void> {
      sales = [
        sale({
          total: 300,
          cashAmount: 300,
          items: [partidaProducto, partidaServicio],
          pharmacyTotal: 100,
          servicesTotal: 200,
          pharmacyCashAmount: 100,
          servicesCashAmount: 200,
          commissionTotal: 80,
        }),
      ];
      listAll = () => of(sales);
      await build();
    }

    it('separa la venta de farmacia de la de servicios sin cambiar el gran total', async () => {
      await conVentaMixta();

      expect(component.pharmacyNet()).toBe(100);
      expect(component.servicesNet()).toBe(200);
      // `netTotal` conserva su significado: el total de la venta.
      expect(component.netTotal()).toBe(300);
    });

    it('los servicios NO aparecen en el top de medicamentos', async () => {
      await conVentaMixta();

      const nombres = component.topByAmount().map((row) => row.name);
      expect(nombres).toContain('Paracetamol');
      expect(nombres).not.toContain('Consulta general');
    });

    it('tienen su propio top', async () => {
      await conVentaMixta();

      expect(component.topServicesByAmount()).toEqual([
        expect.objectContaining({ name: 'Consulta general', quantity: 1, total: 200 }),
      ]);
    });

    it('agrupa la comisión por doctor', async () => {
      await conVentaMixta();

      expect(component.commissionsByProvider()).toEqual([
        expect.objectContaining({ name: 'Dra. Ruiz', count: 1, baseAmount: 200, commissionAmount: 80 }),
      ]);
      expect(component.commissionTotal()).toBe(80);
    });

    it('suma al mismo doctor de dos ventas distintas', async () => {
      sales = [
        sale({ id: 'v1', items: [partidaServicio], servicesTotal: 200, commissionTotal: 80 }),
        sale({ id: 'v2', items: [partidaServicio], servicesTotal: 200, commissionTotal: 80 }),
      ];
      listAll = () => of(sales);
      await build();

      const [fila] = component.commissionsByProvider();
      expect(fila).toMatchObject({ count: 2, commissionAmount: 160 });
    });

    it('un servicio sin doctor no rompe el reporte', async () => {
      sales = [
        sale({
          items: [{ ...partidaServicio, providerId: null, providerName: null }],
          servicesTotal: 200,
          commissionTotal: 80,
        }),
      ];
      listAll = () => of(sales);
      await build();

      expect(component.commissionsByProvider()).toHaveLength(1);
      expect(component.commissionsByProvider()[0].name).toBe('Sin doctor asignado');
    });

    it('una venta anulada no genera comisión ni venta de servicios', async () => {
      sales = [
        sale({ items: [partidaServicio], servicesTotal: 200, commissionTotal: 80, voidedAt: new Date() }),
      ];
      listAll = () => of(sales);
      await build();

      expect(component.servicesNet()).toBe(0);
      expect(component.commissionTotal()).toBe(0);
      expect(component.hasServiceActivity()).toBe(false);
    });

    it('el efectivo de servicios sale del reparto de la venta', async () => {
      await conVentaMixta();
      expect(component.servicesCash()).toBe(200);
    });

    /**
     * No-regresión: una venta anterior a los servicios no trae los campos
     * denormalizados y cuenta entera a farmacia.
     */
    it('una venta histórica sin los campos nuevos es 100% farmacia', async () => {
      sales = [sale({ total: 250, items: [partidaProducto] })];
      listAll = () => of(sales);
      await build();

      expect(component.pharmacyNet()).toBe(250);
      expect(component.servicesNet()).toBe(0);
      expect(component.hasServiceActivity()).toBe(false);
    });

    it('sin servicios en el periodo, las secciones no se muestran', async () => {
      expect(component.hasServiceActivity()).toBe(false);
    });
  });
});
