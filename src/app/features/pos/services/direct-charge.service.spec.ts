import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { DirectCharge } from '../../../shared/models';
import { DirectChargeService } from './direct-charge.service';

const BASE = `${environment.apiUrl}/direct-charges`;

describe('DirectChargeService', () => {
  let service: DirectChargeService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(DirectChargeService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('manda la llave de idempotencia también en el header estándar', () => {
    service
      .create({ idempotencyKey: 'key-1', deviceId: 'D1', amount: 120, concept: 'Inyección' })
      .subscribe();

    const request = http.expectOne(BASE);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.body).toEqual({
      idempotencyKey: 'key-1',
      deviceId: 'D1',
      amount: 120,
      concept: 'Inyección',
    });
    request.flush({ data: { id: 'dc1', createdAt: '2026-08-08T10:00:00.000Z' } });
  });

  it('el cobro en línea pega a /online y no manda terminal', () => {
    service.createOnline({ idempotencyKey: 'key-2', amount: 80, concept: 'Consulta' }).subscribe();

    const request = http.expectOne(`${BASE}/online`);
    expect(request.request.body).toEqual({
      idempotencyKey: 'key-2',
      amount: 80,
      concept: 'Consulta',
    });
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-2');
    request.flush({ data: { id: 'dc2', createdAt: '2026-08-08T10:00:00.000Z' } });
  });

  it('convierte las fechas del cobro y deja en null las ausentes', () => {
    let charge: DirectCharge | undefined;
    service.get('dc1').subscribe((result) => (charge = result));

    http.expectOne(`${BASE}/dc1`).flush({
      data: {
        id: 'dc1',
        folio: 'CD-000001',
        status: 'approved',
        channel: 'point',
        createdAt: '2026-08-08T10:00:00.000Z',
        approvedAt: { _seconds: 1_775_000_000 },
        canceledAt: null,
      },
    });

    expect(charge?.createdAt.toISOString()).toBe('2026-08-08T10:00:00.000Z');
    expect(charge?.approvedAt?.getTime()).toBe(1_775_000_000_000);
    expect(charge?.canceledAt).toBeNull();
  });

  it('cancela por POST /:id/cancel', () => {
    service.cancel('dc1').subscribe();

    const request = http.expectOne(`${BASE}/dc1/cancel`);
    expect(request.request.method).toBe('POST');
    request.flush({ data: { id: 'dc1', status: 'canceled', createdAt: '2026-08-08T10:00:00.000Z' } });
  });

  it('lista omitiendo los filtros vacíos', () => {
    service.list({ limit: 25, status: undefined, search: '' }).subscribe();

    const request = http.expectOne((req) => req.url === BASE);
    expect(request.request.params.get('limit')).toBe('25');
    expect(request.request.params.has('status')).toBe(false);
    expect(request.request.params.has('search')).toBe(false);
    request.flush({ data: [] });
  });

  it('mapea cada renglón de la lista', () => {
    let charges: DirectCharge[] = [];
    service.list().subscribe((result) => (charges = result));

    http.expectOne((req) => req.url === BASE).flush({
      data: [{ id: 'dc1', createdAt: '2026-08-08T10:00:00.000Z' }],
    });

    expect(charges[0].createdAt).toBeInstanceOf(Date);
  });
});
