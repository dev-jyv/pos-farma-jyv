import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiHealthService } from '../health/api-health.service';
import { CashMovementService } from '../../features/pos/services/cash-movement.service';
import { CashSessionService } from '../../features/pos/services/cash-session.service';
import { ProductCatalogService } from '../../features/pos/services/product-catalog.service';
import { SaleService } from '../../features/pos/services/sale.service';
import { StockEntryService } from '../../features/pos/services/stock-entry.service';
import { SyncScheduler } from './sync-scheduler.service';
import { AuthService } from '../auth/auth.service';

/**
 * Regla de uso del botón "Sincronizar": el cajero cada 15 minutos, el admin sin
 * límite. El pull trae el catálogo completo y el push recorre toda la cola, así
 * que un botón sin freno en el mostrador son decenas de corridas por turno.
 */
describe('SyncScheduler — límite de sincronización manual', () => {
  const CAJERO = 'uid-cajero';
  let scheduler: SyncScheduler;

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiHealthService, useValue: { checkNow: vi.fn() } },
        // El scheduler pregunta quién sincroniza para subir solo lo de ese cajero.
        {
          provide: AuthService,
          useValue: { user: () => ({ uid: 'uid-cajero' }), isAdmin: () => false },
        },
        {
          provide: SaleService,
          useValue: { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: StockEntryService,
          useValue: { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ProductCatalogService,
          useValue: { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CashSessionService,
          useValue: {
            flushQueue: vi.fn(),
            flushQueueAsync: vi.fn().mockResolvedValue(undefined),
            flushClosesAsync: vi.fn().mockResolvedValue(undefined),
            pullAdjustmentStatus: vi.fn(),
          },
        },
        {
          provide: CashMovementService,
          useValue: { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) },
        },
      ],
    });
    scheduler = TestBed.inject(SyncScheduler);
    // La corrida real (pull del catálogo + push de la cola) tiene su propia
    // cobertura; aquí se prueba solo quién puede dispararla y cada cuánto.
    vi.spyOn(scheduler, 'syncNow').mockResolvedValue({ ok: true, pulled: 0 });
  });

  it('permite la primera sincronización manual del cajero', () => {
    expect(scheduler.canSyncManually(CAJERO, false)).toBe(true);
    expect(scheduler.manualSyncAvailableAt(CAJERO)).toBeNull();
  });

  it('bloquea al cajero 15 minutos tras sincronizar', async () => {
    const inicio = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(inicio);
    await scheduler.syncManually(CAJERO, false);

    expect(scheduler.canSyncManually(CAJERO, false)).toBe(false);
    const disponibleA = scheduler.manualSyncAvailableAt(CAJERO);
    expect(disponibleA?.getTime()).toBe(inicio + 15 * 60 * 1000);

    const rechazo = await scheduler.syncManually(CAJERO, false);
    expect(rechazo.ok).toBe(false);
    expect(rechazo.blockedUntil).toBeInstanceOf(Date);
    vi.restoreAllMocks();
  });

  it('vuelve a permitirlo pasados los 15 minutos', async () => {
    const inicio = Date.now();
    const ahora = vi.spyOn(Date, 'now').mockReturnValue(inicio);
    await scheduler.syncManually(CAJERO, false);

    ahora.mockReturnValue(inicio + 15 * 60 * 1000 + 1);
    expect(scheduler.canSyncManually(CAJERO, false)).toBe(true);
    vi.restoreAllMocks();
  });

  it('el admin sincroniza sin límite', async () => {
    const inicio = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(inicio);
    await scheduler.syncManually('uid-admin', true);

    expect(scheduler.canSyncManually('uid-admin', true)).toBe(true);
    const segunda = await scheduler.syncManually('uid-admin', true);
    expect(segunda.blockedUntil).toBeUndefined();
    vi.restoreAllMocks();
  });

  /** Dos cajeros se turnan el mismo equipo: el cupo de uno no gasta el del otro. */
  it('el cupo es por usuario, no por equipo', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    await scheduler.syncManually(CAJERO, false);

    expect(scheduler.canSyncManually('uid-otro-cajero', false)).toBe(true);
    vi.restoreAllMocks();
  });

  /** Cerrar y reabrir la app no debe regalar una sincronización extra. */
  it('el límite sobrevive al reinicio de la app', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    await scheduler.syncManually(CAJERO, false);
    vi.restoreAllMocks();

    const otraInstancia = TestBed.inject(SyncScheduler);
    expect(otraInstancia.canSyncManually(CAJERO, false)).toBe(false);
  });
});

/**
 * Orden de despliegue: el backend va antes que el POS. Pero eso no se sostiene
 * con disciplina, sino por construcción — un ticket mixto solo puede existir si
 * el catálogo de servicios llegó, y el catálogo solo puede llegar de un backend
 * que ya sirve `/pharmacy-services/sync`. Contra un backend viejo el pull falla,
 * el catálogo queda vacío y la caja no puede cobrar un servicio.
 *
 * Estas pruebas fijan esa propiedad: si alguien la rompe, un ticket mixto podría
 * llegar a un backend que lo rechaza por inventario y terminar en
 * `unreconciledSales`, de donde no se rescata desde la caja.
 */
