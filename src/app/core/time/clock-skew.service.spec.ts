import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments/environment';
import { CashSessionService } from '../../features/pos/services/cash-session.service';
import { CashSession } from '../../shared/models';
import { clockSkewInterceptor } from '../api/clock-skew.interceptor';
import { CLOCK_SKEW_BLOCK_MS, CLOCK_SKEW_WARN_MS, ClockSkewService } from './clock-skew.service';

const HOUR = 3_600_000;
const MIN = 60_000;

describe('ClockSkewService (SPEC 65)', () => {
  let clock: ClockSkewService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    clock = TestBed.inject(ClockSkewService);
  });

  afterEach(() => vi.useRealTimers());

  it('sin medición usa el reloj local y no avisa ni bloquea', () => {
    expect(clock.measured()).toBe(false);
    expect(clock.skewMs()).toBeNull();
    expect(clock.warning()).toBe(false);
    expect(clock.blocked()).toBe(false);
    const antes = Date.now();
    expect(clock.now()).toBeGreaterThanOrEqual(antes);
    expect(clock.now()).toBeLessThanOrEqual(Date.now());
  });

  it('desfase = servidor − (salida + rtt/2)', () => {
    const salida = Date.parse('2026-11-06T18:00:00.000Z');
    // La respuesta tardó 2 s: el servidor la fechó a mitad de camino.
    clock.record(new Date(salida + 1_000 + 10 * MIN).toUTCString(), salida, salida + 2_000);
    expect(clock.skewMs()).toBe(10 * MIN);
  });

  it('suaviza con la mediana de las últimas 5: una lectura rara no lo mueve', () => {
    const base = Date.parse('2026-11-06T18:00:00.000Z');
    const lectura = (skew: number) => clock.record(new Date(base + skew).toUTCString(), base, base);
    [10 * MIN, 10 * MIN, 3 * HOUR, 10 * MIN, 11 * MIN].forEach(lectura);
    expect(clock.skewMs()).toBe(10 * MIN);

    // Entran 5 lecturas nuevas: las viejas salen de la ventana.
    [0, 0, 0, 0, 0].forEach(lectura);
    expect(clock.skewMs()).toBe(0);
  });

  it('ignora un header ausente o ilegible y un rtt negativo', () => {
    clock.record(null, 0, 10);
    clock.record('no es fecha', 0, 10);
    clock.record(new Date().toUTCString(), 10, 0);
    expect(clock.measured()).toBe(false);
  });

  it('avisa con más de 5 min y bloquea con más de 2 h, en los dos sentidos', () => {
    const base = Date.parse('2026-11-06T18:00:00.000Z');
    const fijar = (skew: number) => {
      clock.reset();
      clock.record(new Date(base + skew).toUTCString(), base, base);
    };

    fijar(CLOCK_SKEW_WARN_MS);
    expect(clock.warning()).toBe(false);
    fijar(10 * MIN);
    expect(clock.warning()).toBe(true);
    expect(clock.blocked()).toBe(false);
    expect(clock.skewMinutes()).toBe(10);
    fijar(-10 * MIN);
    expect(clock.warning()).toBe(true);
    fijar(CLOCK_SKEW_BLOCK_MS + MIN);
    expect(clock.blocked()).toBe(true);
    fijar(-3 * HOUR);
    expect(clock.blocked()).toBe(true);
  });

  it('now() es Date.now() + desfase', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T18:00:00.000Z'));
    const base = Date.now();
    clock.record(new Date(base + 3 * HOUR).toUTCString(), base, base);
    expect(clock.nowDate().toISOString()).toBe('2026-11-06T21:00:00.000Z');
  });
});

