import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { PurchaseInvoice } from '../../../shared/models';
import { StockEntryService } from './stock-entry.service';

const BASE = `${environment.apiUrl}/stock-entries`;

describe('StockEntryService', () => {
  let service: StockEntryService;
  let http: HttpTestingController;

  beforeEach(() => {
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
    it('manda la partida contra la factura', () => {
      service
        .create({
          invoiceId: 'inv-1',
          lotNumber: 'L-1',
          expiryDate: '2027-01-31',
          quantity: 24,
          productId: 'p1',
        })
        .subscribe();

      const request = http.expectOne(BASE);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        invoiceId: 'inv-1',
        lotNumber: 'L-1',
        expiryDate: '2027-01-31',
        quantity: 24,
        productId: 'p1',
      });
      request.flush({ data: { product: { id: 'p1', name: 'Paracetamol' }, stock: 36 } });
    });

    it('devuelve el stock resultante', () => {
      let stock = 0;
      service
        .create({ invoiceId: 'inv-1', lotNumber: 'L-1', expiryDate: '2027-01-31', quantity: 10, productId: 'p1' })
        .subscribe((result) => (stock = result.stock));

      http.expectOne(BASE).flush({ data: { product: { id: 'p1' }, stock: 46 } });

      expect(stock).toBe(46);
    });
  });
});
