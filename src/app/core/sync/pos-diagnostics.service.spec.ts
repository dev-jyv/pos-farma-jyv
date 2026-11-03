import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { PosCommand, PosDiagnosticsInput } from '../../shared/models';
import { environment } from '../../../environments/environment';
import { PosDiagnosticsService } from './pos-diagnostics.service';
import { SyncRepairService } from './sync-repair.service';

/**
 * Diagnóstico remoto: la caja manda su foto de salud y ejecuta los comandos que
 * el admin dejó. Todo best-effort: nunca rompe el sync.
 */
describe('PosDiagnosticsService', () => {
  const api = environment.apiUrl;
  let http: HttpTestingController;
  let service: PosDiagnosticsService;
  let user: { uid: string } | null;
  let repair: {
    retrySale: ReturnType<typeof vi.fn>;
    retryTarget: ReturnType<typeof vi.fn>;
    sendSaleToUnreconciled: ReturnType<typeof vi.fn>;
  };
  let append: ReturnType<typeof vi.fn>;

  const snapshot = { deviceId: 'caja-1-aabb', blockedSales: [] } as unknown as PosDiagnosticsInput;

  function command(overrides: Partial<PosCommand> = {}): PosCommand {
    return {
      id: 'cmd-1',
      deviceId: 'caja-1-aabb',
      type: 'retrySale',
      targetLocalId: 'sale-1',
      note: null,
      status: 'pending',
      createdBy: 'admin@farma.mx',
      createdAt: '2026-10-01T10:00:00Z',
      completedAt: null,
      result: null,
      ...overrides,
    };
  }

  /** Deja correr las promesas encadenadas entre una petición HTTP y la siguiente. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    user = { uid: 'uid-cajero' };
    append = vi.fn().mockResolvedValue(null);
    window.electronAPI = {
      diagnostics: { buildSnapshot: vi.fn().mockResolvedValue(snapshot) },
      syncLog: { append, list: vi.fn() },
    } as unknown as NonNullable<Window['electronAPI']>;
    repair = {
      retrySale: vi.fn().mockResolvedValue({ ok: true, message: 'Venta reencolada' }),
      retryTarget: vi.fn().mockResolvedValue({ ok: false, message: 'El turno no existe en esta caja.' }),
      sendSaleToUnreconciled: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user: () => user } },
        { provide: SyncRepairService, useValue: repair },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(PosDiagnosticsService);
  });

  afterEach(() => {
    http.verify();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it('sin sesión no manda nada', async () => {
    user = null;
    await service.report();
    http.expectNone(`${api}/pos/diagnostics`);
  });

  it('manda la foto y ejecuta + reporta cada comando pendiente con el deviceId', async () => {
    const done = service.report();
    await flush();
    const post = http.expectOne(`${api}/pos/diagnostics`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toBe(snapshot);
    post.flush({
      data: {
        commands: [
          command(),
          command({ id: 'cmd-2', type: 'retryCashSession', targetLocalId: 'cs-x' }),
          command({ id: 'cmd-3', status: 'done' }),
        ],
      },
    });
    await flush();

    const r1 = http.expectOne(`${api}/pos/commands/cmd-1/result`);
    expect(r1.request.body).toEqual({ status: 'done', message: 'Venta reencolada', deviceId: 'caja-1-aabb' });
    r1.flush({});
    await flush();
    const r2 = http.expectOne(`${api}/pos/commands/cmd-2/result`);
    expect(r2.request.body).toEqual({
      status: 'failed',
      message: 'El turno no existe en esta caja.',
      deviceId: 'caja-1-aabb',
    });
    r2.flush({});
    await done;

    expect(repair.retrySale).toHaveBeenCalledWith('sale-1');
    expect(repair.retryTarget).toHaveBeenCalledWith('cashSession', 'cs-x');
    // El comando ya resuelto no se ejecuta ni se reporta.
    http.expectNone(`${api}/pos/commands/cmd-3/result`);
    // Recibido + resultado de cada uno quedan en la bitácora.
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ entity: 'command', ref: 'cmd-1' }));
  });

  it('ignora comandos de otro equipo', async () => {
    const done = service.report();
    await flush();
    http.expectOne(`${api}/pos/diagnostics`).flush({ data: { commands: [command({ deviceId: 'otra-caja' })] } });
    await done;
    expect(repair.retrySale).not.toHaveBeenCalled();
  });

  it('si el resultado no se pudo reportar, la siguiente vez lo reporta sin re-ejecutar', async () => {
    let done = service.report();
    await flush();
    http.expectOne(`${api}/pos/diagnostics`).flush({ data: { commands: [command()] } });
    await flush();
    http.expectOne(`${api}/pos/commands/cmd-1/result`).flush('boom', { status: 503, statusText: 'down' });
    await done;

    done = service.report();
    await flush();
    http.expectOne(`${api}/pos/diagnostics`).flush({ data: { commands: [command()] } });
    await flush();
    http.expectOne(`${api}/pos/commands/cmd-1/result`).flush({});
    await done;

    expect(repair.retrySale).toHaveBeenCalledTimes(1);
  });

  it('un fallo del POST de diagnóstico no rechaza: se anota en la bitácora', async () => {
    const done = service.report();
    await flush();
    http.expectOne(`${api}/pos/diagnostics`).flush('x', { status: 500, statusText: 'err' });
    await expect(done).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', entity: 'diagnostics' }));
  });

  it('sendSaleToUnreconciled pasa la nota del admin', async () => {
    const done = service.report();
    await flush();
    http
      .expectOne(`${api}/pos/diagnostics`)
      .flush({ data: { commands: [command({ type: 'sendSaleToUnreconciled', note: 'Turno perdido' })] } });
    await flush();
    http.expectOne(`${api}/pos/commands/cmd-1/result`).flush({});
    await done;
    expect(repair.sendSaleToUnreconciled).toHaveBeenCalledWith('sale-1', 'Turno perdido');
  });
});
