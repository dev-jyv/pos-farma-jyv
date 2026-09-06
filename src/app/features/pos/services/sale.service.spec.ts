import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../core/auth/auth.service';
import { environment } from '../../../../environments/environment';
import { CartLine, Product, Sale } from '../../../shared/models';
import { PendingSale } from '../../../core/electron/window.d';
import { SaleService, SaleTotals, newIdempotencyKey } from './sale.service';

const SALES_URL = `${environment.apiUrl}/sales`;

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
  return [{ kind: 'product', product: product(), quantity: 2, discountAmount: 0 }];
}

function totals(overrides: Partial<SaleTotals> = {}): SaleTotals {
  return { subtotal: 100, discountTotal: 0, total: 100, cashDue: 100, cardAmount: null, ...overrides };
}

function localSale(overrides: Partial<Sale & { payload: unknown }> = {}): PendingSale {
  return {
    id: 'local-1',
    remoteId: null,
    pendingPush: true,
    folio: 'PENDIENTE-1',
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
    voidedBy: null,
    createdAt: new Date('2026-08-08T10:00:00.000Z'),
    payload: { idempotencyKey: 'key-1' },
    pushError: null,
    ...overrides,
  };
}

describe('SaleService', () => {
  let service: SaleService;
  let http: HttpTestingController;
  let sales: {
    createLocal: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    getPendingPush: ReturnType<typeof vi.fn>;
    getPendingVoided: ReturnType<typeof vi.fn>;
    markUnreconciled: ReturnType<typeof vi.fn>;
    markSynced: ReturnType<typeof vi.fn>;
    markPushFailed: ReturnType<typeof vi.fn>;
    voidLocal: ReturnType<typeof vi.fn>;
    clearPushError: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
    getNeedingRemoteVoid: ReturnType<typeof vi.fn>;
    markNeedsRemoteVoid: ReturnType<typeof vi.fn>;
    markRemoteVoided: ReturnType<typeof vi.fn>;
    listMovements: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    sales = {
      createLocal: vi.fn().mockResolvedValue(localSale()),
      list: vi.fn().mockResolvedValue([]),
      getPendingPush: vi.fn().mockResolvedValue([]),
      getPendingVoided: vi.fn().mockResolvedValue([]),
      markUnreconciled: vi.fn().mockResolvedValue(undefined),
      markSynced: vi.fn().mockResolvedValue(undefined),
      markPushFailed: vi.fn().mockResolvedValue(undefined),
      voidLocal: vi.fn().mockResolvedValue(localSale({ voidedAt: new Date(), pendingPush: false })),
      clearPushError: vi.fn().mockResolvedValue(undefined),
      discard: vi.fn().mockResolvedValue(undefined),
      getNeedingRemoteVoid: vi.fn().mockResolvedValue([]),
      markNeedsRemoteVoid: vi.fn().mockResolvedValue(undefined),
      listMovements: vi.fn().mockResolvedValue([]),
      markRemoteVoided: vi.fn().mockResolvedValue(undefined),
    };
    window.electronAPI = {
      getAppVersion: vi.fn(),
      getDeviceInfo: vi.fn(),
      openCashDrawer: vi.fn(),
      catalog: {
        search: vi.fn(),
        getByBarcode: vi.fn(),
        recordStockEntry: vi.fn(),
        upsertMany: vi.fn(),
        getPendingStockEntries: vi.fn(),
        markStockEntrySynced: vi.fn(),
        markStockEntryPushFailed: vi.fn(),
      },
      sales,
      sync: { getStatus: vi.fn(), recordRun: vi.fn() },
    } as unknown as Window['electronAPI'];

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            user: () => ({ uid: 'u1', email: 'caja@farmajyv.mx' }),
            isAdmin: () => false,
          },
        },
      ],
    });
    service = TestBed.inject(SaleService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

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

    it('manda solo lo que el backend necesita de cada partida', () => {
      const payload = service.buildPayload(cart(), 5, 'cash', 100, null, 's1');
      expect(payload.items).toEqual([
        // `unitPrice`: el precio **cobrado**. Sin él, el backend retarifa con el
        // catálogo del momento de sincronizar y una venta offline se rechaza si
        // el precio cambió entre medias.
        { kind: 'product', productId: 'p1', quantity: 2, discountAmount: 0, unitPrice: 50 },
      ]);
      expect(payload.saleDiscountAmount).toBe(5);
      expect(payload.cashSessionId).toBe('s1');
    });

    it('normaliza los opcionales ausentes a null', () => {
      const payload = service.buildPayload(cart(), 0, 'card', null, 'order-1', 's1');
      expect(payload.customerId).toBeNull();
      expect(payload.billing).toBeNull();
      expect(payload.cardPaymentReference).toBe('order-1');
      expect(payload.amountReceived).toBeNull();
    });
  });

  describe('list', () => {
    it('pide al catálogo local con los filtros presentes', () => {
      service.list({ cashSessionId: 's1', includeVoided: false, search: 'V-1' }).subscribe();
      expect(sales.list).toHaveBeenCalledWith({
        cashSessionId: 's1',
        includeVoided: false,
        from: undefined,
        to: undefined,
        search: 'V-1',
      });
    });
  });

  describe('create', () => {
    it('escribe siempre local (sin red) y arma el ticket con folio provisional', async () => {
      const payload = service.buildPayload(cart(), 0, 'cash', 150, null, 's1');
      let sale: Sale | undefined;
      service.create(payload, cart(), totals()).subscribe((result) => (sale = result));
      await Promise.resolve();

      expect(sales.createLocal).toHaveBeenCalledTimes(1);
      const input = sales.createLocal.mock.calls[0][0];
      expect(input.folio.startsWith('PENDIENTE-')).toBe(true);
      expect(input.cashierId).toBe('u1');
      expect(input.change).toBe(50);
      expect(sale?.id).toBe('local-1');
      http.expectNone(SALES_URL);
    });

    it('en pago mixto no descuenta como cambio lo que cubrió la tarjeta', async () => {
      const payload = service.buildPayload(cart(), 0, 'mixed', 40, 'order-1', 's1');
      service.create(payload, cart(), totals({ cashDue: 40, cardAmount: 60 })).subscribe();
      await Promise.resolve();

      const input = sales.createLocal.mock.calls[0][0];
      expect(input.cardAmount).toBe(60);
      expect(input.cashAmount).toBe(40);
      expect(input.change).toBe(0);
    });
  });

  describe('void', () => {
    it('venta pendiente de sync: se anula solo local, sin red', () => {
      service.void(localSale()).subscribe();
      expect(sales.voidLocal).toHaveBeenCalledWith('local-1', 'u1', 'caja@farmajyv.mx');
      http.expectNone(`${SALES_URL}/local-1/void`);
    });

    it('venta ya sincronizada: anula en el backend y refleja el resultado local', async () => {
      const synced: Sale = { ...localSale(), id: 'v1', remoteId: 'v1', pendingPush: false };
      sales.voidLocal.mockResolvedValue({ ...synced, voidedAt: new Date('2026-08-08T10:00:00.000Z') });
      let result: Sale | undefined;
      service.void(synced).subscribe((sale) => (result = sale));

      const request = http.expectOne(`${SALES_URL}/v1/void`);
      expect(request.request.method).toBe('POST');
      request.flush({
        data: {
          id: 'v1',
          folio: 'V-1',
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
          voidedAt: '2026-08-08T10:00:00.000Z',
          createdAt: '2026-08-08T10:00:00.000Z',
        },
      });
      await flushMicrotasks();

      expect(sales.voidLocal).toHaveBeenCalledWith('v1', 'u1', 'caja@farmajyv.mx');
      expect(sales.markRemoteVoided).toHaveBeenCalledWith('v1');
      expect(sales.markNeedsRemoteVoid).not.toHaveBeenCalled();
      expect(result?.id).toBe('v1');
    });

    it('lista con pendingPush viejo pero remoteId: igual intenta el void remoto', async () => {
      const stale: Sale = { ...localSale(), id: 'v1', remoteId: 'remote-1', pendingPush: true };
      sales.voidLocal.mockResolvedValue({ ...stale, voidedAt: new Date() });
      service.void(stale).subscribe();

      http.expectOne(`${SALES_URL}/remote-1/void`).flush({
        data: {
          id: 'remote-1',
          folio: 'V-1',
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
          voidedAt: '2026-08-08T10:00:00.000Z',
          createdAt: '2026-08-08T10:00:00.000Z',
        },
      });
      await flushMicrotasks();

      expect(sales.voidLocal).toHaveBeenCalled();
      expect(sales.markRemoteVoided).toHaveBeenCalledWith('v1');
    });

    it('sin red: anula en local y la deja marcada para anularse en el servidor', async () => {
      const synced: Sale = { ...localSale(), id: 'v1', remoteId: 'v1', pendingPush: false };
      let voided: Sale | undefined;
      service.void(synced).subscribe((result) => (voided = result));

      http
        .expectOne(`${SALES_URL}/v1/void`)
        .error(new ProgressEvent('error'), { status: 0, statusText: '' });
      await flushMicrotasks();

      // El cliente está enfrente y el dinero ya se devolvió: la anulación no
      // puede esperar a que vuelva el internet.
      expect(sales.voidLocal).toHaveBeenCalledWith('v1', 'u1', 'caja@farmajyv.mx');
      expect(sales.markNeedsRemoteVoid).toHaveBeenCalledWith('v1');
      expect(voided?.voidedAt).toBeInstanceOf(Date);
    });

    it('un rechazo del servidor NO se anula en local: las dos bases quedarían discrepando', async () => {
      const synced: Sale = { ...localSale(), id: 'v1', remoteId: 'v1', pendingPush: false };
      let failed: unknown;
      service.void(synced).subscribe({ error: (error) => (failed = error) });

      http.expectOne(`${SALES_URL}/v1/void`).flush(
        { error: { message: 'La venta ya está anulada' } },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      expect(failed).toBeTruthy();
      expect(sales.voidLocal).not.toHaveBeenCalled();
      expect(sales.markNeedsRemoteVoid).not.toHaveBeenCalled();
    });

    /**
     * Lo que el sincronizador espera antes de cerrar el turno. Las anulaciones
     * salían en un `tap`, disparadas y olvidadas: corrían por fuera del orden y
     * el cierre podía adelantarlas. Las dos formas mueren si el cierre gana —
     * `POST /sales` responde "el turno de caja ya está cerrado", y
     * `POST /sales/:id/void` responde "solo un administrador puede anularla".
     */
    describe('flushQueueAsync espera también a las anulaciones', () => {
      it('no resuelve hasta que la anulación remota se aplicó', async () => {
        sales.getNeedingRemoteVoid.mockResolvedValue([
          { id: 'v1', remoteId: 'remote-1', voidedAt: null, voidedBy: null },
        ]);
        let resuelta = false;

        void service.flushQueueAsync().then(() => {
          resuelta = true;
        });
        await flushMicrotasks();

        const request = http.expectOne(`${SALES_URL}/remote-1/void`);
        // Si resolviera aquí, el cierre saldría antes que esta anulación.
        expect(resuelta).toBe(false);

        sales.getNeedingRemoteVoid.mockResolvedValue([]);
        request.flush({ data: {} });
        await flushMicrotasks();
        await flushMicrotasks();

        expect(resuelta).toBe(true);
        expect(sales.markRemoteVoided).toHaveBeenCalledWith('v1');
      });

      it('no resuelve hasta que la venta anulada que nunca subió se creó y se anuló', async () => {
        sales.getPendingVoided.mockResolvedValue([
          { id: 'v2', payload: { idempotencyKey: 'k-v2' }, voidedAt: null, voidedBy: null },
        ]);
        let resuelta = false;

        void service.flushQueueAsync().then(() => {
          resuelta = true;
        });
        await flushMicrotasks();

        // Se crea y se anula, en dos pasos: sin el alta, el libro de control se
        // queda sin el asiento y sin su reversa.
        const alta = http.expectOne(SALES_URL);
        expect(resuelta).toBe(false);
        sales.getPendingVoided.mockResolvedValue([]);
        alta.flush({ data: { id: 'remote-2', folio: 'A-2', items: [], createdAt: new Date().toISOString(), voidedAt: null } });
        await flushMicrotasks();

        const anulacion = http.expectOne(`${SALES_URL}/remote-2/void`);
        expect(resuelta).toBe(false);
        anulacion.flush({ data: {} });
        await flushMicrotasks();
        await flushMicrotasks();

        expect(resuelta).toBe(true);
      });
    });

    it('la anulación pendiente viaja con su hora y su autor reales', async () => {
      sales.getNeedingRemoteVoid.mockResolvedValue([
        {
          id: 'v1',
          remoteId: 'remote-1',
          voidedAt: '2026-09-03T18:20:00.000Z',
          voidedBy: 'u9',
        },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      const request = http.expectOne(`${SALES_URL}/remote-1/void`);
      // Sin esto el backend sellaría la anulación con la hora del sync y a
      // nombre de quien sincronizó.
      expect(request.request.body).toEqual({
        voidedAt: '2026-09-03T18:20:00.000Z',
        voidedBy: 'u9',
      });
      request.flush({ data: {} });
      await flushMicrotasks();

      expect(sales.markRemoteVoided).toHaveBeenCalledWith('v1');
    });

    it('la anulación pendiente se cierra en el servidor en el siguiente sync', async () => {
      sales.getNeedingRemoteVoid.mockResolvedValue([
        { id: 'v1', remoteId: 'remote-1', voidedAt: null, voidedBy: null },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      const request = http.expectOne(`${SALES_URL}/remote-1/void`);
      expect(request.request.method).toBe('POST');
      request.flush({ data: {} });
      await flushMicrotasks();

      expect(sales.markRemoteVoided).toHaveBeenCalledWith('v1');
    });
  });

  describe('rechazo del servidor', () => {
    /** Encola una venta y deja el bulk devolviendo el rechazo indicado. */
    function rejectWith(error: string): void {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'local-1', total: 100, payload: { idempotencyKey: 'key-1' } }),
      ]);
      service.flushQueue();
    }

    it('un rechazo por inventario se guarda como venta no conciliada', async () => {
      rejectWith('Stock insuficiente para CORIVER');
      await flushMicrotasks();

      http.expectOne(`${SALES_URL}/bulk`).flush({
        data: [{ ok: false, error: 'Stock insuficiente para CORIVER' }],
      });
      await flushMicrotasks();

      // El dinero ya se cobró: el movimiento no puede quedarse muerto en la caja.
      const request = http.expectOne(`${SALES_URL}/unreconciled`);
      expect(request.request.body).toMatchObject({
        localId: 'local-1',
        reason: 'Stock insuficiente para CORIVER',
        total: 100,
      });
      request.flush({ data: { id: 'local-1' } });
      await flushMicrotasks();

      expect(sales.markUnreconciled).toHaveBeenCalledWith('local-1', 'Stock insuficiente para CORIVER');
      expect(sales.markPushFailed).not.toHaveBeenCalled();
    });

    it('un rechazo por turno cerrado se guarda como venta no conciliada', async () => {
      rejectWith('El turno de caja ya está cerrado');
      await flushMicrotasks();

      http.expectOne(`${SALES_URL}/bulk`).flush({
        data: [{ ok: false, error: 'El turno de caja ya está cerrado' }],
      });
      await flushMicrotasks();

      const request = http.expectOne(`${SALES_URL}/unreconciled`);
      expect(request.request.body).toMatchObject({
        localId: 'local-1',
        reason: 'El turno de caja ya está cerrado',
        total: 100,
      });
      request.flush({ data: { id: 'local-1' } });
      await flushMicrotasks();

      expect(sales.markUnreconciled).toHaveBeenCalledWith('local-1', 'El turno de caja ya está cerrado');
      expect(sales.markPushFailed).not.toHaveBeenCalled();
    });

    it('un rechazo que el cajero sí puede corregir se marca como bloqueado', async () => {
      rejectWith('Llave de idempotencia ya usada');
      await flushMicrotasks();

      http.expectOne(`${SALES_URL}/bulk`).flush({
        data: [{ ok: false, error: 'Llave de idempotencia ya usada' }],
      });
      await flushMicrotasks();

      http.expectNone(`${SALES_URL}/unreconciled`);
      expect(sales.markPushFailed).toHaveBeenCalledWith('local-1', 'Llave de idempotencia ya usada');
    });

    it('si tampoco se puede guardar aparte, queda bloqueada y visible', async () => {
      rejectWith('Stock insuficiente para CORIVER');
      await flushMicrotasks();

      http.expectOne(`${SALES_URL}/bulk`).flush({
        data: [{ ok: false, error: 'Stock insuficiente para CORIVER' }],
      });
      await flushMicrotasks();

      http.expectOne(`${SALES_URL}/unreconciled`).flush({}, { status: 500, statusText: 'Error' });
      await flushMicrotasks();

      expect(sales.markPushFailed).toHaveBeenCalledWith('local-1', 'Stock insuficiente para CORIVER');
    });
  });

  describe('ventas anuladas sin sincronizar', () => {
    it('se crean y se anulan en el servidor, con su hora y su autor', async () => {
      sales.getPendingVoided.mockResolvedValue([
        {
          ...localSale({ id: 'local-9', payload: { idempotencyKey: 'key-9' } }),
          voidedAt: '2026-09-03T18:20:00.000Z',
          voidedBy: 'u9',
        },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      // Sin esto el backend no se entera de que esa venta ocurrió, y el libro de
      // control se queda sin el asiento ni su reversa.
      const created = http.expectOne(SALES_URL);
      expect(created.request.body).toEqual({ idempotencyKey: 'key-9' });
      created.flush({ data: { id: 'remote-9', folio: 'V-9', items: [], subtotal: 0, discountTotal: 0, total: 0, paymentMethod: 'cash', amountReceived: 0, change: 0, cardPaymentReference: null, cashierId: 'u1', cashSessionId: 's1', voidedAt: null, createdAt: '2026-09-03T18:00:00.000Z' } });
      await flushMicrotasks();

      const voided = http.expectOne(`${SALES_URL}/remote-9/void`);
      expect(voided.request.body).toEqual({
        voidedAt: '2026-09-03T18:20:00.000Z',
        voidedBy: 'u9',
      });
      voided.flush({ data: {} });
      await flushMicrotasks();

      expect(sales.markSynced).toHaveBeenCalledWith('local-9', 'remote-9', 'V-9');
      expect(sales.markRemoteVoided).toHaveBeenCalledWith('local-9');
    });
  });

  describe('bitácora de movimientos', () => {
    it('la venta se registra con el correo del cajero, no con su uid', () => {
      service.create(service.buildPayload(cart(), 0, 'cash', 150, null, 's1'), cart(), totals()).subscribe();

      const input = sales.createLocal.mock.calls[0][0] as { cashierLabel?: string };
      expect(input.cashierLabel).toBe('caja@farmajyv.mx');
    });

    it('expone la bitácora de una venta para el detalle del historial', async () => {
      const movements = [
        { id: 'm1', saleId: 'v1', type: 'sale', userId: 'u1', userLabel: 'caja@farmajyv.mx', reason: null, occurredAt: '2026-09-03T18:00:00.000Z' },
        { id: 'm2', saleId: 'v1', type: 'void', userId: 'u9', userLabel: 'ana@farmajyv.mx', reason: null, occurredAt: '2026-09-03T18:20:00.000Z' },
      ];
      sales.listMovements.mockResolvedValue(movements);

      let result: unknown;
      service.movements('v1').subscribe((value) => (result = value));
      await flushMicrotasks();

      expect(sales.listMovements).toHaveBeenCalledWith('v1');
      expect(result).toEqual(movements);
    });
  });

  describe('flushQueue', () => {
    const BULK_URL = `${SALES_URL}/bulk`;

    it('manda todas las pendientes en una sola llamada a /sales/bulk', () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'local-1', payload: { idempotencyKey: 'key-1' } }),
        localSale({ id: 'local-2', payload: { idempotencyKey: 'key-2' } }),
      ]);

      service.flushQueue();

      return Promise.resolve().then(() => {
        const request = http.expectOne(BULK_URL);
        expect(request.request.body).toEqual({
          items: [{ idempotencyKey: 'key-1' }, { idempotencyKey: 'key-2' }],
        });
        request.flush({
          data: [
            { ok: true, sale: { id: 'v1', folio: 'V-1' } },
            { ok: true, sale: { id: 'v2', folio: 'V-2' } },
          ],
        });
        expect(sales.markSynced).toHaveBeenCalledWith('local-1', 'v1', 'V-1');
        expect(sales.markSynced).toHaveBeenCalledWith('local-2', 'v2', 'V-2');
        http.expectNone(SALES_URL);
      });
    });

    it('un 4xx del lote entero deja las ventas bloqueadas con el motivo', async () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'local-1', payload: { idempotencyKey: 'key-1' } }),
        localSale({ id: 'local-2', payload: { idempotencyKey: 'key-2' } }),
      ]);

      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(BULK_URL).flush(
        { error: { message: 'Turno de caja no encontrado' } },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      expect(sales.markPushFailed).toHaveBeenCalledWith('local-1', 'Turno de caja no encontrado');
      expect(sales.markPushFailed).toHaveBeenCalledWith('local-2', 'Turno de caja no encontrado');
    });

    it('un 5xx del lote deja las ventas en cola para reintentar', async () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'local-1', payload: { idempotencyKey: 'key-1' } }),
      ]);

      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(BULK_URL).flush(
        { error: { message: 'Unavailable' } },
        { status: 503, statusText: 'Service Unavailable' },
      );
      await flushMicrotasks();

      expect(sales.markPushFailed).not.toHaveBeenCalled();
      expect(sales.markSynced).not.toHaveBeenCalled();
    });

    it('una venta rechazada por índice se bloquea sin tumbar el resto del lote', () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'local-1' }),
        localSale({ id: 'local-2', payload: { idempotencyKey: 'key-2' } }),
      ]);
      service.flushQueue();

      return Promise.resolve().then(() => {
        http.expectOne(BULK_URL).flush({
          data: [
            { ok: false, error: 'Llave de idempotencia ya usada' },
            { ok: true, sale: { id: 'v2', folio: 'V-2' } },
          ],
        });
        expect(sales.markPushFailed).toHaveBeenCalledWith('local-1', 'Llave de idempotencia ya usada');
        expect(sales.markSynced).toHaveBeenCalledWith('local-2', 'v2', 'V-2');
      });
    });

    it('si falla el lote completo (red/500) no marca nada: se reintenta en el próximo sync', () => {
      sales.getPendingPush.mockResolvedValue([localSale()]);
      service.flushQueue();

      return Promise.resolve().then(() => {
        http.expectOne(BULK_URL).flush({}, { status: 500, statusText: 'Server Error' });
        expect(sales.markPushFailed).not.toHaveBeenCalled();
        expect(sales.markSynced).not.toHaveBeenCalled();
      });
    });

    it('sin pendientes no manda nada', () => {
      sales.getPendingPush.mockResolvedValue([]);
      service.flushQueue();
      http.expectNone(BULK_URL);
    });
  });

  it('retryBlockedSale limpia el error y vuelve a intentar', () => {
    service.retryBlockedSale('local-1');
    expect(sales.clearPushError).toHaveBeenCalledWith('local-1');
  });

  it('discardBlockedSale descarta la venta local', () => {
    service.discardBlockedSale('local-1');
    expect(sales.discard).toHaveBeenCalledWith('local-1');
  });
});

/** El flujo encadena promesas de IPC entre cada paso observable. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
