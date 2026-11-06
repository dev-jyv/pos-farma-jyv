import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import { PurchaseInvoice } from '../../../shared/models';
import { MessageService } from 'primeng/api';

import {
  ENTRY_IN_PROGRESS_BACKOFF_MS,
  StockEntryService,
  stockEntryWarnings,
} from './stock-entry.service';

const BASE = `${environment.apiUrl}/stock-entries`;

describe('StockEntryService', () => {
  let service: StockEntryService;
  let http: HttpTestingController;
  let recordStockEntry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recordStockEntry = vi.fn().mockResolvedValue({ product: { id: 'p1' }, stock: 0 });
    window.electronAPI = {
      getAppVersion: vi.fn(),
      getDeviceInfo: vi.fn(),
      openCashDrawer: vi.fn(),
      catalog: {
        search: vi.fn(),
        getByBarcode: vi.fn(),
        recordStockEntry,
        upsertMany: vi.fn(),
        getPendingStockEntries: vi.fn(),
        markStockEntrySynced: vi.fn(),
        markStockEntryPushFailed: vi.fn(),
      },
      sales: {
        createLocal: vi.fn(),
        list: vi.fn(),
        getPendingPush: vi.fn(),
        markSynced: vi.fn(),
        markPushFailed: vi.fn(),
        voidLocal: vi.fn(),
        clearPushError: vi.fn(),
        discard: vi.fn(),
      },
      sync: { getStatus: vi.fn(), recordRun: vi.fn() },
    } as unknown as Window['electronAPI'];

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(StockEntryService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('facturas recientes', () => {
    it('pide diez por defecto', () => {
      service.listRecentInvoices().subscribe();

      const request = http.expectOne((req) => req.url === `${BASE}/invoices`);
      expect(request.request.params.get('limit')).toBe('10');
      request.flush({ data: [] });
    });

    it('normaliza la fecha y aplana el proveedor', () => {
      let invoices: PurchaseInvoice[] = [];
      service.listRecentInvoices().subscribe((result) => (invoices = result));

      http.expectOne((req) => req.url === `${BASE}/invoices`).flush({
        data: [
          {
            id: 'inv-1',
            invoiceNumber: 'FAC-123',
            invoiceDate: '2026-08-20T00:00:00.000Z',
            supplierId: 's1',
            supplier: { id: 's1', name: 'Distribuidora Norte' },
            totalAmount: 4500,
            hasInvoice: true,
          },
        ],
      });

      expect(invoices[0].invoiceDate.toISOString()).toBe('2026-08-20T00:00:00.000Z');
      expect(invoices[0].supplierName).toBe('Distribuidora Norte');
    });

    it('una factura sin comprobante fiscal se marca como tal', () => {
      let invoices: PurchaseInvoice[] = [];
      service.listRecentInvoices().subscribe((result) => (invoices = result));

      http.expectOne((req) => req.url === `${BASE}/invoices`).flush({
        data: [{ id: 'inv-2', invoiceNumber: 'REM-9', invoiceDate: 1_775_000_000_000, hasInvoice: false }],
      });

      expect(invoices[0].hasInvoice).toBe(false);
      expect(invoices[0].supplierName).toBe('');
    });
  });

  describe('registrar la entrada', () => {
    it('escribe local de inmediato con el mismo payload que se reenviará', () => {
      const payload = {
        invoiceId: 'inv-1',
        lotNumber: 'L-1',
        expiryDate: '2027-01-31',
        quantity: 24,
        productId: 'p1',
      };
      service.create(payload).subscribe();

      expect(recordStockEntry).toHaveBeenCalledWith(payload);
      http.expectNone(BASE);
    });

    it('devuelve el stock resultante que reporta el proceso main', () => {
      recordStockEntry.mockResolvedValue({ product: { id: 'p1' }, stock: 46 });
      let stock = 0;
      service
        .create({ invoiceId: 'inv-1', lotNumber: 'L-1', expiryDate: '2027-01-31', quantity: 10, productId: 'p1' })
        .subscribe((result) => (stock = result.stock));

      return Promise.resolve().then(() => expect(stock).toBe(46));
    });
  });

  describe('envío de entradas: clasificación por código (SPEC 49)', () => {
    let catalog: {
      getPendingStockEntries: ReturnType<typeof vi.fn>;
      markStockEntrySynced: ReturnType<typeof vi.fn>;
      markStockEntryPushFailed: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      catalog = window.electronAPI!.catalog as unknown as typeof catalog;
      catalog.getPendingStockEntries.mockResolvedValue([
        { id: 'b-1', payload: { invoiceId: 'inv-1', lotNumber: 'L-1', quantity: 5, productId: 'p1' } },
      ]);
      catalog.markStockEntrySynced.mockResolvedValue(undefined);
      catalog.markStockEntryPushFailed.mockResolvedValue(undefined);
    });

    async function respond(status: number, body: object): Promise<void> {
      const done = service.flushQueueAsync();
      await flushMicrotasks();
      const request = http.expectOne(BASE);
      expect(request.request.body).toMatchObject({ idempotencyKey: 'b-1' });
      request.flush(body, { status, statusText: 'x' });
      await done;
    }

    it('ENTRY_IN_PROGRESS dentro de la ventana de reserva: queda pendiente, sin pushError', async () => {
      await respond(409, {
        error: {
          code: 'CONFLICT',
          message: 'Esta entrada se está registrando en un intento anterior.',
          details: { code: 'ENTRY_IN_PROGRESS', retryable: true },
        },
      });

      expect(catalog.markStockEntryPushFailed).not.toHaveBeenCalled();
      expect(catalog.markStockEntrySynced).not.toHaveBeenCalled();
    });

    it('INTERNAL con retryable también se queda pendiente', async () => {
      await respond(500, {
        error: { code: 'INTERNAL_ERROR', message: 'Error', details: { code: 'INTERNAL', retryable: true } },
      });

      expect(catalog.markStockEntryPushFailed).not.toHaveBeenCalled();
    });

    it('ENTRY_AMBIGUOUS se bloquea visible con su código', async () => {
      await respond(409, {
        error: {
          code: 'CONFLICT',
          message: 'Esta entrada quedó a medio registrar en un intento anterior.',
          details: { code: 'ENTRY_AMBIGUOUS', retryable: false },
        },
      });

      expect(catalog.markStockEntryPushFailed).toHaveBeenCalledWith(
        'b-1',
        'Esta entrada quedó a medio registrar en un intento anterior. [ENTRY_AMBIGUOUS]',
      );
    });

    it('backend viejo: un 409 sin código se sigue tomando como rechazo permanente', async () => {
      await respond(409, { error: { code: 'CONFLICT', message: 'quedó a medio registrar' } });

      expect(catalog.markStockEntryPushFailed).toHaveBeenCalledWith('b-1', 'quedó a medio registrar');
    });

    it('backend viejo: un 5xx sin código se reintenta', async () => {
      await respond(503, { error: { message: 'Unavailable' } });

      expect(catalog.markStockEntryPushFailed).not.toHaveBeenCalled();
    });
  });
});

