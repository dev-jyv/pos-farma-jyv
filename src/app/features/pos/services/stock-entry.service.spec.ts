import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import { PurchaseInvoice } from '../../../shared/models';
import { StockEntryService } from './stock-entry.service';

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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