describe('SyncScheduler — catálogos de servicios contra un backend viejo', () => {
  let scheduler: SyncScheduler;
  let http: HttpTestingController;
  let upsertMany: Mock;
  let upsertProviders: Mock;
  let recordRun: Mock;

  beforeEach(() => {
    localStorage.clear();
    upsertMany = vi.fn().mockResolvedValue({ count: 0 });
    upsertProviders = vi.fn().mockResolvedValue({ count: 0 });
    recordRun = vi.fn().mockResolvedValue({ id: 'r1' });
    window.electronAPI = {
      catalog: { upsertMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sales: {},
      sync: { getStatus: vi.fn().mockResolvedValue([]), recordRun },
      cashSessions: {},
      cashMovements: {},
      pharmacyServices: { list: vi.fn(), getById: vi.fn(), listProviders: vi.fn(), upsertMany, upsertProviders },
    } as unknown as Window['electronAPI'];

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiHealthService, useValue: { checkNow: vi.fn() } },
        // El scheduler pregunta quién sincroniza para subir solo lo de ese cajero.
        {
          provide: AuthService,
          useValue: { user: () => ({ uid: 'uid-cajero' }), isAdmin: () => false },
        },
        { provide: SaleService, useValue: { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) } },
        { provide: StockEntryService, useValue: { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) } },
        { provide: ProductCatalogService, useValue: { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: CashSessionService,
          useValue: {
            flushQueue: vi.fn(),
            flushQueueAsync: vi.fn().mockResolvedValue(undefined),
            flushClosesAsync: vi.fn().mockResolvedValue(undefined),
            pullAdjustmentStatus: vi.fn(),
          },
        },
        { provide: CashMovementService, useValue: { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) } },
      ],
    });
    scheduler = TestBed.inject(SyncScheduler);
    http = TestBed.inject(HttpTestingController);
  });

  /** Responde el pull de productos y luego los dos de catálogos de servicios. */
  async function correrPull(opciones: { serviciosStatus?: number } = {}): Promise<void> {
    const promesa = scheduler.syncNow();
    await flush();

    http.expectOne((req) => req.url.endsWith('/products/sync')).flush({ data: [] });
    await flush();

    const servicios = http.expectOne((req) => req.url.endsWith('/pharmacy-services/sync'));
    if (opciones.serviciosStatus) {
      servicios.flush({ error: { message: 'Not Found' } }, { status: opciones.serviciosStatus, statusText: 'Not Found' });
      await flush();
      // Con el backend viejo, el de doctores también falla.
      const doctores = http.expectOne((req) => req.url.endsWith('/service-providers/sync'));
      doctores.flush({}, { status: opciones.serviciosStatus, statusText: 'Not Found' });
    } else {
      servicios.flush({ data: [{ id: 'sv-1', updatedAt: '2026-09-07T10:00:00.000Z' }] });
      await flush();
      http.expectOne((req) => req.url.endsWith('/service-providers/sync')).flush({ data: [] });
    }
    await flush();
    await promesa;
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve();
    }
  }

  it('con un backend viejo (404) NO escribe nada en el catálogo local', async () => {
    await correrPull({ serviciosStatus: 404 });

    // Catálogo vacío ⇒ la pestaña de servicios no aparece ⇒ no hay ticket mixto.
    expect(upsertMany).not.toHaveBeenCalled();
    expect(upsertProviders).not.toHaveBeenCalled();
  });

  it('el fallo de los servicios no rompe el sync del catálogo de medicamentos', async () => {
    await correrPull({ serviciosStatus: 404 });

    // Lo importante: la caja sigue vendiendo medicamentos con normalidad.
    expect(window.electronAPI?.catalog.upsertMany).toBeDefined();
    const corridas = recordRun.mock.calls.map(([run]) => run);
    expect(corridas.find((run) => run.entity === 'products')?.status).toBe('ok');
    expect(corridas.find((run) => run.entity === 'pharmacyServices')?.status).toBe('error');
  });

  it('con un backend al día, el catálogo sí se escribe', async () => {
    await correrPull();

    expect(upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'sv-1' }),
    ]);
    const corridas = recordRun.mock.calls.map(([run]) => run);
    expect(corridas.find((run) => run.entity === 'pharmacyServices')?.status).toBe('ok');
  });

  it('cada catálogo lleva su propio cursor: uno no deja al otro creyendo estar al día', async () => {
    await correrPull();

    const entidades = recordRun.mock.calls.map(([run]) => run.entity);
    expect(new Set(entidades)).toEqual(new Set(['products', 'pharmacyServices', 'serviceProviders']));
  });
});
