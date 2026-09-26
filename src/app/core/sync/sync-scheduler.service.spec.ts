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

  it('al vencer el cooldown emite un tick para que la UI se reactive sola', async () => {
    vi.useFakeTimers();
    const inicio = Date.now();
    await scheduler.syncManually(CAJERO, false);
    expect(scheduler.canSyncManually(CAJERO, false)).toBe(false);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 100);

    expect(scheduler.canSyncManually(CAJERO, false)).toBe(true);
    expect(scheduler.manualSyncAvailableAt(CAJERO)).toBeNull();
    vi.useRealTimers();
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
  let upsertPromotions: Mock;
  let recordRun: Mock;

  beforeEach(() => {
    localStorage.clear();
    upsertMany = vi.fn().mockResolvedValue({ count: 0 });
    upsertProviders = vi.fn().mockResolvedValue({ count: 0 });
    upsertPromotions = vi.fn().mockResolvedValue({ count: 0 });
    recordRun = vi.fn().mockResolvedValue({ id: 'r1' });
    window.electronAPI = {
      catalog: { upsertMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sales: {},
      sync: { getStatus: vi.fn().mockResolvedValue([]), recordRun },
      cashSessions: {},
      cashMovements: {},
      pharmacyServices: { list: vi.fn(), getById: vi.fn(), listProviders: vi.fn(), upsertMany, upsertProviders },
      promotions: { listActive: vi.fn().mockResolvedValue([]), upsertMany: upsertPromotions },
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

  /** Responde el pull de productos, los dos de servicios y el de promociones. */
  async function correrPull(opciones: { serviciosStatus?: number } = {}): Promise<void> {
    const promesa = scheduler.syncNow();
    // `syncNow` ahora espera el push completo antes del pull: varios
    // `flushQueueAsync` encadenados + la cola `pushChain`.
    await flush(40);

    http.expectOne((req) => req.url.endsWith('/products/sync')).flush({ data: [] });
    await flush();

    const servicios = http.expectOne((req) => req.url.endsWith('/pharmacy-services/sync'));
    if (opciones.serviciosStatus) {
      servicios.flush({ error: { message: 'Not Found' } }, { status: opciones.serviciosStatus, statusText: 'Not Found' });
      await flush();
      // Con el backend viejo, el de doctores también falla.
      const doctores = http.expectOne((req) => req.url.endsWith('/service-providers/sync'));
      doctores.flush({}, { status: opciones.serviciosStatus, statusText: 'Not Found' });
      await flush();
      http
        .expectOne((req) => req.url.endsWith('/promotions/sync'))
        .flush({}, { status: opciones.serviciosStatus, statusText: 'Not Found' });
    } else {
      servicios.flush({ data: [{ id: 'sv-1', updatedAt: '2026-09-07T10:00:00.000Z' }] });
      await flush();
      http.expectOne((req) => req.url.endsWith('/service-providers/sync')).flush({ data: [] });
      await flush();
      http
        .expectOne((req) => req.url.endsWith('/promotions/sync'))
        .flush({ data: [{ id: 'promo-1', updatedAt: '2026-09-24T10:00:00.000Z' }] });
    }
    await flush();
    await promesa;
  }

  async function flush(veces = 12): Promise<void> {
    for (let i = 0; i < veces; i += 1) {
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
    expect(new Set(entidades)).toEqual(
      new Set(['products', 'pharmacyServices', 'serviceProviders', 'promotions']),
    );
  });

  it('si falla el pull de productos, igual baja servicios, doctores y promociones', async () => {
    const promesa = scheduler.syncNow();
    await flush(40);
    http
      .expectOne((req) => req.url.endsWith('/products/sync'))
      .flush({}, { status: 500, statusText: 'Internal Server Error' });
    await flush();
    http.expectOne((req) => req.url.endsWith('/pharmacy-services/sync')).flush({ data: [] });
    await flush();
    http.expectOne((req) => req.url.endsWith('/service-providers/sync')).flush({ data: [] });
    await flush();
    http
      .expectOne((req) => req.url.endsWith('/promotions/sync'))
      .flush({ data: [{ id: 'promo-1', updatedAt: '2026-09-24T10:00:00.000Z' }] });
    await flush();
    await promesa;

    // La baja de una promo no puede depender de que el catálogo de productos baje.
    expect(upsertPromotions).toHaveBeenCalledWith([expect.objectContaining({ id: 'promo-1' })]);
    const corridas = recordRun.mock.calls.map(([run]) => run);
    expect(corridas.find((run) => run.entity === 'products')?.status).toBe('error');
    expect(corridas.find((run) => run.entity === 'promotions')?.status).toBe('ok');
  });

  it('baja las promociones y avisa al carrito para que las relea', async () => {
    const avisos = vi.fn();
    window.addEventListener('farmajyv:promotions-synced', avisos);
    await correrPull();
    window.removeEventListener('farmajyv:promotions-synced', avisos);

    expect(upsertPromotions).toHaveBeenCalledWith([expect.objectContaining({ id: 'promo-1' })]);
    expect(avisos).toHaveBeenCalledTimes(1);
  });
});

/**
 * **Un solo empuje a la vez.**
 *
 * `pushPending` sube en orden —turno, catálogo, entradas, movimientos, ventas y
 * al final los cierres— porque un turno cerrado no acepta movimientos ni ventas.
 * Ese orden solo vale dentro de una corrida, y cuatro sitios pueden arrancar una
 * (el horario, el botón de sincronizar, el cierre de turno y la salida de
 * sesión). Con dos corridas solapadas, el ciclo A ya subió el cierre cuando el B
 * llega a su paso de movimientos, y el servidor rechaza con "el turno de caja ya
 * está cerrado" un gasto que estaba en cola desde antes de cerrar.
 *
 * Se vio en producción: un `POST /movements` en rojo justo después del `close`.
 */
async function flushMicrotareas(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

describe('SyncScheduler — los empujes no se solapan', () => {
  let scheduler: SyncScheduler;
  /** Orden real en que se ejecutaron los pasos de todas las corridas. */
  let pasos: string[];
  /** Compuerta que detiene **solo** el paso de movimientos de la primera corrida. */
  let puerta: { activa: boolean; abrir: () => void; espera: Promise<void> };

  const paso = (nombre: string) => vi.fn(async () => {
    pasos.push(nombre);
  });

  beforeEach(() => {
    localStorage.clear();
    pasos = [];
    let abrir!: () => void;
    const espera = new Promise<void>((resolve) => {
      abrir = resolve;
    });
    puerta = { activa: false, abrir, espera };
    window.electronAPI = {
      catalog: {},
      sales: {},
      sync: { getStatus: vi.fn().mockResolvedValue([]), recordRun: vi.fn().mockResolvedValue({ id: 'r1' }) },
      cashSessions: {},
      cashMovements: {},
    } as unknown as Window['electronAPI'];

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiHealthService, useValue: { checkNow: vi.fn() } },
        {
          provide: AuthService,
          useValue: { user: () => ({ uid: 'uid-cajero' }), isAdmin: () => false },
        },
        { provide: SaleService, useValue: { flushQueue: vi.fn(), flushQueueAsync: paso('ventas') } },
        { provide: StockEntryService, useValue: { flushQueue: vi.fn(), flushQueueAsync: paso('entradas') } },
        { provide: ProductCatalogService, useValue: { flushQueue: vi.fn(), flushQueueAsync: paso('catalogo') } },
        {
          provide: CashSessionService,
          useValue: {
            flushQueue: vi.fn(),
            flushQueueAsync: paso('turnos'),
            flushClosesAsync: paso('cierres'),
            pullAdjustmentStatus: vi.fn(),
          },
        },
        {
          provide: CashMovementService,
          useValue: {
            flushQueue: vi.fn(),
            // Se puede dejar colgando para provocar el solapamiento.
            flushQueueAsync: vi.fn(async () => {
              pasos.push('movimientos');
              if (puerta.activa) {
                // Solo la primera: después queda abierta para las siguientes.
                puerta.activa = false;
                await puerta.espera;
              }
            }),
          },
        },
      ],
    });
    scheduler = TestBed.inject(SyncScheduler);
  });

  it('los cierres van después de los hijos y antes de las altas', async () => {
    await scheduler.flushPendingNow();

    // Cerrar antes que los hijos los condena ("el turno de caja ya está
    // cerrado"); abrir antes de cerrar el anterior choca con el único turno
    // abierto que admite el backend. Por eso los cierres van en medio.
    expect(pasos).toEqual([
      'catalogo',
      'entradas',
      'movimientos',
      'ventas',
      'cierres',
      'turnos',
      'movimientos',
      'ventas',
    ]);
  });

  it('la segunda corrida espera: ningún movimiento sale después de un cierre', async () => {
    // La primera se queda atorada en los movimientos; la segunda llega mientras.
    puerta.activa = true;
    const primera = scheduler.flushPendingNow();
    await flushMicrotareas();
    const segunda = scheduler.flushPendingNow();
    await flushMicrotareas();

    // Con las corridas solapadas, aquí ya habría un segundo 'movimientos'.
    expect(pasos).toEqual(['catalogo', 'entradas', 'movimientos']);

    puerta.abrir();
    await Promise.all([primera, segunda]);

    // Lo que importa ya no es "ningún movimiento después de un cierre" —el orden
    // nuevo termina con una segunda pasada de hijos, la de los turnos recién
    // creados—, sino que las corridas **no se entrelacen**: la segunda empieza
    // cuando la primera terminó entera.
    const ORDEN = [
      'catalogo',
      'entradas',
      'movimientos',
      'ventas',
      'cierres',
      'turnos',
      'movimientos',
      'ventas',
    ];
    expect(pasos).toEqual([...ORDEN, ...ORDEN]);
  });

  it('la segunda corrida sí ocurre: no se descarta, se encadena', async () => {
    // Puede traer trabajo que la primera ya no alcanzó a ver.
    await Promise.all([scheduler.flushPendingNow(), scheduler.flushPendingNow()]);

    expect(pasos.filter((p) => p === 'turnos')).toHaveLength(2);
  });

  it('una corrida que falla no deja atorada a la siguiente', async () => {
    const cashSessions = TestBed.inject(CashSessionService) as unknown as {
      flushQueueAsync: Mock;
    };
    cashSessions.flushQueueAsync.mockRejectedValueOnce(new Error('sin red'));

    await scheduler.flushPendingNow().catch(() => undefined);
    await scheduler.flushPendingNow();

    expect(pasos).toContain('cierres');
  });
});


