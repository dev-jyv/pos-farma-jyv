import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { CashSessionService } from './cash-session.service';

const BASE = `${environment.apiUrl}/cash-sessions`;

const openSessionDto = {
  id: 's1',
  openedBy: 'u1',
  openingAmount: 500,
  expectedCashAmount: null,
  countedCashAmount: null,
  cashDifference: null,
  openedAt: '2026-08-08T14:00:00.000Z',
  closedAt: null,
};

describe('CashSessionService', () => {
  let service: CashSessionService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CashSessionService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('marca el turno como abierto al leer el turno actual', () => {
    service.fetchCurrent().subscribe();
    http.expectOne(`${BASE}/current`).flush({ data: openSessionDto });

    expect(service.current()?.id).toBe('s1');
    expect(service.current()?.openedAt.toISOString()).toBe('2026-08-08T14:00:00.000Z');
    expect(service.isOpen()).toBe(true);
  });

  it('sin turno deja `current` en null y `isOpen` en false', () => {
    service.fetchCurrent().subscribe();
    http.expectOne(`${BASE}/current`).flush({ data: null });

    expect(service.current()).toBeNull();
    expect(service.isOpen()).toBe(false);
  });

  it('un turno ya cerrado no cuenta como abierto', () => {
    service.fetchCurrent().subscribe();
    http.expectOne(`${BASE}/current`).flush({
      data: { ...openSessionDto, closedAt: '2026-08-08T22:00:00.000Z' },
    });

    expect(service.current()?.closedAt).toBeInstanceOf(Date);
    expect(service.isOpen()).toBe(false);
  });

  it('abre turno con el fondo de caja', () => {
    service.open(500).subscribe();

    const request = http.expectOne(BASE);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ openingAmount: 500 });
    request.flush({ data: openSessionDto });

    expect(service.isOpen()).toBe(true);
  });

  it('cerrar limpia el turno en memoria: la caja queda sin turno hasta abrir otro', () => {
    service.open(500).subscribe();
    http.expectOne(BASE).flush({ data: openSessionDto });

    service.close('s1', 1200).subscribe();
    const request = http.expectOne(`${BASE}/s1/close`);
    expect(request.request.body).toEqual({ countedCashAmount: 1200 });
    request.flush({
      data: {
        session: { ...openSessionDto, closedAt: '2026-08-08T22:00:00.000Z' },
        summary: { salesCount: 2, grandTotal: 700 },
        expectedCashAmount: 1200,
      },
    });

    expect(service.current()).toBeNull();
    expect(service.isOpen()).toBe(false);
  });

  it('completa el resumen del corte con ceros cuando el backend manda un resumen parcial', () => {
    let cut: { summary: { byMethod: { cash: { total: number } }; movements: { deposits: { count: number } } } } | undefined;
    service.getSummary('s1').subscribe((result) => (cut = result));

    http.expectOne(`${BASE}/s1/summary`).flush({
      data: { session: openSessionDto, summary: { salesCount: 3, grandTotal: 900 } },
    });

    expect(cut?.summary.byMethod.cash).toEqual({ count: 0, total: 0 });
    expect(cut?.summary.movements.deposits).toEqual({ count: 0, total: 0 });
  });

  it('lista y registra movimientos de caja', () => {
    let movements: Array<{ createdAt: Date }> = [];
    service.listMovements('s1').subscribe((result) => (movements = result));
    http.expectOne(`${BASE}/s1/movements`).flush({
      data: [
        {
          id: 'm1',
          cashSessionId: 's1',
          type: 'withdrawal',
          amount: 200,
          reason: 'Retiro parcial',
          createdBy: 'u1',
          createdAt: '2026-08-08T18:00:00.000Z',
        },
      ],
    });
    expect(movements[0].createdAt.toISOString()).toBe('2026-08-08T18:00:00.000Z');

    service.addMovement('s1', { type: 'expense', amount: 50, reason: 'Papelería' }).subscribe();
    const request = http.expectOne(`${BASE}/s1/movements`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ type: 'expense', amount: 50, reason: 'Papelería' });
    request.flush({ data: { id: 'm2', createdAt: '2026-08-08T18:30:00.000Z' } });
  });
});
