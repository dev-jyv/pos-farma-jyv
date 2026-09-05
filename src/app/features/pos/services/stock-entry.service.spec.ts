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
});
