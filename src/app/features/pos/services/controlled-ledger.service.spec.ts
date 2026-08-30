import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { ControlledLedgerPage, ControlledLedgerService } from './controlled-ledger.service';

const LEDGER_URL = `${environment.apiUrl}/inventory/controlled-ledger`;

describe('ControlledLedgerService', () => {
  let service: ControlledLedgerService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ControlledLedgerService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('omite los filtros vacíos en vez de mandarlos como cadena vacía', () => {
    service.list({ from: '2026-08-01', to: '', group: undefined, page: 2, limit: 50 }).subscribe();

    const request = http.expectOne((req) => req.url === LEDGER_URL);
    expect(request.request.params.get('from')).toBe('2026-08-01');
    expect(request.request.params.has('to')).toBe(false);
    expect(request.request.params.has('group')).toBe(false);
    expect(request.request.params.get('page')).toBe('2');
    expect(request.request.params.get('limit')).toBe('50');
    request.flush({ data: [] });
  });

  it('conserva el meta del servidor para poder detectar truncamiento', () => {
    let page: ControlledLedgerPage | undefined;
    service.list().subscribe((result) => (page = result));

    http.expectOne((req) => req.url === LEDGER_URL).flush({
      data: [],
      meta: { page: 1, limit: 100, total: 240, totalPages: 3 },
    });

    expect(page?.meta).toEqual({ page: 1, limit: 100, total: 240, totalPages: 3 });
  });

  it('deja el grupo en null cuando no es un grupo COFEPRIS válido, sin inventar VI', () => {
    let page: ControlledLedgerPage | undefined;
    service.list().subscribe((result) => (page = result));

    http.expectOne((req) => req.url === LEDGER_URL).flush({
      data: [
        { id: 'e1', controlledGroup: 'ZZ', createdAt: '2026-08-08T10:00:00.000Z' },
        { id: 'e2', controlledGroup: 'II', createdAt: '2026-08-08T11:00:00.000Z' },
      ],
    });

    expect(page?.entries.map((entry) => entry.controlledGroup)).toEqual([null, 'II']);
  });

  it('normaliza lotes y retención ausentes en renglones viejos', () => {
    let page: ControlledLedgerPage | undefined;
    service.list().subscribe((result) => (page = result));

    http.expectOne((req) => req.url === LEDGER_URL).flush({
      data: [{ id: 'e1', controlledGroup: 'I', createdAt: 1_775_000_000_000 }],
    });

    const [entry] = page!.entries;
    expect(entry.lotNumbers).toEqual([]);
    expect(entry.prescriptionRetained).toBe(false);
    expect(entry.createdAt.getTime()).toBe(1_775_000_000_000);
  });

  it('exporta el CSV completo del periodo, sin paginar', () => {
    let blob: Blob | undefined;
    service.exportCsv({ from: '2026-08-01', to: '2026-08-31' }).subscribe((result) => (blob = result));

    const request = http.expectOne((req) => req.url === `${LEDGER_URL}/export`);
    expect(request.request.responseType).toBe('blob');
    expect(request.request.params.has('page')).toBe(false);
    expect(request.request.params.has('limit')).toBe(false);
    request.flush(new Blob(['folio,producto'], { type: 'text/csv' }));

    expect(blob).toBeInstanceOf(Blob);
  });
});