/**
 * Turno que quedó abierto de un día anterior. Sustituye al auto-cierre de
 * medianoche, que cerraba el turno con sus gastos y ventas todavía en cola y los
 * condenaba a "el turno de caja ya está cerrado" sin nadie delante.
 *
 * Lo que se fija aquí es el **orden**: cierre local primero, luego el empuje
 * completo —movimientos y ventas antes, el cierre al final—, y solo cuando eso
 * termina la promesa resuelve, que es lo que deja pasar el modal de apertura.
 */
describe('SyncScheduler — liquidación del turno rezagado', () => {
  let scheduler: SyncScheduler;
  let pasos: string[];
  let autoCloseStale: Mock;

  const paso = (nombre: string) => vi.fn(async () => {
    pasos.push(nombre);
  });

  beforeEach(() => {
    localStorage.clear();
    pasos = [];
    autoCloseStale = vi.fn(async () => {
      pasos.push('cierre-local');
      return true;
    });
    window.electronAPI = {
      catalog: {},
      sales: {},
      sync: { getStatus: vi.fn().mockResolvedValue([]), recordRun: vi.fn().mockResolvedValue({ id: 'r1' }) },
      cashSessions: {},
      cashMovements: {},
    } as unknown as Window['electronAPI'];

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiHealthService, useValue: { checkNow: vi.fn() } },
        {
          provide: AuthService,
          useValue: { user: () => ({ uid: 'uid-cajero' }), isAdmin: () => false },
        },
        { provide: SaleService, useValue: { flushQueue: vi.fn(), flushQueueAsync: paso('ventas') } },
        { provide: StockEntryService, useValue: { flushQueue: vi.fn(), flushQueueAsync: paso('entradas') } },
        { provide: ProductCatalogService, useValue: { flushQueue: vi.fn(), flushQueueAsync: paso('catalogo') } },
        {
          provide: CashSessionService,
          useValue: {
            flushQueue: vi.fn(),
            flushQueueAsync: paso('turnos'),
            flushClosesAsync: paso('cierres'),
            pullAdjustmentStatus: vi.fn(),
            autoCloseStale,
          },
        },
        { provide: CashMovementService, useValue: { flushQueue: vi.fn(), flushQueueAsync: paso('movimientos') } },
      ],
    });
    scheduler = TestBed.inject(SyncScheduler);
  });

  it('cierra en local y después sube todo, con el cierre al final', async () => {
    const habia = await scheduler.settleStaleShift('uid-cajero', 'caja@farmajyv.mx');

    expect(habia).toBe(true);
    expect(pasos).toEqual([
      'cierre-local',
      'catalogo',
      'entradas',
      'movimientos',
      'ventas',
      // El cierre del turno rezagado sale aquí, ya con sus gastos y ventas
      // arriba; después las altas y la segunda pasada de hijos.
      'cierres',
      'turnos',
      'movimientos',
      'ventas',
    ]);
  });

  it('los movimientos y las ventas suben ANTES que el cierre', async () => {
    await scheduler.settleStaleShift('uid-cajero');

    expect(pasos.indexOf('movimientos')).toBeLessThan(pasos.indexOf('cierres'));
    expect(pasos.indexOf('ventas')).toBeLessThan(pasos.indexOf('cierres'));
  });

  it('sin turno rezagado no mueve nada: no hay por qué bloquear la pantalla', async () => {
    autoCloseStale.mockResolvedValue(false);

    expect(await scheduler.settleStaleShift('uid-cajero')).toBe(false);
    // Ni un solo paso de empuje: el mock reemplaza la implementación, así que
    // `pasos` queda vacío y eso es justo lo que se comprueba.
    expect(pasos).toEqual([]);
  });

  /**
   * El caso normal —no hay turno rezagado— es el 99 % de las entradas a Ventas.
   * Encender el bloqueo al **empezar** a averiguarlo hacía parpadear el modal
   * en cada una: un pantallazo sin motivo.
   */
  it('sin turno rezagado el bloqueo NUNCA se enciende', async () => {
    /**
     * Se mira **dentro** de `autoCloseStale`, que es el único instante en que un
     * encendido prematuro sería visible: entre encenderlo y apagarlo solo hay
     * microtareas, así que un observador por temporizador nunca lo vería y la
     * prueba pasaría en verde con el parpadeo puesto.
     */
    let encendidoAlAveriguar: boolean | null = null;
    autoCloseStale.mockImplementation(async () => {
      encendidoAlAveriguar = scheduler.settlingStaleShift();
      return false;
    });

    await scheduler.settleStaleShift('uid-cajero');

    expect(encendidoAlAveriguar).toBe(false);
    expect(scheduler.settlingStaleShift()).toBe(false);
  });

  it('con turno rezagado el bloqueo se enciende mientras sube y se apaga al terminar', async () => {
    let abrirCierres!: () => void;
    const enVuelo = new Promise<void>((resolve) => {
      abrirCierres = resolve;
    });
    const cashSessions = TestBed.inject(CashSessionService) as unknown as { flushClosesAsync: Mock };
    cashSessions.flushClosesAsync.mockImplementation(() => enVuelo);

    const promesa = scheduler.settleStaleShift('uid-cajero');
    await flushMicrotareas();
    expect(scheduler.settlingStaleShift()).toBe(true);

    abrirCierres();
    await promesa;
    expect(scheduler.settlingStaleShift()).toBe(false);
  });

  it('si el empuje falla, el bloqueo se apaga igual', async () => {
    // Si no, la caja se queda con el modal puesto y sin salida.
    const cashSessions = TestBed.inject(CashSessionService) as unknown as { flushClosesAsync: Mock };
    cashSessions.flushClosesAsync.mockRejectedValue(new Error('sin red'));

    await scheduler.settleStaleShift('uid-cajero').catch(() => undefined);

    expect(scheduler.settlingStaleShift()).toBe(false);
  });

  it('sin usuario resuelto no intenta nada', async () => {
    expect(await scheduler.settleStaleShift('')).toBe(false);
    expect(autoCloseStale).not.toHaveBeenCalled();
  });

  it('la promesa no resuelve hasta que subió el cierre', async () => {
    // Es lo que sostiene el bloqueo de la pantalla: si resolviera antes, el
    // modal de apertura saldría con el turno de ayer todavía subiendo.
    let abrirCierres!: () => void;
    const cierreEnVuelo = new Promise<void>((resolve) => {
      abrirCierres = resolve;
    });
    const cashSessions = TestBed.inject(CashSessionService) as unknown as { flushClosesAsync: Mock };
    cashSessions.flushClosesAsync.mockImplementation(async () => {
      pasos.push('cierres');
      await cierreEnVuelo;
    });
    let resuelta = false;

    void scheduler.settleStaleShift('uid-cajero').then(() => {
      resuelta = true;
    });
    await flushMicrotareas();

    expect(pasos).toContain('cierres');
    expect(resuelta).toBe(false);

    abrirCierres();
    await flushMicrotareas();
    expect(resuelta).toBe(true);
  });
});


