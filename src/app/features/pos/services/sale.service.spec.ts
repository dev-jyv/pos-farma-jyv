import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { CartLine, Product, Sale } from '../../../shared/models';
import { CreateSalePayload, SaleService, SaleTotals, newIdempotencyKey } from './sale.service';

const SALES_URL = `${environment.apiUrl}/sales`;
const PENDING_SALES_KEY = 'pos.pending-sales';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    sku: 'SKU1',
    name: 'Paracetamol',
    salePrice: 50,
    stock: 10,
    hasIva: true,
    ...overrides,
  } as Product;
}

function cart(): CartLine[] {
  return [{ product: product(), quantity: 2, discountAmount: 0 }];
}

function totals(overrides: Partial<SaleTotals> = {}): SaleTotals {
  return { subtotal: 100, discountTotal: 0, total: 100, cashDue: 100, cardAmount: null, ...overrides };
}

describe('SaleService', () => {
  let service: SaleService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SaleService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  describe('newIdempotencyKey', () => {
    it('genera llaves distintas por cobro', () => {
      expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
    });
  });

  describe('buildPayload', () => {
    it('reusa la llave del cobro en curso cuando el checkout la manda', () => {
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1', {
        idempotencyKey: 'key-fija',
      });
      expect(payload.idempotencyKey).toBe('key-fija');
    });

    it('genera una llave nueva cuando no se pasa (cobro nuevo)', () => {
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');
      expect(payload.idempotencyKey).toBeTruthy();
    });

    it('manda solo lo que el backend necesita de cada partida', () => {
      const payload = service.buildPayload(cart(), 5, 'cash', 100, null, 's1');
      expect(payload.items).toEqual([{ productId: 'p1', quantity: 2, discountAmount: 0 }]);
      expect(payload.saleDiscountAmount).toBe(5);
      expect(payload.cashSessionId).toBe('s1');
    });

    it('omite `prescriptionRetained` cuando el grupo no la exige', () => {
      const sinRetencion = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');
      expect('prescriptionRetained' in sinRetencion).toBe(false);

      const conRetencion = service.buildPayload(cart(), 0, 'cash', 100, null, 's1', {
        prescriptionRetained: false,
      });
      expect(conRetencion.prescriptionRetained).toBe(false);
    });

    it('normaliza los opcionales ausentes a null', () => {
      const payload = service.buildPayload(cart(), 0, 'card', null, 'order-1', 's1');
      expect(payload.customerId).toBeNull();
      expect(payload.customerName).toBeNull();
      expect(payload.prescription).toBeNull();
      expect(payload.billing).toBeNull();
      expect(payload.cardPaymentReference).toBe('order-1');
      expect(payload.amountReceived).toBeNull();
    });
  });

  describe('list', () => {
    it('manda solo los filtros presentes', () => {
      service.list({ cashSessionId: 's1', includeVoided: false, search: 'V-1' }).subscribe();

      const request = http.expectOne((req) => req.url === SALES_URL);
      expect(request.request.params.get('cashSessionId')).toBe('s1');
      expect(request.request.params.get('includeVoided')).toBe('false');
      expect(request.request.params.get('search')).toBe('V-1');
      expect(request.request.params.has('from')).toBe(false);
      request.flush({ data: [] });
    });

    it('mapea la venta: fechas a Date y grupos controlados filtrados', () => {
      let sales: Sale[] = [];
      service.list().subscribe((result) => (sales = result));

      http.expectOne((req) => req.url === SALES_URL).flush({
        data: [
          {
            id: 'v1',
            folio: 'V-000001',
            items: [],
            subtotal: 100,
            discountTotal: 0,
            total: 100,
            paymentMethod: 'cash',
            amountReceived: 100,
            change: 0,
            cardPaymentReference: null,
            cashierId: 'u1',
            cashSessionId: 's1',
            controlledGroups: ['I', 'NO_EXISTE'],
            voidedAt: null,
            createdAt: '2026-08-08T10:00:00.000Z',
          },
        ],
      });

      expect(sales[0].createdAt.toISOString()).toBe('2026-08-08T10:00:00.000Z');
      expect(sales[0].voidedAt).toBeNull();
      expect(sales[0].controlledGroups).toEqual(['I']);
      expect(sales[0].prescriptionRetained).toBe(false);
    });
  });

  describe('listAll', () => {
    it('encadena páginas hasta recibir una incompleta', () => {
      let sales: Sale[] = [];
      service.listAll({ cashSessionId: 's1' }).subscribe((result) => (sales = result));

      const firstPage = http.expectOne((req) => req.params.get('page') === '1');
      firstPage.flush({
        data: Array.from({ length: 100 }, (_, index) => saleDto(`v${index}`)),
      });

      const secondPage = http.expectOne((req) => req.params.get('page') === '2');
      secondPage.flush({ data: [saleDto('v100')] });

      expect(sales).toHaveLength(101);
      expect(service.lastListTruncated()).toBe(false);
    });
  });

  describe('create', () => {
    it('registra la venta cuando hay red', () => {
      let sale: Sale | undefined;
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');
      service.create(payload, cart(), totals()).subscribe((result) => (sale = result));

      const request = http.expectOne(SALES_URL);
      expect(request.request.method).toBe('POST');
      request.flush({ data: saleDto('v1') });

      expect(sale?.id).toBe('v1');
      expect(service.pendingCount()).toBe(0);
    });

    it('sin red encola la venta y devuelve un ticket offline con el id de la cola', () => {
      let sale: Sale | undefined;
      const payload = service.buildPayload(cart(), 0, 'cash', 150, null, 's1', {
        idempotencyKey: 'key-offline',
      });
      service.create(payload, cart(), totals()).subscribe((result) => (sale = result));

      http.expectOne(SALES_URL).error(new ProgressEvent('error'), { status: 0, statusText: '' });

      expect(sale?.id).toBe('offline-key-offline');
      expect(sale?.folio.startsWith('PENDIENTE-')).toBe(true);
      expect(sale?.total).toBe(100);
      // El cambio se calcula contra la parte en efectivo, igual que en el backend.
      expect(sale?.change).toBe(50);
      expect(service.pendingCount()).toBe(1);
      expect(service.pendingSales()[0].queueId).toBe('key-offline');
    });

    it('en pago mixto el ticket offline no devuelve como cambio lo que cubrió la tarjeta', () => {
      let sale: Sale | undefined;
      const payload = service.buildPayload(cart(), 0, 'mixed', 40, 'order-1', 's1', {
        idempotencyKey: 'key-mixto',
      });
      service
        .create(payload, cart(), totals({ cashDue: 40, cardAmount: 60 }))
        .subscribe((result) => (sale = result));

      http.expectOne(SALES_URL).error(new ProgressEvent('error'), { status: 0, statusText: '' });

      expect(sale?.cardAmount).toBe(60);
      expect(sale?.cashAmount).toBe(40);
      expect(sale?.change).toBe(0);
    });

    it('un error que no es de red se propaga en vez de encolarse', () => {
      let failed: unknown;
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');
      service.create(payload, cart(), totals()).subscribe({ error: (error) => (failed = error) });

      http.expectOne(SALES_URL).flush(
        { error: { message: 'Stock insuficiente' } },
        { status: 400, statusText: 'Bad Request' },
      );

      expect(failed).toBeTruthy();
      expect(service.pendingCount()).toBe(0);
    });
  });

  describe('flushQueue', () => {
    it('reenvía con la misma llave de idempotencia y vacía la cola al éxito', () => {
      enqueue(service, http, 'key-1');

      service.flushQueue();

      const request = http.expectOne(SALES_URL);
      expect((request.request.body as CreateSalePayload).idempotencyKey).toBe('key-1');
      // La cola no debe filtrar sus campos internos al backend.
      expect('queueId' in (request.request.body as object)).toBe(false);
      expect('offlineItems' in (request.request.body as object)).toBe(false);
      request.flush({ data: saleDto('v1') });

      expect(service.pendingCount()).toBe(0);
      expect(service.blockedSales()).toEqual([]);
    });

    it('un 4xx bloquea la venta: deja de reintentarse y el cajero la ve', () => {
      enqueue(service, http, 'key-2');

      service.flushQueue();
      http.expectOne(SALES_URL).flush(
        { error: { message: 'El turno de caja ya está cerrado' } },
        { status: 400, statusText: 'Bad Request' },
      );

      expect(service.pendingCount()).toBe(0);
      expect(service.blockedSales()).toHaveLength(1);
      expect(service.blockedSales()[0].reason).toBe('El turno de caja ya está cerrado');

      // Bloqueada: un flush posterior no la reintenta sola.
      service.flushQueue();
      http.expectNone(SALES_URL);
    });

    it('un 500 deja la venta en cola para el siguiente intento', () => {
      enqueue(service, http, 'key-3');

      service.flushQueue();
      http.expectOne(SALES_URL).flush({}, { status: 500, statusText: 'Server Error' });

      expect(service.blockedSales()).toEqual([]);
      expect(service.pendingCount()).toBe(1);
    });

    it('retryBlockedSale desbloquea y reintenta con la misma llave', () => {
      enqueue(service, http, 'key-4');
      service.flushQueue();
      http.expectOne(SALES_URL).flush({}, { status: 409, statusText: 'Conflict' });
      expect(service.blockedSales()).toHaveLength(1);

      service.retryBlockedSale('key-4');
      const retry = http.expectOne(SALES_URL);
      expect((retry.request.body as CreateSalePayload).idempotencyKey).toBe('key-4');
      retry.flush({ data: saleDto('v1') });

      expect(service.pendingCount()).toBe(0);
      expect(service.blockedSales()).toEqual([]);
    });

    it('discardBlockedSale saca la venta de la cola', () => {
      enqueue(service, http, 'key-5');
      service.flushQueue();
      http.expectOne(SALES_URL).flush({}, { status: 400, statusText: 'Bad Request' });

      service.discardBlockedSale('key-5');

      expect(service.blockedSales()).toEqual([]);
      expect(service.pendingCount()).toBe(0);
      expect(localStorage.getItem(PENDING_SALES_KEY)).toBe('[]');
    });
  });

  it('void pega a /sales/:id/void', () => {
    service.void('v1').subscribe();
    const request = http.expectOne(`${SALES_URL}/v1/void`);
    expect(request.request.method).toBe('POST');
    request.flush({ data: saleDto('v1') });
  });
});

/** Encola una venta simulando la caída de red del primer POST. */
function enqueue(service: SaleService, http: HttpTestingController, key: string): void {
  const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1', { idempotencyKey: key });
  service.create(payload, cart(), totals()).subscribe();
  http.expectOne(SALES_URL).error(new ProgressEvent('error'), { status: 0, statusText: '' });
}

function saleDto(id: string) {
  return {
    id,
    folio: `V-${id}`,
    items: [],
    subtotal: 100,
    discountTotal: 0,
    total: 100,
    paymentMethod: 'cash',
    amountReceived: 100,
    change: 0,
    cardPaymentReference: null,
    cashierId: 'u1',
    cashSessionId: 's1',
    voidedAt: null,
    createdAt: '2026-08-08T10:00:00.000Z',
  };
}
