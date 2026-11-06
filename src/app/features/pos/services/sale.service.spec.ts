import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../core/auth/auth.service';
import { environment } from '../../../../environments/environment';
import { CartLine, Product, Sale } from '../../../shared/models';
import { PendingSale } from '../../../core/electron/window.d';
import { BULK_MAX_ITEMS, SaleService, SaleTotals, newIdempotencyKey } from './sale.service';
import { ClockSkewService } from '../../../core/time/clock-skew.service';

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

function localSale(
  overrides: Partial<Sale & { payload: unknown; esperandoPor: PendingSale['esperandoPor'] }> = {},
): PendingSale {
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
    markVoidFailed: ReturnType<typeof vi.fn>;
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
      markVoidFailed: vi.fn().mockResolvedValue(undefined),
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

    it('con promoción manda solo su id; el monto lo recalcula el backend', () => {
      const conPromo: CartLine[] = [
        {
          kind: 'product',
          product: product(),
          quantity: 2,
          discountAmount: 10,
          promotion: { id: 'promo-1', name: 'Paracetamol 2x$60', discountAmount: 10 },
        },
      ];
      const payload = service.buildPayload(conPromo, 0, 'cash', 100, null, 's1');
      expect(payload.items).toEqual([
        {
          kind: 'product',
          productId: 'p1',
          quantity: 2,
          discountAmount: 10,
          unitPrice: 50,
          promotionId: 'promo-1',
        },
      ]);
    });

    it('una caja manda cantidad en cajas, precio de la caja y saleUnit; nunca promotionId (SPEC 46)', () => {
      const conCaja: CartLine[] = [
        {
          kind: 'product',
          product: product({ boxQuantity: 10, boxPrice: 450 }),
          quantity: 2,
          discountAmount: 0,
          saleUnit: 'box',
          // Aunque llegara una promo pegada, una caja no la lleva.
          promotion: { id: 'promo-1', name: 'X', discountAmount: 0 },
        },
        { kind: 'product', product: product({ boxQuantity: 10, boxPrice: 450 }), quantity: 3, discountAmount: 0 },
      ];
      const payload = service.buildPayload(conCaja, 0, 'cash', 1100, null, 's1');
      expect(payload.items).toEqual([
        { kind: 'product', productId: 'p1', quantity: 2, discountAmount: 0, unitPrice: 450, saleUnit: 'box' },
        { kind: 'product', productId: 'p1', quantity: 3, discountAmount: 0, unitPrice: 50 },
      ]);
    });

    it('cupón de producto: su parte va en el discountAmount de la línea y el código en couponCode (SPEC 47)', () => {
      const conCupon: CartLine[] = [
        {
          kind: 'product',
          product: product(),
          quantity: 2,
          discountAmount: 10,
          coupon: { code: 'PARA10', discountAmount: 10 },
        },
      ];
      const payload = service.buildPayload(conCupon, 0, 'cash', 90, null, 's1', { couponCode: 'PARA10' });
      expect(payload.items[0]).toEqual({ kind: 'product', productId: 'p1', quantity: 2, discountAmount: 10, unitPrice: 50 });
      expect(payload.couponCode).toBe('PARA10');
      expect(payload.saleDiscountAmount).toBe(0);
    });

    it('cupón de venta: va como saleDiscountAmount, sin tocar las líneas', () => {
      const payload = service.buildPayload(cart(), 25, 'cash', 75, null, 's1', { couponCode: 'VENTA25' });
      expect(payload.saleDiscountAmount).toBe(25);
      expect(payload.couponCode).toBe('VENTA25');
      expect(payload.items[0].discountAmount).toBe(0);
    });

    it('sin cupón el payload no lleva couponCode (la huella queda igual que antes)', () => {
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1', { couponCode: null });
      expect('couponCode' in payload).toBe(false);
    });

    it('lleva la hora local del cobro para validar la promo al sincronizar', () => {
      const antes = Date.now();
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');
      const soldAt = Date.parse(payload.soldAt);
      expect(soldAt).toBeGreaterThanOrEqual(antes);
      expect(soldAt).toBeLessThanOrEqual(Date.now());
    });

    it('sin medición del reloj no manda clockSkewMs (SPEC 65)', () => {
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');
      expect('clockSkewMs' in payload).toBe(false);
    });

    it('con el reloj medido manda soldAt corregido y clockSkewMs (SPEC 65)', () => {
      const clock = TestBed.inject(ClockSkewService);
      const ahora = Date.now();
      clock.record(new Date(ahora - 3 * 3_600_000).toUTCString(), ahora, ahora);

      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');

      expect(payload.clockSkewMs).toBe(clock.skewMs());
      // La caja va 3 h adelantada: la venta se fecha con la hora del servidor.
      expect(Math.abs(Date.parse(payload.soldAt) - (Date.now() - 3 * 3_600_000))).toBeLessThan(1_500);
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
    /**
     * Regresión (QA-16): `api()` lanzaba al **construir** el observable, así que
     * la excepción salía fuera del stream y el `catchError` del historial no la
     * veía: tabla vacía, "Actualizar" deshabilitado y el error solo en la
     * consola — indistinguible de "no hay ventas".
     */
    it('sin electronAPI el fallo viaja por el canal de error, no como excepción suelta', () => {
      const guardado = window.electronAPI;
      delete (window as { electronAPI?: Window['electronAPI'] }).electronAPI;

      let error: Error | undefined;
      // Construir el observable no debe lanzar…
      const listado = service.list();
      // …y suscribirse debe entregar el error a la pantalla.
      listado.subscribe({ error: (fallo: Error) => (error = fallo) });

      window.electronAPI = guardado;
      expect(error?.message).toMatch(/necesita la app de escritorio/i);
    });

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

    it('una caja se guarda en local con piezas, la caja aparte y el cupón del ticket', async () => {
      const conCaja: CartLine[] = [
        {
          kind: 'product',
          product: product({ boxQuantity: 10, boxPrice: 450 }),
          quantity: 2,
          discountAmount: 90,
          saleUnit: 'box',
          coupon: { code: 'CAJA10', discountAmount: 90 },
        },
      ];
      const payload = service.buildPayload(conCaja, 0, 'cash', 810, null, 's1', { couponCode: 'CAJA10' });
      service
        .create(payload, conCaja, totals({ subtotal: 900, discountTotal: 90, total: 810, cashDue: 810 }), {
          code: 'CAJA10',
          name: 'Caja 10 %',
          scope: 'product',
          discountAmount: 90,
        })
        .subscribe();
      await Promise.resolve();

      const input = sales.createLocal.mock.calls[0][0];
      expect(input.items[0]).toMatchObject({
        quantity: 20,
        unitPrice: 450,
        subtotal: 900,
        discountAmount: 90,
        couponDiscount: 90,
        saleUnit: { type: 'box', boxes: 2, piecesPerBox: 10, boxPrice: 450 },
      });
      expect(input.coupon).toEqual({ code: 'CAJA10', name: 'Caja 10 %', scope: 'product', discountAmount: 90 });
      expect(input.payload.items[0]).toMatchObject({ quantity: 2, saleUnit: 'box' });
    });

    it('un cupón de venta entra al desglose fiscal y a los totales por rama', async () => {
      const payload = service.buildPayload(cart(), 20, 'cash', 80, null, 's1', { couponCode: 'VENTA20' });
      service.create(payload, cart(), totals({ discountTotal: 20, total: 80, cashDue: 80 })).subscribe();
      await Promise.resolve();

      const input = sales.createLocal.mock.calls[0][0];
      expect(input.taxSummary.total).toBe(80);
      expect(input.pharmacyTotal).toBe(80);
      expect(input.servicesTotal).toBe(0);
    });

    it('borra el borrador del ticket en la misma secuencia que confirma la venta (SPEC 66)', async () => {
      localStorage.setItem(
        'pos.current-cart.u1',
        JSON.stringify({ lines: [{}], manualDiscounts: {}, savedAt: new Date().toISOString() }),
      );
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');
      service.create(payload, cart(), totals()).subscribe();
      await flushMicrotasks();

      expect(sales.createLocal).toHaveBeenCalled();
      expect(localStorage.getItem('pos.current-cart.u1')).toBeNull();
    });

    it('si la caja no confirma la venta, el borrador se queda', async () => {
      localStorage.setItem(
        'pos.current-cart.u1',
        JSON.stringify({ lines: [{}], manualDiscounts: {}, savedAt: new Date().toISOString() }),
      );
      sales.createLocal.mockRejectedValueOnce(new Error('SQLite ocupada'));
      const payload = service.buildPayload(cart(), 0, 'cash', 100, null, 's1');
      service.create(payload, cart(), totals()).subscribe({ error: () => undefined });
      await flushMicrotasks();

      expect(localStorage.getItem('pos.current-cart.u1')).not.toBeNull();
      localStorage.clear();
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
      service.void(localSale(), 'Cliente desistió').subscribe();
      expect(sales.voidLocal).toHaveBeenCalledWith('local-1', 'u1', 'caja@farmajyv.mx', 'Cliente desistió');
      http.expectNone(`${SALES_URL}/local-1/void`);
    });

    it('venta ya sincronizada: anula en el backend y refleja el resultado local', async () => {
      const synced: Sale = { ...localSale(), id: 'v1', remoteId: 'v1', pendingPush: false };
      sales.voidLocal.mockResolvedValue({ ...synced, voidedAt: new Date('2026-08-08T10:00:00.000Z') });
      let result: Sale | undefined;
      service.void(synced, 'Error de captura').subscribe((sale) => (result = sale));

      const request = http.expectOne(`${SALES_URL}/v1/void`);
      expect(request.request.method).toBe('POST');
      // SPEC 62: el motivo viaja en el cuerpo de la anulación.
      expect(request.request.body).toEqual({ reason: 'Error de captura' });
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

      expect(sales.voidLocal).toHaveBeenCalledWith('v1', 'u1', 'caja@farmajyv.mx', 'Error de captura');
      expect(sales.markRemoteVoided).toHaveBeenCalledWith('v1');
      expect(sales.markNeedsRemoteVoid).not.toHaveBeenCalled();
      expect(result?.id).toBe('v1');
    });

    it('lista con pendingPush viejo pero remoteId: igual intenta el void remoto', async () => {
      const stale: Sale = { ...localSale(), id: 'v1', remoteId: 'remote-1', pendingPush: true };
      sales.voidLocal.mockResolvedValue({ ...stale, voidedAt: new Date() });
      service.void(stale, 'Cliente desistió').subscribe();

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
      service.void(synced, 'Producto equivocado').subscribe((result) => (voided = result));

      http
        .expectOne(`${SALES_URL}/v1/void`)
        .error(new ProgressEvent('error'), { status: 0, statusText: '' });
      await flushMicrotasks();

      // El cliente está enfrente y el dinero ya se devolvió: la anulación no
      // puede esperar a que vuelva el internet.
      expect(sales.voidLocal).toHaveBeenCalledWith(
        'v1',
        'u1',
        'caja@farmajyv.mx',
        'Producto equivocado',
      );
      expect(sales.markNeedsRemoteVoid).toHaveBeenCalledWith('v1');
      expect(voided?.voidedAt).toBeInstanceOf(Date);
    });

    it('un rechazo del servidor NO se anula en local: las dos bases quedarían discrepando', async () => {
      const synced: Sale = { ...localSale(), id: 'v1', remoteId: 'v1', pendingPush: false };
      let failed: unknown;
      service.void(synced, 'Cliente desistió').subscribe({ error: (error) => (failed = error) });

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
        const alta = http.expectOne(`${SALES_URL}/bulk`);
        expect(resuelta).toBe(false);
        sales.getPendingVoided.mockResolvedValue([]);
        alta.flush({ data: [{ ok: true, sale: { id: 'remote-2', folio: 'A-2' } }] });
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
      // Sin motivo guardado (anulada antes de SPEC 62): el texto de POS anterior.
      expect(request.request.body).toEqual({
        reason: 'Sin motivo (POS anterior)',
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

    it('ALREADY_VOIDED cierra la anulación pendiente aunque el texto no diga "anulada" (SPEC 49)', async () => {
      sales.getNeedingRemoteVoid.mockResolvedValue([
        { id: 'v1', remoteId: 'remote-1', voidedAt: null, voidedBy: null },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${SALES_URL}/remote-1/void`).flush(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'Operación repetida',
            details: { code: 'ALREADY_VOIDED', retryable: false },
          },
        },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      expect(sales.markRemoteVoided).toHaveBeenCalledWith('v1');
    });

    it('un rechazo con otro código no la da por anulada', async () => {
      sales.getNeedingRemoteVoid.mockResolvedValue([
        { id: 'v1', remoteId: 'remote-1', voidedAt: null, voidedBy: null },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${SALES_URL}/remote-1/void`).flush(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'La venta ya fue anulada parcialmente por devolución',
            details: { code: 'HAS_RETURNS', retryable: false },
          },
        },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      // Con código, el texto ("anulada") ya no decide.
      expect(sales.markRemoteVoided).not.toHaveBeenCalled();
      // SPEC 62: ya no se reintenta en silencio; queda visible en "Rechazados".
      expect(sales.markVoidFailed).toHaveBeenCalledWith(
        'v1',
        expect.stringContaining('[HAS_RETURNS]'),
      );
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

    describe('por código del servidor (SPEC 49)', () => {
      async function flushBulkWith(result: Record<string, unknown>): Promise<void> {
        rejectWith('');
        await flushMicrotasks();
        http.expectOne(`${SALES_URL}/bulk`).flush({ data: [{ ok: false, ...result }] });
        await flushMicrotasks();
      }

      it('retryable: queda pendiente, sin pushError ni conciliación', async () => {
        await flushBulkWith({ code: 'INTERNAL', error: 'Error interno', retryable: true });

        http.expectNone(`${SALES_URL}/unreconciled`);
        expect(sales.markPushFailed).not.toHaveBeenCalled();
        expect(sales.markUnreconciled).not.toHaveBeenCalled();
        expect(sales.markSynced).not.toHaveBeenCalled();
      });

      it('DEFERRED no cuenta como rechazo', async () => {
        await flushBulkWith({ code: 'DEFERRED', error: 'Lote diferido', retryable: true });

        expect(sales.markPushFailed).not.toHaveBeenCalled();
      });

      it.each(['STOCK_INSUFFICIENT', 'BATCH_EXPIRED', 'PRODUCT_INACTIVE'])(
        '%s ya no va a conciliación: se bloquea visible (SPEC 52)',
        async (code) => {
          await flushBulkWith({ code, error: 'Faltan 2 piezas', retryable: false });

          // `unreconciledSales` no descuenta ninguna partida: mandarla ahí inflaba
          // el inventario de todas las cajas.
          http.expectNone(`${SALES_URL}/unreconciled`);
          expect(sales.markUnreconciled).not.toHaveBeenCalled();
          expect(sales.markPushFailed).toHaveBeenCalledWith('local-1', `Faltan 2 piezas [${code}]`);
        },
      );

      it('PRODUCT_NOT_FOUND va a conciliación aunque el texto no coincida', async () => {
        await flushBulkWith({
          code: 'PRODUCT_NOT_FOUND',
          error: 'Producto abc123 no encontrado',
          retryable: false,
        });

        http.expectOne(`${SALES_URL}/unreconciled`).flush({ data: {} });
        await flushMicrotasks();
        expect(sales.markUnreconciled).toHaveBeenCalled();
      });

      it('SESSION_CLOSED se bloquea visible con su código, no se concilia sola', async () => {
        await flushBulkWith({
          code: 'SESSION_CLOSED',
          error: 'El turno de caja ya está cerrado',
          retryable: false,
        });

        http.expectNone(`${SALES_URL}/unreconciled`);
        expect(sales.markPushFailed).toHaveBeenCalledWith(
          'local-1',
          'El turno de caja ya está cerrado [SESSION_CLOSED]',
        );
      });

      it('VALIDATION se bloquea visible aunque el texto hable de stock', async () => {
        await flushBulkWith({ code: 'VALIDATION', error: 'stock: debe ser número', retryable: false });

        http.expectNone(`${SALES_URL}/unreconciled`);
        expect(sales.markPushFailed).toHaveBeenCalledWith('local-1', 'stock: debe ser número [VALIDATION]');
      });

      it('backend viejo con código HTTP (BAD_REQUEST): decide el texto, como antes', async () => {
        await flushBulkWith({ code: 'BAD_REQUEST', error: 'Stock insuficiente para CORIVER' });

        http.expectOne(`${SALES_URL}/unreconciled`).flush({ data: {} });
        await flushMicrotasks();
        expect(sales.markUnreconciled).toHaveBeenCalledWith('local-1', 'Stock insuficiente para CORIVER');
      });

      it('un INTERNAL en la petición entera no biseca ni marca', async () => {
        sales.getPendingPush.mockResolvedValue([
          localSale({ id: 'local-1', payload: { idempotencyKey: 'key-1' } }),
          localSale({ id: 'local-2', payload: { idempotencyKey: 'key-2' } }),
        ]);
        service.flushQueue();
        await flushMicrotasks();

        http.expectOne(`${SALES_URL}/bulk`).flush(
          {
            error: {
              code: 'CONFLICT',
              message: 'Contención',
              details: { code: 'INTERNAL', retryable: true },
            },
          },
          { status: 409, statusText: 'Conflict' },
        );
        await flushMicrotasks();

        http.expectNone(`${SALES_URL}/bulk`);
        expect(sales.markPushFailed).not.toHaveBeenCalled();
      });
    });

    describe('deviceId en la conciliación (SPEC 53)', () => {
      it('manda el id del equipo para que el servidor arme `<deviceId>:<localId>`', async () => {
        vi.mocked(window.electronAPI!.getDeviceInfo).mockResolvedValue({
          id: 'caja-1-a1b2c3',
          hostname: 'caja-1',
        });
        await flushBulkWithProductNotFound();

        const request = http.expectOne(`${SALES_URL}/unreconciled`);
        expect(request.request.body).toMatchObject({ localId: 'local-1', deviceId: 'caja-1-a1b2c3' });
        request.flush({ data: {} });
        await flushMicrotasks();
        expect(sales.markUnreconciled).toHaveBeenCalled();
      });

      it('sin id del equipo no manda deviceId: el servidor usa al cajero', async () => {
        vi.mocked(window.electronAPI!.getDeviceInfo).mockRejectedValue(new Error('sin IPC'));
        await flushBulkWithProductNotFound();

        const request = http.expectOne(`${SALES_URL}/unreconciled`);
        expect(request.request.body).not.toHaveProperty('deviceId');
        request.flush({ data: {} });
        await flushMicrotasks();
      });

      it('"Mandar a conciliación" del panel también lo manda', async () => {
        vi.mocked(window.electronAPI!.getDeviceInfo).mockResolvedValue({ id: 'caja-2' });
        (sales as Record<string, unknown>)['prepareUnreconciled'] = vi.fn().mockResolvedValue({
          ...localSale({ id: 'local-9' }),
          unreconciledAt: null,
          payload: { items: [] },
        });

        const enviado = service.sendToUnreconciled('local-9', 'Turno rechazado');
        await flushMicrotasks();
        const request = http.expectOne(`${SALES_URL}/unreconciled`);
        expect(request.request.body).toMatchObject({ localId: 'local-9', deviceId: 'caja-2' });
        request.flush({ data: {} });
        await enviado;
        expect(sales.markUnreconciled).toHaveBeenCalledWith('local-9', 'Turno rechazado');
      });

      async function flushBulkWithProductNotFound(): Promise<void> {
        rejectWith('');
        await flushMicrotasks();
        http.expectOne(`${SALES_URL}/bulk`).flush({
          data: [{ ok: false, code: 'PRODUCT_NOT_FOUND', error: 'Producto no encontrado', retryable: false }],
        });
        await flushMicrotasks();
      }
    });

    describe('venta aceptada con marcas de revisión (SPEC 52)', () => {
      it('faltante de stock: se marca subida con su marca y nunca va a conciliación', async () => {
        rejectWith('');
        await flushMicrotasks();
        const stockReview = {
          items: [{ productId: 'r-1', requested: 5, allocated: 3, shortfall: 2 }],
        };
        http.expectOne(`${SALES_URL}/bulk`).flush({
          data: [{ ok: true, sale: { id: 'remote-1', folio: 'V-000010', stockReview } }],
        });
        await flushMicrotasks();

        expect(sales.markSynced).toHaveBeenCalledWith('local-1', 'remote-1', 'V-000010', {
          stock: stockReview,
          catalog: null,
          late: false,
        });
        http.expectNone(`${SALES_URL}/unreconciled`);
        expect(sales.markUnreconciled).not.toHaveBeenCalled();
        expect(sales.markPushFailed).not.toHaveBeenCalled();
      });

      it('turno cerrado y catálogo inactivo: subida con las dos marcas', async () => {
        rejectWith('');
        await flushMicrotasks();
        http.expectOne(`${SALES_URL}/bulk`).flush({
          data: [
            {
              ok: true,
              sale: {
                id: 'remote-1',
                folio: 'V-000011',
                lateSync: true,
                catalogReview: { inactive: ['r-9'] },
                stockReview: null,
              },
            },
          ],
        });
        await flushMicrotasks();

        expect(sales.markSynced).toHaveBeenCalledWith('local-1', 'remote-1', 'V-000011', {
          stock: null,
          catalog: { inactive: ['r-9'] },
          late: true,
        });
        expect(sales.markPushFailed).not.toHaveBeenCalled();
      });

      it('sin marcas se marca subida como siempre', async () => {
        rejectWith('');
        await flushMicrotasks();
        http.expectOne(`${SALES_URL}/bulk`).flush({
          data: [{ ok: true, sale: { id: 'remote-1', folio: 'V-000012', lateSync: false } }],
        });
        await flushMicrotasks();

        expect(sales.markSynced).toHaveBeenCalledWith('local-1', 'remote-1', 'V-000012');
      });
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
          voidReason: 'Cliente desistió',
        },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      // Sin esto el backend no se entera de que esa venta ocurrió, y el libro de
      // control se queda sin el asiento ni su reversa.
      // Por `/sales/bulk`: la ruta en línea rechaza una promo que cerró entre
      // el cobro sin red y el sync, y la venta quedaba atorada para siempre.
      const created = http.expectOne(`${SALES_URL}/bulk`);
      expect(created.request.body).toEqual({ items: [{ idempotencyKey: 'key-9' }] });
      created.flush({ data: [{ ok: true, sale: { id: 'remote-9', folio: 'V-9' } }] });
      await flushMicrotasks();

      const voided = http.expectOne(`${SALES_URL}/remote-9/void`);
      expect(voided.request.body).toEqual({
        reason: 'Cliente desistió',
        voidedAt: '2026-09-03T18:20:00.000Z',
        voidedBy: 'u9',
      });
      voided.flush({ data: {} });
      await flushMicrotasks();

      expect(sales.markSynced).toHaveBeenCalledWith('local-9', 'remote-9', 'V-9');
      expect(sales.markRemoteVoided).toHaveBeenCalledWith('local-9');
    });

    it('si el servidor la rechaza, queda marcada con el motivo y no se anula', async () => {
      sales.getPendingVoided.mockResolvedValue([
        { ...localSale({ id: 'local-8', payload: { idempotencyKey: 'key-8' } }), voidedAt: null, voidedBy: null },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      http
        .expectOne(`${SALES_URL}/bulk`)
        .flush({ data: [{ ok: false, error: 'Stock insuficiente para Paracetamol' }] });
      await flushMicrotasks();

      http.expectNone(`${SALES_URL}/undefined/void`);
      expect(sales.markPushFailed).toHaveBeenCalledWith('local-8', 'Stock insuficiente para Paracetamol');
      expect(sales.markRemoteVoided).not.toHaveBeenCalled();
    });

    it('un rechazo retryable la deja como estaba, sin pushError (SPEC 49)', async () => {
      sales.getPendingVoided.mockResolvedValue([
        { ...localSale({ id: 'local-8', payload: { idempotencyKey: 'key-8' } }), voidedAt: null, voidedBy: null },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      http
        .expectOne(`${SALES_URL}/bulk`)
        .flush({ data: [{ ok: false, code: 'INTERNAL', error: 'Error interno', retryable: true }] });
      await flushMicrotasks();

      expect(sales.markPushFailed).not.toHaveBeenCalled();
      expect(sales.markRemoteVoided).not.toHaveBeenCalled();
    });

    it('creada y ya anulada allá (ALREADY_VOIDED): se da por sincronizada y anulada', async () => {
      sales.getPendingVoided.mockResolvedValue([
        { ...localSale({ id: 'local-7', payload: { idempotencyKey: 'key-7' } }), voidedAt: null, voidedBy: null },
      ]);

      service.flushQueue();
      await flushMicrotasks();

      http
        .expectOne(`${SALES_URL}/bulk`)
        .flush({ data: [{ ok: true, sale: { id: 'remote-7', folio: 'V-7' } }] });
      await flushMicrotasks();
      http.expectOne(`${SALES_URL}/remote-7/void`).flush(
        { error: { code: 'BAD_REQUEST', message: 'x', details: { code: 'ALREADY_VOIDED', retryable: false } } },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      expect(sales.markSynced).toHaveBeenCalledWith('local-7', 'remote-7', 'V-7');
      expect(sales.markRemoteVoided).toHaveBeenCalledWith('local-7');
      expect(sales.markPushFailed).not.toHaveBeenCalled();
    });
  });

  describe('alta OK y anulación fallida (SPEC 62)', () => {
    function anuladaSinSubir(): void {
      sales.getPendingVoided.mockResolvedValue([
        {
          ...localSale({ id: 'local-5', payload: { idempotencyKey: 'key-5' } }),
          voidedAt: '2026-09-03T18:20:00.000Z',
          voidedBy: 'u1',
          voidReason: 'Cliente desistió',
        },
      ]);
    }

    it('el void falla por red: queda subida (markSynced) y pendiente de anular, sin pushError', async () => {
      anuladaSinSubir();

      service.flushQueue();
      await flushMicrotasks();
      http
        .expectOne(`${SALES_URL}/bulk`)
        .flush({ data: [{ ok: true, sale: { id: 'remote-5', folio: 'V-5' } }] });
      await flushMicrotasks();
      // `markSynced` sobre la venta anulada guarda el remoteId y la deja
      // `needsRemoteVoid` (electron/db/sales.js): ya no se descarta por error.
      expect(sales.markSynced).toHaveBeenCalledWith('local-5', 'remote-5', 'V-5');

      sales.getNeedingRemoteVoid.mockResolvedValue([]);
      http
        .expectOne(`${SALES_URL}/remote-5/void`)
        .error(new ProgressEvent('error'), { status: 0, statusText: '' });
      await flushMicrotasks();

      expect(sales.markPushFailed).not.toHaveBeenCalled();
      expect(sales.markVoidFailed).not.toHaveBeenCalled();
      expect(sales.markRemoteVoided).not.toHaveBeenCalled();
    });

    it('el void falla con 5xx: igual, sigue en cola sin ruido', async () => {
      anuladaSinSubir();

      service.flushQueue();
      await flushMicrotasks();
      http
        .expectOne(`${SALES_URL}/bulk`)
        .flush({ data: [{ ok: true, sale: { id: 'remote-5', folio: 'V-5' } }] });
      await flushMicrotasks();
      http
        .expectOne(`${SALES_URL}/remote-5/void`)
        .flush({ error: { message: 'Error interno' } }, { status: 503, statusText: 'Unavailable' });
      await flushMicrotasks();

      expect(sales.markSynced).toHaveBeenCalledWith('local-5', 'remote-5', 'V-5');
      expect(sales.markPushFailed).not.toHaveBeenCalled();
      expect(sales.markVoidFailed).not.toHaveBeenCalled();
    });

    it('el void falla con 4xx: queda subida y con voidError visible', async () => {
      anuladaSinSubir();

      service.flushQueue();
      await flushMicrotasks();
      http
        .expectOne(`${SALES_URL}/bulk`)
        .flush({ data: [{ ok: true, sale: { id: 'remote-5', folio: 'V-5' } }] });
      await flushMicrotasks();
      http.expectOne(`${SALES_URL}/remote-5/void`).flush(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Solo un administrador puede anular una venta de un turno cerrado',
            details: { code: 'VOID_FORBIDDEN', retryable: false },
          },
        },
        { status: 403, statusText: 'Forbidden' },
      );
      await flushMicrotasks();

      expect(sales.markSynced).toHaveBeenCalledWith('local-5', 'remote-5', 'V-5');
      expect(sales.markPushFailed).not.toHaveBeenCalled();
      expect(sales.markVoidFailed).toHaveBeenCalledWith(
        'local-5',
        expect.stringContaining('[VOID_FORBIDDEN]'),
      );
    });
  });

  describe('anulación remota pendiente (SPEC 62)', () => {
    beforeEach(() => {
      sales.getNeedingRemoteVoid.mockResolvedValue([
        { id: 'v1', remoteId: 'remote-1', voidedAt: null, voidedBy: null, voidReason: 'Error de captura' },
      ]);
    });

    it('viaja con su motivo', async () => {
      service.flushQueue();
      await flushMicrotasks();

      const request = http.expectOne(`${SALES_URL}/remote-1/void`);
      expect(request.request.body).toEqual({ reason: 'Error de captura' });
      request.flush({ data: {} });
      await flushMicrotasks();
    });

    it('un 4xx VOID_FORBIDDEN queda en Rechazados y deja de reintentarse en silencio', async () => {
      service.flushQueue();
      await flushMicrotasks();
      http.expectOne(`${SALES_URL}/remote-1/void`).flush(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Solo un administrador puede anular esta venta',
            details: { code: 'VOID_FORBIDDEN', retryable: false },
          },
        },
        { status: 403, statusText: 'Forbidden' },
      );
      await flushMicrotasks();

      // `markVoidFailed` pone `voidError`: `getNeedingRemoteVoid` ya no la
      // devuelve (electron/db/sales.js) y `listBlocked` la pinta en el panel.
      expect(sales.markVoidFailed).toHaveBeenCalledWith(
        'v1',
        'Solo un administrador puede anular esta venta [VOID_FORBIDDEN]',
      );
      expect(sales.markRemoteVoided).not.toHaveBeenCalled();
    });

    it('un 4xx sin código (backend viejo) tampoco se reintenta en silencio', async () => {
      service.flushQueue();
      await flushMicrotasks();
      http
        .expectOne(`${SALES_URL}/remote-1/void`)
        .flush({ error: { message: 'Turno de otro cajero' } }, { status: 403, statusText: 'Forbidden' });
      await flushMicrotasks();

      expect(sales.markVoidFailed).toHaveBeenCalledWith('v1', expect.stringContaining('Turno de otro cajero'));
    });

    it('red o 5xx: sigue en cola, sin voidError', async () => {
      service.flushQueue();
      await flushMicrotasks();
      http
        .expectOne(`${SALES_URL}/remote-1/void`)
        .flush({ error: { message: 'Error interno' } }, { status: 500, statusText: 'Error' });
      await flushMicrotasks();

      expect(sales.markVoidFailed).not.toHaveBeenCalled();
      expect(sales.markRemoteVoided).not.toHaveBeenCalled();
    });
  });

  describe('void sin motivo (SPEC 62)', () => {
    it('no anula ni llama al servidor', () => {
      let failed: unknown;
      service.void(localSale(), '  ab ').subscribe({ error: (error) => (failed = error) });

      expect(failed).toBeInstanceOf(Error);
      expect(sales.voidLocal).not.toHaveBeenCalled();
      http.expectNone(`${SALES_URL}/local-1/void`);
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

    /**
     * Un 4xx que afecta de verdad a las dos: al bisecar, cada mitad de una venta
     * vuelve a fallar y ambas acaban marcadas, igual que antes.
     */
    it('un 4xx del lote entero deja las ventas bloqueadas con el motivo', async () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'local-1', payload: { idempotencyKey: 'key-1' } }),
        localSale({ id: 'local-2', payload: { idempotencyKey: 'key-2' } }),
      ]);

      service.flushQueue();
      await flushMicrotasks();

      const rechazar = () =>
        http.expectOne(BULK_URL).flush(
          { error: { message: 'Turno de caja no encontrado' } },
          { status: 400, statusText: 'Bad Request' },
        );

      // Lote completo, y luego cada mitad al bisecar.
      rechazar();
      await flushMicrotasks();
      rechazar();
      await flushMicrotasks();
      rechazar();
      await flushMicrotasks();

      expect(sales.markPushFailed).toHaveBeenCalledWith('local-1', 'Turno de caja no encontrado');
      expect(sales.markPushFailed).toHaveBeenCalledWith('local-2', 'Turno de caja no encontrado');
    });

    /**
     * Lo que motivó la bisección: `POST /sales/bulk` valida el arreglo entero, así
     * que una sola venta mal formada tumbaba el lote y arrastraba a las buenas —
     * dinero cobrado que quedaba bloqueado sin haber hecho nada mal.
     */
    it('una venta mal formada no arrastra a las buenas: se aísla bisecando', async () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'buena-1', payload: { idempotencyKey: 'k1' } }),
        localSale({ id: 'mala', payload: { idempotencyKey: 'k2' } }),
      ]);

      service.flushQueue();
      await flushMicrotasks();

      // El lote de 2 falla por culpa de "mala".
      http.expectOne(BULK_URL).flush(
        { error: { message: 'El monto debe tener máximo 2 decimales' } },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      // Primera mitad (la buena): pasa.
      http.expectOne(BULK_URL).flush({ data: [{ ok: true, sale: { id: 'remote-1', folio: 'V-1' } }] });
      await flushMicrotasks();

      // Segunda mitad (la culpable): vuelve a fallar y solo ella se marca.
      http.expectOne(BULK_URL).flush(
        { error: { message: 'El monto debe tener máximo 2 decimales' } },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      expect(sales.markSynced).toHaveBeenCalledWith('buena-1', 'remote-1', 'V-1');
      expect(sales.markPushFailed).toHaveBeenCalledWith(
        'mala',
        'El monto debe tener máximo 2 decimales',
      );
      expect(sales.markPushFailed).not.toHaveBeenCalledWith('buena-1', expect.anything());
    });

    /**
     * Un 404/403 es del despliegue o del permiso, no de una venta: marcarlas
     * rechazadas sacaba de la cola ventas ya cobradas hasta intervención manual.
     */
    it.each([403, 404])('un %i del lote no marca las ventas como rechazadas: siguen en cola', async (status) => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'a', payload: { idempotencyKey: 'k1' } }),
        localSale({ id: 'b', payload: { idempotencyKey: 'k2' } }),
      ]);

      service.flushQueue();
      await flushMicrotasks();
      http.expectOne(BULK_URL).flush({ error: { message: 'no' } }, { status, statusText: 'Error' });
      await flushMicrotasks();

      http.expectNone(BULK_URL);
      expect(sales.markPushFailed).not.toHaveBeenCalled();
    });

    /**
     * El empuje en vuelo leyó la cola al arrancar: lo capturado después no entra
     * en esa pasada, así que debe haber una pasada de seguimiento (una sola).
     */
    it('un flushQueue con otro empuje en vuelo encola una pasada de seguimiento', async () => {
      sales.getPendingPush.mockResolvedValue([localSale({ id: 'a', payload: { idempotencyKey: 'k1' } })]);
      const respuesta = { data: [{ ok: true, sale: { id: 'remote-a', folio: 'V-A' } }] };

      service.flushQueue();
      await flushMicrotasks();
      const primero = http.expectOne(BULK_URL);

      // Dos peticiones durante el vuelo se funden en una sola pasada de seguimiento.
      service.flushQueue();
      service.flushQueue();
      primero.flush(respuesta);
      await flushMicrotasks();

      const seguimiento = http.expectOne(BULK_URL);
      seguimiento.flush(respuesta);
      await flushMicrotasks();
      http.expectNone(BULK_URL);
    });

    /**
     * El backend rechaza el arreglo completo si pasa de 50
     * (`bulkCreateSalesSchema`, SPEC 48). Un fin de semana sin red con 210 ventas
     * en cola devolvía 400 y las condenaba todas — y reintentar volvía a mandar las 210.
     */
    it('trocea la cola: 210 ventas se mandan en peticiones de 50 como máximo (SPEC 48)', async () => {
      sales.getPendingPush.mockResolvedValue(
        Array.from({ length: 210 }, (_, indice) =>
          localSale({ id: `local-${indice}`, payload: { idempotencyKey: `key-${indice}` } }),
        ),
      );

      service.flushQueue();
      await flushMicrotasks();

      const tamanos: number[] = [];
      for (let peticion = 0; peticion < 5; peticion += 1) {
        const req = http.expectOne(BULK_URL);
        const items = (req.request.body as { items: unknown[] }).items;
        tamanos.push(items.length);
        req.flush({
          data: items.map((_, indice) => ({
            ok: true,
            sale: { id: `remote-${peticion}-${indice}`, folio: `V-${peticion}-${indice}` },
          })),
        });
        await flushMicrotasks();
      }

      expect(tamanos).toEqual([50, 50, 50, 50, 10]);
      expect(BULK_MAX_ITEMS).toBe(50);
      expect(sales.markSynced).toHaveBeenCalledTimes(210);
    });

    it('manda el soldBy que trae el payload de la caja, tal cual (SPEC 54)', async () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'a', payload: { idempotencyKey: 'k1', soldBy: 'uid-cajera-a' } }),
      ]);

      service.flushQueue();
      await flushMicrotasks();
      const req = http.expectOne(BULK_URL);
      expect((req.request.body as { items: Array<{ soldBy?: string }> }).items[0].soldBy).toBe(
        'uid-cajera-a',
      );
      req.flush({ data: [{ ok: true, sale: { id: 'r-a', folio: 'V-A' } }] });
      await flushMicrotasks();
    });

    describe('lote tolerante (SPEC 48)', () => {
      it('DEFERRED queda pendiente: sin pushError, sin conciliación y sin contar intento', async () => {
        sales.getPendingPush.mockResolvedValue([
          localSale({ id: 'a', payload: { idempotencyKey: 'k1' } }),
          localSale({ id: 'b', payload: { idempotencyKey: 'k2' } }),
        ]);
        const antes = service.deferredCount();

        service.flushQueue();
        await flushMicrotasks();
        http.expectOne(BULK_URL).flush({
          data: [
            { ok: true, sale: { id: 'remote-a', folio: 'V-A' } },
            { ok: false, code: 'DEFERRED', error: 'Se reintentará', retryable: true },
          ],
        });
        await flushMicrotasks();

        expect(sales.markSynced).toHaveBeenCalledWith('a', 'remote-a', 'V-A');
        expect(sales.markSynced).not.toHaveBeenCalledWith('b', expect.anything(), expect.anything());
        expect(sales.markPushFailed).not.toHaveBeenCalled();
        expect(sales.markUnreconciled).not.toHaveBeenCalled();
        http.expectNone(`${SALES_URL}/unreconciled`);
        // El envío automático lo lee para no contar el intento como fallido.
        expect(service.deferredCount()).toBe(antes + 1);
      });

      it('DEFERRED sin la marca retryable tampoco bloquea', async () => {
        sales.getPendingPush.mockResolvedValue([localSale({ id: 'a', payload: { idempotencyKey: 'k1' } })]);

        service.flushQueue();
        await flushMicrotasks();
        http.expectOne(BULK_URL).flush({ data: [{ ok: false, code: 'DEFERRED', error: 'x' }] });
        await flushMicrotasks();

        expect(sales.markPushFailed).not.toHaveBeenCalled();
        expect(service.deferredCount()).toBe(1);
      });

      it('tras un trozo diferido, los trozos siguientes esperan al próximo envío (orden de folios)', async () => {
        sales.getPendingPush.mockResolvedValue(
          Array.from({ length: 60 }, (_, indice) =>
            localSale({ id: `local-${indice}`, payload: { idempotencyKey: `key-${indice}` } }),
          ),
        );

        service.flushQueue();
        await flushMicrotasks();
        const primero = http.expectOne(BULK_URL);
        const items = (primero.request.body as { items: unknown[] }).items;
        expect(items).toHaveLength(50);
        primero.flush({
          data: items.map((_, indice) =>
            indice < 40
              ? { ok: true, sale: { id: `r-${indice}`, folio: `V-${indice}` } }
              : { ok: false, code: 'DEFERRED', error: 'Se reintentará', retryable: true },
          ),
        });
        await flushMicrotasks();

        http.expectNone(BULK_URL);
        expect(sales.markSynced).toHaveBeenCalledTimes(40);
        expect(sales.markPushFailed).not.toHaveBeenCalled();
      });

      it('VALIDATION por índice se bloquea visible con el mensaje del servidor; las demás suben', async () => {
        sales.getPendingPush.mockResolvedValue([
          localSale({ id: 'uno', payload: { idempotencyKey: 'k1' } }),
          localSale({ id: 'dos', payload: { idempotencyKey: 'k2' } }),
          localSale({ id: 'tres', payload: { idempotencyKey: 'k3' } }),
        ]);

        service.flushQueue();
        await flushMicrotasks();
        http.expectOne(BULK_URL).flush({
          data: [
            { ok: true, sale: { id: 'r1', folio: 'V-1' } },
            {
              ok: false,
              code: 'VALIDATION',
              error: 'items.0.quantity: debe ser mayor a 0',
              retryable: false,
            },
            { ok: true, sale: { id: 'r3', folio: 'V-3' } },
          ],
        });
        await flushMicrotasks();

        // Sin bisección: el lote nuevo ya separa la venta mala por índice.
        http.expectNone(BULK_URL);
        expect(sales.markSynced).toHaveBeenCalledWith('uno', 'r1', 'V-1');
        expect(sales.markSynced).toHaveBeenCalledWith('tres', 'r3', 'V-3');
        expect(sales.markPushFailed).toHaveBeenCalledWith(
          'dos',
          'items.0.quantity: debe ser mayor a 0 [VALIDATION]',
        );
        http.expectNone(`${SALES_URL}/unreconciled`);
      });
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

    /**
     * Las que esperan a su turno llegan sin `payload` a las lecturas de la UI
     * (QA-14). Si por un descuido el push recibiera una, mandarla sería un 400
     * seguro que la condena por algo que se resuelve solo en el sync siguiente.
     */
    it('no manda una venta sin payload aunque venga en la cola', () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'esperando', payload: null }),
      ]);
      service.flushQueue();
      http.expectNone(BULK_URL);
    });
  });

  describe('ventas que todavía no se pueden enviar (QA-14)', () => {
    it('las publica como pendientes, con el motivo de la espera', async () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'esperando', total: 25, payload: null, esperandoPor: 'turno' }),
      ]);

      // El refresco corre en el constructor: se instancia con la cola ya puesta.
      const recien = TestBed.runInInjectionContext(() => new SaleService());
      await flushMicrotasks();

      // Antes se omitían: la cajera no veía nada y el conteo del corte mentía.
      expect(recien.pendingSales()).toEqual([
        {
          queueId: 'esperando',
          folioHint: '0 art. · $25.00',
          total: 25,
          waitingFor: 'Espera a que suba el turno',
        },
      ]);
      expect(recien.pendingCount()).toBe(1);
    });

    it('una venta lista para enviar no lleva motivo de espera', async () => {
      sales.getPendingPush.mockResolvedValue([
        localSale({ id: 'lista', total: 40, payload: { idempotencyKey: 'k' } }),
      ]);

      const recien = TestBed.runInInjectionContext(() => new SaleService());
      await flushMicrotasks();

      expect(recien.pendingSales()[0].waitingFor).toBeNull();
    });
  });

  describe('descarte con motivo (SPEC 62)', () => {
    it('sin motivo no llega a la caja', async () => {
      await expect(service.discardSale('local-1', ' ok ')).rejects.toThrow(/motivo/);
      expect(sales.discard).not.toHaveBeenCalled();
    });

    it('descarta con autor y motivo y deja rastro en el servidor como no conciliada', async () => {
      sales.discard.mockResolvedValue(localSale({ id: 'local-1' }));
      (sales as Record<string, unknown>)['prepareUnreconciled'] = vi.fn().mockResolvedValue({
        ...localSale({ id: 'local-1' }),
        unreconciledAt: null,
        payload: { items: [] },
      });

      const hecho = service.discardSale('local-1', 'Venta de prueba');
      await flushMicrotasks();
      const request = http.expectOne(`${SALES_URL}/unreconciled`);
      expect(request.request.body).toMatchObject({
        localId: 'local-1',
        reason: 'descartada: Venta de prueba',
      });
      request.flush({ data: {} });
      await hecho;

      expect(sales.discard).toHaveBeenCalledWith('local-1', { discardedBy: 'u1', reason: 'Venta de prueba' });
      // El descarte no es una conciliación: la venta no se marca como tal.
      expect(sales.markUnreconciled).not.toHaveBeenCalled();
    });

    it('el aviso al servidor es best-effort: sin red el descarte igual queda', async () => {
      sales.discard.mockResolvedValue(localSale({ id: 'local-1' }));
      (sales as Record<string, unknown>)['prepareUnreconciled'] = vi.fn().mockResolvedValue({
        ...localSale({ id: 'local-1' }),
        unreconciledAt: null,
        payload: { items: [] },
      });

      const hecho = service.discardSale('local-1', 'Venta de prueba');
      await flushMicrotasks();
      http
        .expectOne(`${SALES_URL}/unreconciled`)
        .error(new ProgressEvent('error'), { status: 0, statusText: '' });

      await expect(hecho).resolves.toBeUndefined();
    });

    it('si la caja lo rechaza (ya está en el servidor) el error llega al llamador', async () => {
      sales.discard.mockRejectedValue(new Error('Ya está en el servidor; anúlala.'));

      await expect(service.discardSale('local-1', 'Venta de prueba')).rejects.toThrow(
        'Ya está en el servidor; anúlala.',
      );
      http.expectNone(`${SALES_URL}/unreconciled`);
    });
  });
});

/** El flujo encadena promesas de IPC entre cada paso observable. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