describe('clockSkewInterceptor + hora corregida (SPEC 65)', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let clock: ClockSkewService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([clockSkewInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    clock = TestBed.inject(ClockSkewService);
  });

  afterEach(() => {
    httpMock.verify();
    vi.useRealTimers();
    delete window.electronAPI;
  });

  /** Una respuesta de la API con el header `Date` desfasado `skewMs` del reloj local. */
  async function responder(skewMs: number, status = 200): Promise<void> {
    const peticion = firstValueFrom(http.get(`${environment.apiUrl}/health`)).catch(() => null);
    httpMock.expectOne(`${environment.apiUrl}/health`).flush(
      status === 200 ? { data: { ok: true } } : { error: { code: 'X', message: 'x' } },
      {
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { Date: new Date(Date.now() + skewMs).toUTCString() },
      },
    );
    await peticion;
  }

  it('lee el header Date de una respuesta exitosa de la API', async () => {
    await responder(3 * HOUR);
    // El header tiene resolución de 1 s.
    expect(Math.abs((clock.skewMs() ?? 0) - 3 * HOUR)).toBeLessThan(1_500);
  });

  it('no mide con una respuesta de error ni fuera de la API', async () => {
    await responder(3 * HOUR, 500);
    const ajena = firstValueFrom(http.get('https://otro.example.com/x'));
    httpMock.expectOne('https://otro.example.com/x').flush(
      {},
      { headers: { Date: new Date(Date.now() + 3 * HOUR).toUTCString() } },
    );
    await ajena;
    expect(clock.measured()).toBe(false);
  });

  it('con el header Date 3 h adelante, isSessionExpired usa la hora corregida', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Local: 23:30 del 5 nov en CDMX (UTC−6). El servidor ya va en las 02:30 del 6.
    vi.setSystemTime(new Date('2026-11-06T05:30:00.000Z'));
    const turno = {
      id: 'local-1',
      openedBy: 'u1',
      openingAmount: 500,
      // 22:00 del 5 nov en CDMX: con el reloj local sigue siendo "hoy".
      openedAt: new Date('2026-11-06T04:00:00.000Z'),
      closedAt: null,
    } as unknown as CashSession;
    const closeLocal = vi.fn().mockResolvedValue({ ...turno, closedAt: new Date() });
    window.electronAPI = {
      cashSessions: {
        getOpenLocal: vi.fn().mockResolvedValue(turno),
        getLiveSummary: vi
          .fn()
          .mockResolvedValue({ expectedCashAmount: 500, expectedServicesCashAmount: 0, summary: {} }),
        closeLocal,
      },
    } as unknown as Window['electronAPI'];
    const cashSessions = TestBed.inject(CashSessionService);

    // Sin medición: reloj local, el turno sigue vivo.
    expect(await cashSessions.autoCloseStale('u1')).toBe(false);
    expect(closeLocal).not.toHaveBeenCalled();

    await responder(3 * HOUR);

    expect(await cashSessions.autoCloseStale('u1')).toBe(true);
    expect(closeLocal).toHaveBeenCalledWith(
      'local-1',
      expect.objectContaining({ autoClosedByExpiry: true }),
    );
  });

  it('un reloj adelantado un día ya no autocierra el turno vivo', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Local: 6 nov 12:00 CDMX (un día adelantado). Servidor: 5 nov 12:00 CDMX.
    vi.setSystemTime(new Date('2026-11-06T18:00:00.000Z'));
    const turno = {
      id: 'local-1',
      openedBy: 'u1',
      openingAmount: 500,
      // 5 nov 09:00 CDMX en la hora real del servidor.
      openedAt: new Date('2026-11-05T15:00:00.000Z'),
      closedAt: null,
    } as unknown as CashSession;
    const closeLocal = vi.fn();
    window.electronAPI = {
      cashSessions: { getOpenLocal: vi.fn().mockResolvedValue(turno), closeLocal },
    } as unknown as Window['electronAPI'];
    const cashSessions = TestBed.inject(CashSessionService);

    await responder(-24 * HOUR);

    expect(await cashSessions.autoCloseStale('u1')).toBe(false);
    expect(closeLocal).not.toHaveBeenCalled();
  });
});