/**
 * El aviso de salida ("quedan N movimientos sin sincronizar") tiene que hablar
 * de lo que **este** cajero puede subir.
 *
 * El conteo miraba las colas de todos los cajeros del equipo y el empuje solo
 * subía las del que está en sesión (`pushOwnerFilter`): el residuo no bajaba
 * nunca, el aviso salía en cada salida y era imposible de resolver — encima
 * prometía que se enviarían solos, cosa que para ese cajero no iba a pasar.
 */
describe('SyncScheduler — el conteo de pendientes usa el mismo filtro que el empuje', () => {
  type Colas = {
    salesPending: Mock; salesVoided: Mock; salesRemoteVoid: Mock;
    catalogPush: Mock; stockEntries: Mock; movements: Mock; sessions: Mock; closes: Mock;
  };
  let colas: Colas;

  function crear(isAdmin: boolean): SyncScheduler {
    colas = {
      salesPending: vi.fn().mockResolvedValue([]),
      salesVoided: vi.fn().mockResolvedValue([]),
      salesRemoteVoid: vi.fn().mockResolvedValue([]),
      catalogPush: vi.fn().mockResolvedValue([]),
      stockEntries: vi.fn().mockResolvedValue([]),
      movements: vi.fn().mockResolvedValue([]),
      sessions: vi.fn().mockResolvedValue([]),
      closes: vi.fn().mockResolvedValue([]),
    };
    window.electronAPI = {
      catalog: { getPendingCatalogPush: colas.catalogPush, getPendingStockEntries: colas.stockEntries },
      sales: {
        getPendingPush: colas.salesPending,
        getPendingVoided: colas.salesVoided,
        getNeedingRemoteVoid: colas.salesRemoteVoid,
      },
      sync: { getStatus: vi.fn().mockResolvedValue([]), recordRun: vi.fn() },
      cashSessions: { getPendingPush: colas.sessions, getPendingClosePush: colas.closes },
      cashMovements: { getPendingPush: colas.movements },
    } as unknown as Window['electronAPI'];

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiHealthService, useValue: { checkNow: vi.fn() } },
        {
          provide: AuthService,
          useValue: { user: () => ({ uid: 'uid-cajero' }), isAdmin: () => isAdmin },
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
    return TestBed.inject(SyncScheduler);
  }

  beforeEach(() => localStorage.clear());

  it('el cajero cuenta solo lo suyo: mismo filtro que el empuje', async () => {
    const scheduler = crear(false);

    await scheduler.countPending();

    for (const cola of ['salesPending', 'movements', 'sessions', 'closes']) {
      expect(colas[cola as keyof Colas]).toHaveBeenCalledWith({ ownerUid: 'uid-cajero' });
    }
  });

  it('el admin cuenta todo, igual que sube todo', async () => {
    const scheduler = crear(true);

    await scheduler.countPending();

    for (const cola of ['salesPending', 'movements', 'sessions', 'closes']) {
      expect(colas[cola as keyof Colas]).toHaveBeenCalledWith({});
    }
  });

  it('lo de otro cajero no infla el aviso de salida de este', async () => {
    const scheduler = crear(false);
    // El filtro lo aplica SQLite: con él puesto, estas colas vuelven vacías.
    colas.salesPending.mockResolvedValue([]);
    colas.movements.mockResolvedValue([]);

    expect(await scheduler.countPending()).toBe(0);
  });

  it('lo propio sí se cuenta', async () => {
    const scheduler = crear(false);
    colas.movements.mockResolvedValue([{ id: 'mov-1' }, { id: 'mov-2' }]);
    colas.salesPending.mockResolvedValue([{ id: 'venta-1' }]);

    expect(await scheduler.countPending()).toBe(3);
  });
});

