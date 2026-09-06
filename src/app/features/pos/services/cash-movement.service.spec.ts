import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import { CashMovement } from '../../../shared/models';
import { CashMovementService } from './cash-movement.service';

const BASE = `${environment.apiUrl}/cash-sessions`;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function movement(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    id: 'mov-1',
    cashSessionId: 'local-1',
    type: 'expense',
    amount: 120,
    reason: 'Insumos: guantes',
    category: 'supplies',
    description: 'Cajas de guantes',
    createdBy: 'u1',
    createdAt: new Date('2026-09-05T15:00:00.000Z'),
    pendingPush: true,
    ...overrides,
  };
}

describe('CashMovementService (local-first)', () => {
  let service: CashMovementService;
  let http: HttpTestingController;
  let cashMovements: {
    add: ReturnType<typeof vi.fn>;
    listForSession: ReturnType<typeof vi.fn>;
    listAllLocal: ReturnType<typeof vi.fn>;
    getPendingPush: ReturnType<typeof vi.fn>;
    assertPushable: ReturnType<typeof vi.fn>;
    markSynced: ReturnType<typeof vi.fn>;
    markPushFailed: ReturnType<typeof vi.fn>;
    clearPushError: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    cashMovements = {
      add: vi.fn().mockResolvedValue(movement()),
      listForSession: vi.fn().mockResolvedValue([movement()]),
      listAllLocal: vi.fn().mockResolvedValue([]),
      getPendingPush: vi.fn().mockResolvedValue([]),
      // Cerrojo del momento del envío: por defecto el turno sigue admitiendo.
      assertPushable: vi.fn().mockResolvedValue(true),
      markSynced: vi.fn().mockResolvedValue(undefined),
      markPushFailed: vi.fn().mockResolvedValue(undefined),
      clearPushError: vi.fn().mockResolvedValue(undefined),
    };
    window.electronAPI = {
      getAppVersion: vi.fn(),
      getDeviceInfo: vi.fn(),
      openCashDrawer: vi.fn(),
      catalog: {},
      sales: {},
      sync: { getStatus: vi.fn(), recordRun: vi.fn() },
      cashSessions: {},
      cashMovements,
    } as unknown as Window['electronAPI'];

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CashMovementService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('create', () => {
    it('escribe el gasto en local sin tocar la red', async () => {
      const creado: CashMovement[] = [];
      service
        .create('local-1', {
          type: 'expense',
          amount: 120,
          reason: 'Insumos: guantes',
          category: 'supplies',
          description: 'Cajas de guantes',
          createdBy: 'u1',
        })
        .subscribe((result) => creado.push(result));
      await flushMicrotasks();

      expect(cashMovements.add).toHaveBeenCalledWith('local-1', expect.objectContaining({ type: 'expense' }));
      expect(creado[0].id).toBe('mov-1');
      http.expectNone(() => true);
    });

    it('un depósito usa el mismo camino local', async () => {
      cashMovements.add.mockResolvedValue(movement({ type: 'deposit', category: null, description: null }));
      service
        .create('local-1', { type: 'deposit', amount: 50, reason: 'Fondo extra', createdBy: 'u1' })
        .subscribe();
      await flushMicrotasks();

      expect(cashMovements.add).toHaveBeenCalledWith('local-1', expect.objectContaining({ type: 'deposit' }));
      http.expectNone(() => true);
    });

    it('propaga el error de validación local (gasto sin categoría) sin llamar al backend', async () => {
      cashMovements.add.mockRejectedValue(new Error('La categoría es requerida para gastos'));
      let error: unknown = null;
      service
        .create('local-1', { type: 'expense', amount: 10, reason: 'x', createdBy: 'u1' })
        .subscribe({ error: (err: unknown) => (error = err) });
      await flushMicrotasks();

      expect(error).toBeInstanceOf(Error);
      http.expectNone(() => true);
    });

    it('sin Electron falla explícito en vez de intentar cobrar por HTTP', () => {
      window.electronAPI = undefined as unknown as Window['electronAPI'];
      expect(() =>
        service.create('local-1', { type: 'expense', amount: 10, reason: 'x', category: 'food', createdBy: 'u1' }),
      ).toThrow(/electronAPI no disponible/i);
    });
  });

  describe('flushQueue', () => {
    it('sube cada movimiento pendiente al turno remoto correcto', async () => {
      cashMovements.getPendingPush.mockResolvedValue([
        {
          id: 'mov-1',
          cashSessionRemoteId: 'remote-1',
          type: 'expense',
          amount: 120,
          reason: 'Insumos: guantes',
          category: 'supplies',
          description: 'Cajas de guantes',
        },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      const request = http.expectOne(`${BASE}/remote-1/movements`);
      expect(request.request.body).toEqual({
        type: 'expense',
        amount: 120,
        reason: 'Insumos: guantes',
        category: 'supplies',
        description: 'Cajas de guantes',
      });
      request.flush({ data: { id: 'remote-mov-1' } });
      await flushMicrotasks();

      // Con el `remoteId` que devolvió el backend: es lo que evita duplicar el
      // movimiento allá si el push se reintenta.
      expect(cashMovements.markSynced).toHaveBeenCalledWith('mov-1', 'remote-mov-1');
    });

    /**
     * Caja de la farmacia: el movimiento no cuelga de ningún turno, así que no
     * hay `:remoteId` que poner en la ruta y el destino es el endpoint propio.
     */
    it('un movimiento sin turno va a la ruta de la caja de la farmacia', async () => {
      cashMovements.getPendingPush.mockResolvedValue([
        { id: 'mov-9', cashSessionRemoteId: null, type: 'withdrawal', amount: 200, reason: 'Depósito bancario' },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      const request = http.expectOne(`${BASE}/movements`);
      expect(request.request.body).toEqual({
        type: 'withdrawal',
        amount: 200,
        reason: 'Depósito bancario',
      });
      request.flush({ data: { id: 'remote-mov-9' } });
      await flushMicrotasks();

      expect(cashMovements.markSynced).toHaveBeenCalledWith('mov-9', 'remote-mov-9');
    });

    it('omite category/description cuando no aplican (depósito)', async () => {
      cashMovements.getPendingPush.mockResolvedValue([
        { id: 'mov-2', cashSessionRemoteId: 'remote-1', type: 'deposit', amount: 50, reason: 'Fondo extra' },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      const request = http.expectOne(`${BASE}/remote-1/movements`);
      expect(request.request.body).toEqual({ type: 'deposit', amount: 50, reason: 'Fondo extra' });
      request.flush({ data: {} });
    });

    it('sube los movimientos en serie, no en paralelo', async () => {
      cashMovements.getPendingPush.mockResolvedValue([
        { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
        { id: 'mov-2', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 20, reason: 'b', category: 'food' },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      const primero = http.expectOne(`${BASE}/remote-1/movements`);
      primero.flush({ data: {} });
      await flushMicrotasks();

      const segundo = http.expectOne(`${BASE}/remote-1/movements`);
      expect(segundo.request.body).toMatchObject({ amount: 20 });
      segundo.flush({ data: {} });
      await flushMicrotasks();

      expect(cashMovements.markSynced).toHaveBeenCalledTimes(2);
    });

    it('un rechazo permanente (4xx) bloquea el movimiento para revisión manual', async () => {
      cashMovements.getPendingPush.mockResolvedValue([
        { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/movements`).flush(
        { error: { message: 'La categoría es requerida para gastos' } },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      expect(cashMovements.markPushFailed).toHaveBeenCalledWith('mov-1', expect.any(String));
      expect(cashMovements.markSynced).not.toHaveBeenCalled();
    });

    it('un fallo transitorio (5xx) lo deja en la cola para el siguiente ciclo', async () => {
      cashMovements.getPendingPush.mockResolvedValue([
        { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/movements`).flush(null, { status: 502, statusText: 'Bad Gateway' });
      await flushMicrotasks();

      expect(cashMovements.markPushFailed).not.toHaveBeenCalled();
      expect(cashMovements.markSynced).not.toHaveBeenCalled();
    });

    it('sin pendientes no hace ninguna llamada', async () => {
      cashMovements.getPendingPush.mockResolvedValue([]);
      service.flushQueue();
      await flushMicrotasks();
      http.expectNone(() => true);
    });

    it('dos flush simultáneos no duplican el push', async () => {
      cashMovements.getPendingPush.mockResolvedValue([
        { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
      ]);
      service.flushQueue();
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/movements`).flush({ data: {} });
      await flushMicrotasks();
      expect(cashMovements.markSynced).toHaveBeenCalledTimes(1);
    });

    /**
     * Lo que el sincronizador **espera** antes de cerrar el turno. Si esta
     * promesa resuelve con gastos todavía en cola, el cierre les gana y el
     * backend los rechaza con "el turno de caja ya está cerrado": gastos reales
     * que quedan bloqueados sin haber hecho nada mal.
     */
    describe('flushQueueAsync (la que espera el cierre de turno)', () => {
      it('sube TODOS los pendientes, no solo el primero', async () => {
        cashMovements.getPendingPush.mockResolvedValue([
          { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
          { id: 'mov-2', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 20, reason: 'b', category: 'food' },
          { id: 'mov-3', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 30, reason: 'c', category: 'food' },
        ]);

        // `flush$` emite uno por movimiento: tomar el primero desuscribía la
        // cadena y cancelaba los otros dos.
        const promesa = service.flushQueueAsync();
        await flushMicrotasks();

        for (const monto of [10, 20, 30]) {
          const request = http.expectOne(`${BASE}/remote-1/movements`);
          expect(request.request.body).toMatchObject({ amount: monto });
          request.flush({ data: {} });
          await flushMicrotasks();
        }

        await promesa;
        expect(cashMovements.markSynced).toHaveBeenCalledTimes(3);
      });

      it('no resuelve mientras quedan pendientes por subir', async () => {
        cashMovements.getPendingPush.mockResolvedValue([
          { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
          { id: 'mov-2', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 20, reason: 'b', category: 'food' },
        ]);
        let resuelta = false;

        void service.flushQueueAsync().then(() => {
          resuelta = true;
        });
        await flushMicrotasks();

        http.expectOne(`${BASE}/remote-1/movements`).flush({ data: {} });
        await flushMicrotasks();

        // El segundo todavía va en camino: resolver aquí deja pasar el cierre.
        expect(resuelta).toBe(false);

        http.expectOne(`${BASE}/remote-1/movements`).flush({ data: {} });
        await flushMicrotasks();
        expect(resuelta).toBe(true);
      });

      it('espera al empuje que ya venía en vuelo, no resuelve en el acto', async () => {
        cashMovements.getPendingPush.mockResolvedValue([
          { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
        ]);
        // El cajero acaba de tocar "reintentar" y cierra el turno enseguida.
        service.flushQueue();
        await flushMicrotasks();
        let resuelta = false;

        void service.flushQueueAsync().then(() => {
          resuelta = true;
        });
        await flushMicrotasks();

        // Con el guard devolviendo EMPTY, esta promesa resolvía sin subir nada.
        expect(resuelta).toBe(false);

        // La pasada encolada relee la cola: para entonces ya no queda nada.
        cashMovements.getPendingPush.mockResolvedValue([]);
        http.expectOne(`${BASE}/remote-1/movements`).flush({ data: {} });
        await flushMicrotasks();
        await flushMicrotasks();

        expect(resuelta).toBe(true);
      });
    });

    /**
     * **Ninguna petición de movimiento después del cierre.**
     *
     * La cola se lee al arrancar el empuje, y entre esa lectura y el `POST` de
     * cada movimiento cabe un cierre. Si la petición sale igual, el backend
     * responde 400 "el turno de caja ya está cerrado": es la petición en rojo
     * que aparecía justo después del `close`.
     */
    describe('cerrojo del momento del envío', () => {
      it('no manda el POST si el turno cerró entre la lectura de la cola y el envío', async () => {
        cashMovements.getPendingPush.mockResolvedValue([
          { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
        ]);
        // El cierre ganó la carrera mientras este movimiento esperaba su turno.
        cashMovements.assertPushable.mockResolvedValue(false);

        await service.flushQueueAsync();
        await flushMicrotasks();

        // `http.verify()` del afterEach confirma que no quedó ninguna en vuelo.
        http.expectNone(`${BASE}/remote-1/movements`);
        expect(cashMovements.markSynced).not.toHaveBeenCalled();
      });

      it('el cerrojo se consulta por movimiento, no una vez por lote', async () => {
        cashMovements.getPendingPush.mockResolvedValue([
          { id: 'mov-1', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 10, reason: 'a', category: 'food' },
          { id: 'mov-2', cashSessionRemoteId: 'remote-1', type: 'expense', amount: 20, reason: 'b', category: 'food' },
        ]);
        // El primero alcanza; para cuando toca el segundo, el turno ya cerró.
        cashMovements.assertPushable
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);

        const promesa = service.flushQueueAsync();
        await flushMicrotasks();
        http.expectOne(`${BASE}/remote-1/movements`).flush({ data: {} });
        await flushMicrotasks();
        await promesa;

        http.expectNone(`${BASE}/remote-1/movements`);
        expect(cashMovements.assertPushable).toHaveBeenCalledTimes(2);
        expect(cashMovements.markSynced).toHaveBeenCalledTimes(1);
      });

      it('un movimiento sin turno (caja de la farmacia) no consulta el cerrojo', async () => {
        // No cuelga de ningún turno: no hay nada que se pueda cerrar.
        cashMovements.getPendingPush.mockResolvedValue([
          { id: 'mov-1', cashSessionRemoteId: null, type: 'withdrawal', amount: 50, reason: 'Banco' },
        ]);

        const promesa = service.flushQueueAsync();
        await flushMicrotasks();
        http.expectOne(`${BASE}/movements`).flush({ data: {} });
        await promesa;

        expect(cashMovements.assertPushable).not.toHaveBeenCalled();
      });
    });

    it('un fallo del propio IPC no revienta el ciclo de sincronización', async () => {
      cashMovements.getPendingPush.mockRejectedValue(new Error('SQLite bloqueada'));
      await expect(service.flushQueueAsync()).resolves.toBeUndefined();
      http.expectNone(() => true);
    });
  });

  describe('auditoría admin', () => {
    it('normaliza el Timestamp de Firestore: la columna Fecha salía vacía', async () => {
      const resultado: CashMovement[] = [];
      service.listMovementsAudit({ type: 'expense' }).subscribe((page) => {
        resultado.push(...page.items);
      });
      await flushMicrotasks();

      const request = http.expectOne((req) => req.url === `${BASE}/movements`);
      // Forma real del backend: Firestore serializa así, y el `DatePipe` no la
      // sabe pintar, así que la fecha se veía en blanco.
      request.flush({
        data: [{ ...movement(), createdAt: { _seconds: 1_757_030_400, _nanoseconds: 0 } }],
        meta: { page: 1, limit: 50, total: 1, totalPages: 1 },
      });

      expect(resultado[0].createdAt).toBeInstanceOf(Date);
      expect((resultado[0].createdAt as Date).getTime()).toBe(1_757_030_400_000);
    });

    it('listMovementsAudit consulta el backend con el filtro de gastos', async () => {
      const resultado: CashMovement[] = [];
      let meta: { total: number } | null = null;
      service.listMovementsAudit({ type: 'expense' }).subscribe((page) => {
        resultado.push(...page.items);
        meta = page.meta;
      });
      await flushMicrotasks();

      const request = http.expectOne((req) => req.url === `${BASE}/movements`);
      expect(request.request.params.get('type')).toBe('expense');
      request.flush({ data: [movement()], meta: { page: 1, limit: 50, total: 120, totalPages: 3 } });

      expect(resultado).toHaveLength(1);
      // El `meta` es lo que deja paginar de verdad: sin él la pantalla no sabe
      // que hay 120 gastos y solo puede mostrar el lote que le llegó.
      expect(meta).toMatchObject({ total: 120, totalPages: 3 });
      expect(cashMovements.listAllLocal).not.toHaveBeenCalled();
    });

    it('traslada todos los filtros soportados', async () => {
      service
        .listMovementsAudit({
          type: 'expense',
          category: 'supplier',
          cashSessionId: 'remote-1',
          from: '2026-09-01',
          to: '2026-09-30',
        })
        .subscribe();
      await flushMicrotasks();

      const request = http.expectOne((req) => req.url === `${BASE}/movements`);
      expect(request.request.params.get('category')).toBe('supplier');
      expect(request.request.params.get('cashSessionId')).toBe('remote-1');
      expect(request.request.params.get('from')).toBe('2026-09-01');
      expect(request.request.params.get('to')).toBe('2026-09-30');
      request.flush({ data: [] });
    });

    it('sin filtros no manda query params vacíos', async () => {
      service.listMovementsAudit().subscribe();
      await flushMicrotasks();

      const request = http.expectOne((req) => req.url === `${BASE}/movements`);
      expect(request.request.params.keys()).toHaveLength(0);
      request.flush([]);
    });
  });
});