describe('StockEntryService — autor y espera de las entradas (SPEC 54, SPEC 55)', () => {
  let service: StockEntryService;
  let http: HttpTestingController;
  let catalog: {
    getPendingStockEntries: ReturnType<typeof vi.fn>;
    markStockEntrySynced: ReturnType<typeof vi.fn>;
    markStockEntryPushFailed: ReturnType<typeof vi.fn>;
  };
  let getDeviceInfo: ReturnType<typeof vi.fn>;

  const EN_CURSO = {
    error: {
      code: 'CONFLICT',
      message: 'Esta entrada se está registrando en un intento anterior.',
      details: { code: 'ENTRY_IN_PROGRESS', retryable: true },
    },
  };

  beforeEach(() => {
    catalog = {
      getPendingStockEntries: vi.fn().mockResolvedValue([
        { id: 'b-1', payload: { invoiceId: 'inv-1', lotNumber: 'L-1', quantity: 5, productId: 'p1' } },
      ]),
      markStockEntrySynced: vi.fn().mockResolvedValue(undefined),
      markStockEntryPushFailed: vi.fn().mockResolvedValue(undefined),
    };
    getDeviceInfo = vi.fn().mockResolvedValue({ id: 'aa:bb:cc:dd:ee:ff', hostname: 'caja-1' });
    window.electronAPI = { getDeviceInfo, catalog } as unknown as Window['electronAPI'];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(StockEntryService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  async function enviar(): Promise<{ body: Record<string, unknown> | null; responder: (status: number, body: object, headers?: Record<string, string>) => Promise<void> }> {
    const done = service.flushQueueAsync();
    await flushMicrotasks();
    const pendientes = http.match(BASE);
    if (!pendientes.length) {
      await done;
      return { body: null, responder: async () => undefined };
    }
    const [request] = pendientes;
    return {
      body: request.request.body as Record<string, unknown>,
      responder: async (status, body, headers) => {
        request.flush(body, { status, statusText: 'x', headers });
        await done;
      },
    };
  }

  it('cada entrada lleva el deviceId del equipo, con la llave estable de siempre', async () => {
    const { body, responder } = await enviar();

    expect(body).toMatchObject({ deviceId: 'aa:bb:cc:dd:ee:ff', idempotencyKey: 'b-1', productId: 'p1' });
    await responder(201, { data: { product: { id: 'p1' }, stock: 5 } });
    expect(catalog.markStockEntrySynced).toHaveBeenCalledWith('b-1', 'p1');
  });

  it('el reenvío de otro cajero desde el mismo equipo manda la misma llave y el mismo deviceId', async () => {
    const primero = await enviar();
    await primero.responder(503, { error: { message: 'Unavailable' } });
    const segundo = await enviar();

    expect(segundo.body).toMatchObject({ deviceId: primero.body!['deviceId'], idempotencyKey: 'b-1' });
    await segundo.responder(201, { data: { product: { id: 'p1' }, stock: 5 } });
    expect(getDeviceInfo).toHaveBeenCalledTimes(1);
  });

  it('preload viejo sin getDeviceInfo: la entrada sale sin deviceId, como antes', async () => {
    (window.electronAPI as unknown as { getDeviceInfo?: unknown }).getDeviceInfo = undefined;
    const { body, responder } = await enviar();

    expect(body).not.toHaveProperty('deviceId');
    await responder(201, { data: { product: { id: 'p1' }, stock: 5 } });
  });

  it('ENTRY_IN_PROGRESS: pendiente sin pushError y no se reenvía hasta que pase la espera', async () => {
    const base = Date.parse('2026-11-06T10:00:00.000Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(base);

    const primero = await enviar();
    await primero.responder(409, EN_CURSO);
    expect(catalog.markStockEntryPushFailed).not.toHaveBeenCalled();

    // Dentro de la espera: el empuje no la manda.
    now.mockReturnValue(base + ENTRY_IN_PROGRESS_BACKOFF_MS[0] - 1);
    expect((await enviar()).body).toBeNull();

    // Pasada la espera sí; un segundo ENTRY_IN_PROGRESS espera el doble.
    now.mockReturnValue(base + ENTRY_IN_PROGRESS_BACKOFF_MS[0]);
    const segundo = await enviar();
    expect(segundo.body).toMatchObject({ idempotencyKey: 'b-1' });
    await segundo.responder(409, EN_CURSO);
    const tras = base + ENTRY_IN_PROGRESS_BACKOFF_MS[0];
    now.mockReturnValue(tras + ENTRY_IN_PROGRESS_BACKOFF_MS[1] - 1);
    expect((await enviar()).body).toBeNull();
    now.mockReturnValue(tras + ENTRY_IN_PROGRESS_BACKOFF_MS[1]);
    const tercero = await enviar();
    await tercero.responder(201, { data: { product: { id: 'p1' }, stock: 5 } });

    expect(catalog.markStockEntrySynced).toHaveBeenCalledWith('b-1', 'p1');
    expect(catalog.markStockEntryPushFailed).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('un Retry-After del servidor manda sobre la tabla', async () => {
    const base = Date.parse('2026-11-06T10:00:00.000Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(base);

    const primero = await enviar();
    await primero.responder(409, EN_CURSO, { 'Retry-After': '5' });

    now.mockReturnValue(base + 4_999);
    expect((await enviar()).body).toBeNull();
    now.mockReturnValue(base + 5_000);
    const segundo = await enviar();
    expect(segundo.body).not.toBeNull();
    await segundo.responder(201, { data: { product: { id: 'p1' }, stock: 5 } });
    now.mockRestore();
  });

  it('ENTRY_AMBIGUOUS sigue siendo un bloqueo visible, sin espera', async () => {
    const { responder } = await enviar();
    await responder(409, {
      error: {
        code: 'CONFLICT',
        message: 'Esta entrada quedó a medio registrar en un intento anterior.',
        details: { code: 'ENTRY_AMBIGUOUS', retryable: false },
      },
    });

    expect(catalog.markStockEntryPushFailed).toHaveBeenCalledWith(
      'b-1',
      'Esta entrada quedó a medio registrar en un intento anterior. [ENTRY_AMBIGUOUS]',
    );
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe('StockEntryService — advertencias del servidor (SPEC 59)', () => {
  let service: StockEntryService;
  let http: HttpTestingController;
  let add: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.electronAPI = {
      getDeviceInfo: vi.fn().mockResolvedValue({ id: 'aa:bb' }),
      catalog: {
        getPendingStockEntries: vi.fn().mockResolvedValue([
          {
            id: 'b-1',
            payload: { invoiceId: 'inv-1', lotNumber: 'ABC12', quantity: 5, productId: 'p1' },
          },
        ]),
        markStockEntrySynced: vi.fn().mockResolvedValue(undefined),
        markStockEntryPushFailed: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Window['electronAPI'];
    add = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: MessageService, useValue: { add } }],
    });
    service = TestBed.inject(StockEntryService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function subirCon(body: object): Promise<void> {
    const done = service.flushQueueAsync();
    await flushMicrotasks();
    http.expectOne(BASE).flush(body, { status: 201, statusText: 'Created' });
    await done;
  }

  it('LOT_EXPIRY_MISMATCH (details.warnings): la entrada queda subida y se avisa al terminar', async () => {
    await subirCon({
      data: { product: { id: 'p1', name: 'Sertralina 50 mg' }, stock: 9, details: { warnings: ['LOT_EXPIRY_MISMATCH'] } },
    });

    expect(window.electronAPI!.catalog.markStockEntrySynced).toHaveBeenCalledWith('b-1', 'p1');
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({
      severity: 'warn',
      detail: 'El lote ABC12 de Sertralina 50 mg ya existía con otra caducidad. Revisa la factura.',
    });
  });

  it('también con `warnings` en la respuesta (forma del contrato)', async () => {
    await subirCon({ data: { product: { id: 'p1', name: 'Sertralina' }, stock: 9, warnings: ['LOT_EXPIRY_MISMATCH'] } });

    expect(add).toHaveBeenCalledTimes(1);
  });

  it('sin advertencias no avisa nada', async () => {
    await subirCon({ data: { product: { id: 'p1', name: 'Sertralina' }, stock: 9 } });

    expect(add).not.toHaveBeenCalled();
  });

  it('stockEntryWarnings lee las dos formas y no repite', () => {
    expect(
      stockEntryWarnings({ data: { warnings: ['LOT_EXPIRY_MISMATCH'], details: { warnings: ['LOT_EXPIRY_MISMATCH'] } } }),
    ).toEqual(['LOT_EXPIRY_MISMATCH']);
    expect(stockEntryWarnings({ details: { warnings: ['X'] } })).toEqual(['X']);
    expect(stockEntryWarnings(null)).toEqual([]);
  });
});