/**
 * Pull liviano de promociones, cada hora y aparte del sync completo. El horario
 * fijo deja huecos de hasta 14 h: una baja del admin a las 15:00 se seguía
 * aplicando hasta las 20:00. Este pull no empuja nada, no consume el cupo del
 * botón y no se encima con otro igual ni con un sync completo.
 */
describe('SyncScheduler — pull de promociones cada hora', () => {
  let scheduler: SyncScheduler;
  let http: HttpTestingController;
  let upsertPromotions: Mock;
  let recordRun: Mock;
  let usuario: { uid: string } | null;

  beforeEach(() => {
    localStorage.clear();
    usuario = { uid: 'uid-cajero' };
    upsertPromotions = vi.fn().mockResolvedValue({ count: 1 });
    recordRun = vi.fn().mockResolvedValue({ id: 'r1' });
    window.electronAPI = {
      catalog: { upsertMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sales: {},
      sync: {
        getStatus: vi.fn().mockResolvedValue([
          { entity: 'promotions', direction: 'pull', status: 'ok', cursor: '2026-09-24T09:00:00.000Z' },
        ]),
        recordRun,
      },
      cashSessions: {},
      cashMovements: {},
      pharmacyServices: {
        upsertMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsertProviders: vi.fn().mockResolvedValue({ count: 0 }),
      },
      promotions: { listActive: vi.fn().mockResolvedValue([]), upsertMany: upsertPromotions },
    } as unknown as Window['electronAPI'];

    const flushAsync = { flushQueue: vi.fn(), flushQueueAsync: vi.fn().mockResolvedValue(undefined) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiHealthService, useValue: { checkNow: vi.fn() } },
        { provide: AuthService, useValue: { user: () => usuario, isAdmin: () => false } },
        { provide: SaleService, useValue: flushAsync },
        { provide: StockEntryService, useValue: flushAsync },
        { provide: ProductCatalogService, useValue: flushAsync },
        {
          provide: CashSessionService,
          useValue: {
            ...flushAsync,
            flushClosesAsync: vi.fn().mockResolvedValue(undefined),
            pullAdjustmentStatus: vi.fn(),
          },
        },
        { provide: CashMovementService, useValue: flushAsync },
      ],
    });
    scheduler = TestBed.inject(SyncScheduler);
    http = TestBed.inject(HttpTestingController);
  });

  async function flush(veces = 20): Promise<void> {
    for (let i = 0; i < veces; i += 1) {
      await Promise.resolve();
    }
  }

  it('baja solo promociones con su cursor, las guarda y avisa al carrito', async () => {
    const avisos = vi.fn();
    window.addEventListener('farmajyv:promotions-synced', avisos);

    const promesa = scheduler.pullPromotions();
    await flush();
    const req = http.expectOne((r) => r.url.endsWith('/promotions/sync'));
    expect(req.request.params.get('updatedSince')).toBe('2026-09-24T09:00:00.000Z');
    req.flush({ data: [{ id: 'promo-1', updatedAt: '2026-09-25T10:00:00.000Z' }] });

    await expect(promesa).resolves.toBe(true);
    window.removeEventListener('farmajyv:promotions-synced', avisos);

    // Nada de productos, servicios ni push: es el pull liviano.
    http.verify();
    expect(upsertPromotions).toHaveBeenCalledWith([expect.objectContaining({ id: 'promo-1' })]);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'promotions', status: 'ok', cursor: '2026-09-25T10:00:00.000Z' }),
    );
    expect(TestBed.inject(SaleService).flushQueueAsync).not.toHaveBeenCalled();
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it('sin sesión no pide nada', async () => {
    usuario = null;
    await expect(scheduler.pullPromotions()).resolves.toBe(false);
    await flush();
    http.expectNone((r) => r.url.endsWith('/promotions/sync'));
  });

  it('sin electronAPI (navegador) no pide nada', async () => {
    window.electronAPI = undefined as unknown as Window['electronAPI'];
    await expect(scheduler.pullPromotions()).resolves.toBe(false);
    http.expectNone((r) => r.url.endsWith('/promotions/sync'));
  });

  it('dos llamadas a la vez comparten la misma petición', async () => {
    const a = scheduler.pullPromotions();
    const b = scheduler.pullPromotions();
    await flush();
    http.expectOne((r) => r.url.endsWith('/promotions/sync')).flush({ data: [] });
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
  });

  it('un fallo de red devuelve false, registra el error y aun así avisa', async () => {
    const avisos = vi.fn();
    window.addEventListener('farmajyv:promotions-synced', avisos);
    const promesa = scheduler.pullPromotions();
    await flush();
    http
      .expectOne((r) => r.url.endsWith('/promotions/sync'))
      .flush({}, { status: 500, statusText: 'Internal Server Error' });
    await expect(promesa).resolves.toBe(false);
    window.removeEventListener('farmajyv:promotions-synced', avisos);
    expect(recordRun).toHaveBeenCalledWith(expect.objectContaining({ entity: 'promotions', status: 'error' }));
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it('con un sync completo en curso no pide promociones aparte: espera al completo', async () => {
    const completo = scheduler.syncNow();
    await flush(60);
    // El pull completo ya arrancó (está esperando `/products/sync`).
    const products = http.expectOne((r) => r.url.endsWith('/products/sync'));
    const liviano = scheduler.pullPromotions();

    products.flush({ data: [] });
    await flush();
    http.expectOne((r) => r.url.endsWith('/pharmacy-services/sync')).flush({ data: [] });
    await flush();
    http.expectOne((r) => r.url.endsWith('/service-providers/sync')).flush({ data: [] });
    await flush();
    // Una sola petición de promociones: la del sync completo.
    http.expectOne((r) => r.url.endsWith('/promotions/sync')).flush({ data: [] });
    await completo;
    await expect(liviano).resolves.toBe(true);
    http.verify();
  });

  it('no consume el cupo de sincronización manual del cajero', async () => {
    const promesa = scheduler.pullPromotions();
    await flush();
    http.expectOne((r) => r.url.endsWith('/promotions/sync')).flush({ data: [] });
    await promesa;
    expect(scheduler.canSyncManually('uid-cajero', false)).toBe(true);
  });

  it('start() lo arma cada 60 minutos y stop() lo desarma', async () => {
    vi.useFakeTimers();
    // 11:00 local: el siguiente horario fijo (14:00) queda fuera de la ventana.
    vi.setSystemTime(new Date(2026, 8, 25, 11, 0, 0));
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
      http.expectNone((r) => r.url.endsWith('/promotions/sync'));

      await vi.advanceTimersByTimeAsync(60 * 1000);
      http.expectOne((r) => r.url.endsWith('/promotions/sync')).flush({ data: [] });
      await vi.advanceTimersByTimeAsync(0);
      // Ni productos ni servicios: solo promociones.
      http.expectNone((r) => r.url.endsWith('/products/sync'));

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      http.expectNone((r) => r.url.endsWith('/promotions/sync'));
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});
