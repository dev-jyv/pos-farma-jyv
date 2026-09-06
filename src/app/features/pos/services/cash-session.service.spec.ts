import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import { CashSession } from '../../../shared/models';
import { CashSessionService } from './cash-session.service';

const BASE = `${environment.apiUrl}/cash-sessions`;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function localSession(overrides: Partial<CashSession> = {}): CashSession {
  return {
    id: 'local-1',
    remoteId: null,
    openedBy: 'u1',
    openingAmount: 500,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    summary: null,
    openedAt: new Date('2026-08-08T14:00:00.000Z'),
    closedAt: null,
    pendingPush: true,
    pushError: null,
    pendingClosePush: false,
    ...overrides,
  };
}

describe('CashSessionService (local-first)', () => {
  let service: CashSessionService;
  let http: HttpTestingController;
  let cashSessions: {
    getOpenLocal: ReturnType<typeof vi.fn>;
    createLocal: ReturnType<typeof vi.fn>;
    getLiveSummary: ReturnType<typeof vi.fn>;
    closeLocal: ReturnType<typeof vi.fn>;
    getPendingPush: ReturnType<typeof vi.fn>;
    getPendingClosePush: ReturnType<typeof vi.fn>;
    markCreateSynced: ReturnType<typeof vi.fn>;
    markCloseSynced: ReturnType<typeof vi.fn>;
    markPushFailed: ReturnType<typeof vi.fn>;
    markClosePushFailed: ReturnType<typeof vi.fn>;
    clearPushError: ReturnType<typeof vi.fn>;
    clearClosePushError: ReturnType<typeof vi.fn>;
    listLocal: ReturnType<typeof vi.fn>;
    updateAdjustmentStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    cashSessions = {
      getOpenLocal: vi.fn().mockResolvedValue(null),
      createLocal: vi.fn().mockResolvedValue(localSession()),
      getLiveSummary: vi.fn().mockResolvedValue({
        expectedCashAmount: 700,
        summary: {
          salesCount: 1,
          voidedCount: 0,
          byMethod: {
            cash: { count: 1, total: 200 },
            card: { count: 0, total: 0 },
            transfer: { count: 0, total: 0 },
            mixed: { count: 0, total: 0 },
          },
          movements: {
            deposits: { count: 0, total: 0 },
            withdrawals: { count: 0, total: 0 },
            expenses: { count: 0, total: 0 },
          },
          grandTotal: 200,
          cashInDrawer: 700,
        },
      }),
      closeLocal: vi.fn().mockResolvedValue(localSession({ closedAt: new Date(), pendingPush: false })),
      getPendingPush: vi.fn().mockResolvedValue([]),
      getPendingClosePush: vi.fn().mockResolvedValue([]),
      markCreateSynced: vi.fn().mockResolvedValue(undefined),
      markCloseSynced: vi.fn().mockResolvedValue(undefined),
      markPushFailed: vi.fn().mockResolvedValue(undefined),
      markClosePushFailed: vi.fn().mockResolvedValue(undefined),
      clearPushError: vi.fn().mockResolvedValue(undefined),
      clearClosePushError: vi.fn().mockResolvedValue(undefined),
      listLocal: vi.fn().mockResolvedValue([]),
      updateAdjustmentStatus: vi.fn().mockResolvedValue(undefined),
    };
    window.electronAPI = {
      getAppVersion: vi.fn(),
      getDeviceInfo: vi.fn(),
      openCashDrawer: vi.fn(),
      catalog: {
        search: vi.fn(),
        getByBarcode: vi.fn(),
        recordStockEntry: vi.fn(),
        upsertMany: vi.fn(),
        getPendingStockEntries: vi.fn(),
        markStockEntrySynced: vi.fn(),
        markStockEntryPushFailed: vi.fn(),
      },
      sales: {},
      sync: { getStatus: vi.fn(), recordRun: vi.fn() },
      cashSessions,
      cashMovements: {},
    } as unknown as Window['electronAPI'];

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CashSessionService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('refreshCurrent', () => {
    it('sin turno local abierto deja `current` en null y `isOpen` en false', () => {
      service.refreshCurrent('u1').subscribe();
      expect(cashSessions.getOpenLocal).toHaveBeenCalledWith('u1');
      expect(service.current()).toBeNull();
      expect(service.isOpen()).toBe(false);
    });

    it('con turno local abierto marca `isOpen` en true — sin ninguna llamada HTTP', async () => {
      cashSessions.getOpenLocal.mockResolvedValue(localSession());
      service.refreshCurrent('u1').subscribe();
      await flushMicrotasks();
      expect(service.current()?.id).toBe('local-1');
      expect(service.isOpen()).toBe(true);
      http.expectNone(`${BASE}/current`);
    });
  });

  describe('openLocal', () => {
    it('escribe local sin red y deja el turno como abierto', async () => {
      service.openLocal('u1', 'cajero@test.com', 500).subscribe();
      expect(cashSessions.createLocal).toHaveBeenCalledWith({
        openedBy: 'u1',
        openedByLabel: 'cajero@test.com',
        openingAmount: 500,
      });
      await flushMicrotasks();
      expect(service.isOpen()).toBe(true);
      http.expectNone(BASE);
    });
  });

  describe('liveSummary', () => {
    it('calcula el efectivo esperado en vivo sin red', async () => {
      let result: { expectedCashAmount: number } | undefined;
      service.liveSummary('local-1').subscribe((value) => (result = value));
      await flushMicrotasks();
      expect(result?.expectedCashAmount).toBe(700);
      http.expectNone(`${BASE}/local-1/summary`);
    });
  });

  describe('closeLocal', () => {
    it('cierra local y limpia `current` — el cierre siempre procede', () => {
      service.closeLocal('local-1', 700, 'u1', 'cajero@test.com').subscribe();
      expect(cashSessions.closeLocal).toHaveBeenCalledWith('local-1', {
        countedCashAmount: 700,
        closedBy: 'u1',
        closedByLabel: 'cajero@test.com',
      });
      expect(service.current()).toBeNull();
      expect(service.isOpen()).toBe(false);
      http.expectNone(`${BASE}/local-1/close`);
    });
  });

  describe('autoCloseForExpiry', () => {
    it('sin turno abierto no hace nada', async () => {
      await service.autoCloseForExpiry('u1');
      expect(cashSessions.closeLocal).not.toHaveBeenCalled();
    });

    it('con turno abierto cierra con el esperado — nunca deja ajuste pendiente', async () => {
      cashSessions.getOpenLocal.mockResolvedValue(localSession());
      await service.autoCloseForExpiry('u1', 'cajero@test.com');
      expect(cashSessions.closeLocal).toHaveBeenCalledWith('local-1', {
        countedCashAmount: 700,
        closedBy: 'u1',
        closedByLabel: 'cajero@test.com',
        autoClosedByExpiry: true,
      });
    });

    it('un error no se propaga: nunca debe bloquear el logout por expiración', async () => {
      cashSessions.getOpenLocal.mockRejectedValue(new Error('SQLite ocupada'));
      await expect(service.autoCloseForExpiry('u1')).resolves.toBeUndefined();
    });
  });

  /**
   * El cajero que sale "sin cerrar turno" puede retomarlo el mismo día. Si no
   * vuelve y cambia el día (hora CDMX), la caja lo cierra sola con el efectivo
   * que hubiera hasta ese momento: nadie puede contar hoy el cajón de ayer, así
   * que nunca deja ajuste pendiente.
   */
  describe('turno rezagado de un día anterior', () => {
    // Fecha muy anterior a propósito: la prueba no debe depender del día en
    // que se ejecute ni del desfase entre UTC y la hora de Ciudad de México.
    const ayer = new Date('2026-01-15T20:00:00.000Z');

    it('un turno del mismo día se respeta: el cajero sigue vendiendo en él', async () => {
      cashSessions.getOpenLocal.mockResolvedValue(localSession({ openedAt: new Date() }));

      const cerrado = await service.autoCloseStale('u1');

      expect(cerrado).toBe(false);
      expect(cashSessions.closeLocal).not.toHaveBeenCalled();
    });

    it('un turno de ayer se cierra solo, con el efectivo esperado y sin ajuste', async () => {
      cashSessions.getOpenLocal.mockResolvedValue(localSession({ openedAt: ayer }));

      const cerrado = await service.autoCloseStale('u1', 'cajero@test.com');

      expect(cerrado).toBe(true);
      expect(cashSessions.closeLocal).toHaveBeenCalledWith('local-1', {
        countedCashAmount: 700,
        closedBy: 'u1',
        closedByLabel: 'cajero@test.com',
        autoClosedByExpiry: true,
      });
    });

    it('sin turno abierto no hace nada', async () => {
      cashSessions.getOpenLocal.mockResolvedValue(null);
      expect(await service.autoCloseStale('u1')).toBe(false);
    });

    it('refreshCurrent lo cierra antes de entregar el turno: nadie opera sobre uno vencido', async () => {
      cashSessions.getOpenLocal
        .mockResolvedValueOnce(localSession({ openedAt: ayer }))
        .mockResolvedValueOnce(null);

      let entregado: CashSession | null | undefined;
      service.refreshCurrent('u1').subscribe((session) => (entregado = session));
      await flushMicrotasks();

      expect(cashSessions.closeLocal).toHaveBeenCalled();
      expect(entregado).toBeNull();
      expect(service.isOpen()).toBe(false);
    });

    it('un fallo del cierre rezagado no impide leer el turno ni operar la caja', async () => {
      cashSessions.getOpenLocal.mockResolvedValue(localSession({ openedAt: ayer }));
      cashSessions.closeLocal.mockRejectedValue(new Error('SQLite ocupada'));

      await expect(service.autoCloseStale('u1')).resolves.toBe(false);
    });
  });

  describe('flushQueue — alta', () => {
    it('sin turno abierto remoto, crea uno nuevo y persiste el remoteId de inmediato', async () => {
      cashSessions.getPendingPush.mockResolvedValue([
        { id: 'local-1', openingAmount: 500, pushError: null },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/current`).flush({ data: null });
      await flushMicrotasks();
      const createRequest = http.expectOne(BASE);
      expect(createRequest.request.method).toBe('POST');
      createRequest.flush({ data: { id: 'remote-1' } });
      await flushMicrotasks();

      expect(cashSessions.markCreateSynced).toHaveBeenCalledWith('local-1', 'remote-1');
    });

    it('defensa anti-duplicado: si ya hay un turno abierto remoto, adopta su id sin crear otro', async () => {
      cashSessions.getPendingPush.mockResolvedValue([
        { id: 'local-1', openingAmount: 500, pushError: null },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/current`).flush({ data: { id: 'remote-existing' } });
      await flushMicrotasks();

      expect(cashSessions.markCreateSynced).toHaveBeenCalledWith('local-1', 'remote-existing');
      http.expectNone(BASE);
    });
  });

  describe('flushQueue — cierre', () => {
    it('sube el cierre de una sesión ya remota y guarda los valores autoritativos', async () => {
      cashSessions.getPendingPush.mockResolvedValue([]);
      cashSessions.getPendingClosePush.mockResolvedValue([
        { id: 'local-1', remoteId: 'remote-1', countedCashAmount: 700, autoClosedByExpiry: false, closePushError: null },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      const closeRequest = http.expectOne(`${BASE}/remote-1/close`);
      expect(closeRequest.request.body).toEqual({ countedCashAmount: 700, autoClosedByExpiry: false });
      closeRequest.flush({ data: { session: { expectedCashAmount: 700, cashDifference: 0 } } });
      await flushMicrotasks();

      expect(cashSessions.markCloseSynced).toHaveBeenCalledWith('local-1', {
        expectedCashAmount: 700,
        cashDifference: 0,
      });
    });
  });

  /**
   * Regresión de producción: P2002 "Unique constraint failed on the fields:
   * (remoteId)". El turno de ayer seguía abierto en el backend porque su
   * cierre no había subido, así que `GET /cash-sessions/current` devolvía ese
   * turno para el alta de hoy y dos filas locales peleaban por el mismo id.
   */
  describe('flushQueue — orden: el cierre pendiente va antes que el alta nueva', () => {
    it('libera el turno remoto cerrándolo antes de crear el siguiente', async () => {
      const orden: string[] = [];
      cashSessions.getPendingClosePush.mockImplementation(async () =>
        cashSessions.markCloseSynced.mock.calls.length
          ? []
          : [{ id: 'ayer', remoteId: 'remote-1', countedCashAmount: 500, autoClosedByExpiry: false }],
      );
      cashSessions.getPendingPush.mockResolvedValue([{ id: 'hoy', openingAmount: 400, pushError: null }]);

      service.flushQueue();
      await flushMicrotasks();

      const cierre = http.expectOne(`${BASE}/remote-1/close`);
      orden.push('cierre');
      cierre.flush({ data: { session: { expectedCashAmount: 500, cashDifference: 0 } } });
      await flushMicrotasks();

      // Recién ahora se consulta el turno abierto remoto: ya no hay ninguno.
      const consulta = http.expectOne(`${BASE}/current`);
      orden.push('consulta-current');
      consulta.flush({ data: null });
      await flushMicrotasks();

      const alta = http.expectOne(BASE);
      orden.push('alta');
      alta.flush({ data: { id: 'remote-2' } });
      await flushMicrotasks();

      expect(orden).toEqual(['cierre', 'consulta-current', 'alta']);
      expect(cashSessions.markCreateSynced).toHaveBeenCalledWith('hoy', 'remote-2');
    });

    it('no reintenta el mismo cierre en la segunda pasada del ciclo', async () => {
      // El segundo barrido existe para los turnos que acaban de recibir su
      // `remoteId`; repetir un cierre ya subido daría 409 y lo marcaría como
      // rechazo permanente sin serlo.
      cashSessions.getPendingClosePush.mockResolvedValue([
        { id: 'ayer', remoteId: 'remote-1', countedCashAmount: 500, autoClosedByExpiry: false },
      ]);
      cashSessions.getPendingPush.mockResolvedValue([]);

      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/close`).flush({ data: { session: {} } });
      await flushMicrotasks();

      http.expectNone(`${BASE}/remote-1/close`);
      expect(cashSessions.markCloseSynced).toHaveBeenCalledTimes(1);
    });
  });

  describe('flushQueue — manejo de fallos', () => {
    it('un rechazo permanente (4xx) bloquea la fila para que no se reintente sola', async () => {
      cashSessions.getPendingPush.mockResolvedValue([{ id: 'local-1', openingAmount: 500, pushError: null }]);
      cashSessions.getPendingClosePush.mockResolvedValue([]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/current`).flush(
        { error: { message: 'Ya tienes un turno abierto' } },
        { status: 409, statusText: 'Conflict' },
      );
      await flushMicrotasks();

      expect(cashSessions.markPushFailed).toHaveBeenCalledWith('local-1', expect.any(String));
      expect(cashSessions.markCreateSynced).not.toHaveBeenCalled();
    });

    it('un fallo transitorio (5xx) NO bloquea la fila: se reintenta en el siguiente ciclo', async () => {
      cashSessions.getPendingPush.mockResolvedValue([{ id: 'local-1', openingAmount: 500, pushError: null }]);
      cashSessions.getPendingClosePush.mockResolvedValue([]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/current`).flush(null, { status: 503, statusText: 'Service Unavailable' });
      await flushMicrotasks();

      expect(cashSessions.markPushFailed).not.toHaveBeenCalled();
    });

    it('un 401 tampoco bloquea la fila (la sesión caducó, no es culpa del turno)', async () => {
      cashSessions.getPendingPush.mockResolvedValue([{ id: 'local-1', openingAmount: 500, pushError: null }]);
      cashSessions.getPendingClosePush.mockResolvedValue([]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/current`).flush(null, { status: 401, statusText: 'Unauthorized' });
      await flushMicrotasks();

      expect(cashSessions.markPushFailed).not.toHaveBeenCalled();
    });

    it('un cierre 409 "ya cerrado" se da por sincronizado, no como rechazo', async () => {
      cashSessions.getPendingPush.mockResolvedValue([]);
      cashSessions.getPendingClosePush.mockResolvedValue([
        { id: 'local-1', remoteId: 'remote-1', countedCashAmount: 700, autoClosedByExpiry: false, closePushError: null },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/close`).flush(
        { error: { message: 'El turno ya está cerrado' } },
        { status: 409, statusText: 'Conflict' },
      );
      await flushMicrotasks();

      expect(cashSessions.markCloseSynced).toHaveBeenCalledWith('local-1', {});
      expect(cashSessions.markClosePushFailed).not.toHaveBeenCalled();
    });

    it('un cierre rechazado marca solo el error de cierre, nunca reencola el alta', async () => {
      cashSessions.getPendingPush.mockResolvedValue([]);
      cashSessions.getPendingClosePush.mockResolvedValue([
        { id: 'local-1', remoteId: 'remote-1', countedCashAmount: 700, autoClosedByExpiry: false, closePushError: null },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/close`).flush(
        { error: { message: 'Counted cash amount inválido' } },
        { status: 400, statusText: 'Bad Request' },
      );
      await flushMicrotasks();

      expect(cashSessions.markClosePushFailed).toHaveBeenCalledWith('local-1', expect.any(String));
      expect(cashSessions.markPushFailed).not.toHaveBeenCalled();
    });

    it('dos flush simultáneos no duplican el push (guardia de reentrancia)', async () => {
      cashSessions.getPendingPush.mockResolvedValue([{ id: 'local-1', openingAmount: 500, pushError: null }]);
      cashSessions.getPendingClosePush.mockResolvedValue([]);
      service.flushQueue();
      service.flushQueue();
      await flushMicrotasks();

      // Una sola consulta de defensa anti-duplicado, no dos.
      http.expectOne(`${BASE}/current`).flush({ data: null });
      await flushMicrotasks();
      http.expectOne(BASE).flush({ data: { id: 'remote-1' } });
      await flushMicrotasks();

      expect(cashSessions.markCreateSynced).toHaveBeenCalledTimes(1);
    });
  });

  describe('pullAdjustmentStatus — el POS solo lee lo que el admin ya resolvió', () => {
    it('refleja en local el estado que el backend reporta como resuelto', async () => {
      cashSessions.listLocal.mockResolvedValue([
        localSession({ id: 'local-1', remoteId: 'remote-1', adjustmentStatus: 'pending' }),
      ]);
      service.pullAdjustmentStatus();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/summary`).flush({
        data: {
          session: {
            adjustmentStatus: 'approved',
            adjustmentReviewedBy: 'uid-admin',
            adjustmentReviewedAt: '2026-09-06T10:00:00.000Z',
            adjustmentNote: 'Faltante autorizado',
          },
        },
      });
      await flushMicrotasks();

      expect(cashSessions.updateAdjustmentStatus).toHaveBeenCalledWith('local-1', {
        status: 'approved',
        reviewedBy: 'uid-admin',
        reviewedAt: '2026-09-06T10:00:00.000Z',
        note: 'Faltante autorizado',
      });
    });

    it('si el backend sigue diciendo "pending", no escribe nada en local', async () => {
      cashSessions.listLocal.mockResolvedValue([
        localSession({ id: 'local-1', remoteId: 'remote-1', adjustmentStatus: 'pending' }),
      ]);
      service.pullAdjustmentStatus();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/summary`).flush({ data: { session: { adjustmentStatus: 'pending' } } });
      await flushMicrotasks();

      expect(cashSessions.updateAdjustmentStatus).not.toHaveBeenCalled();
    });

    it('un turno pendiente que todavía no sincronizó no se consulta (no tiene remoteId)', async () => {
      cashSessions.listLocal.mockResolvedValue([
        localSession({ id: 'local-1', remoteId: null, adjustmentStatus: 'pending' }),
      ]);
      service.pullAdjustmentStatus();
      await flushMicrotasks();

      http.expectNone(() => true);
      expect(cashSessions.updateAdjustmentStatus).not.toHaveBeenCalled();
    });

    it('un fallo de red no rompe el pull ni escribe estado a medias', async () => {
      cashSessions.listLocal.mockResolvedValue([
        localSession({ id: 'local-1', remoteId: 'remote-1', adjustmentStatus: 'pending' }),
      ]);
      service.pullAdjustmentStatus();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/summary`).flush(null, { status: 500, statusText: 'Server Error' });
      await flushMicrotasks();

      expect(cashSessions.updateAdjustmentStatus).not.toHaveBeenCalled();
    });
  });

  describe('auditoría admin', () => {
    it('listAudit consulta el backend (todas las cajas), no el SQLite de este equipo', async () => {
      const sesiones: CashSession[] = [];
      service.listAudit().subscribe((page) => sesiones.push(...page.items));
      await flushMicrotasks();

      const request = http.expectOne((req) => req.url === BASE);
      expect(request.request.params.keys()).toHaveLength(0);
      request.flush({ data: [localSession({ id: 'remote-x' })] });

      expect(sesiones).toHaveLength(1);
      expect(cashSessions.listLocal).not.toHaveBeenCalled();
    });

    /**
     * El backend manda `Timestamp` serializado (`{_seconds}`) y uids. Sin mapeo,
     * la pantalla pintaba fechas vacías y el uid crudo como nombre del cajero.
     */
    it('listAudit mapea fechas de Firestore y el nombre de quien operó el turno', async () => {
      let page: { items: { openedAt: Date; closedAt: Date | null; openedByLabel: string | null }[] } | null =
        null;
      service.listAudit().subscribe((result) => (page = result));
      await flushMicrotasks();

      http.expectOne((req) => req.url === BASE).flush({
        data: [
          {
            id: 'remote-x',
            openedBy: 'uid-1',
            openedByLabel: 'Ana Cajera',
            closedBy: 'uid-1',
            closedByLabel: 'Ana Cajera',
            openingAmount: 0,
            expectedCashAmount: 45,
            countedCashAmount: 500,
            cashDifference: 455,
            openedAt: { _seconds: 1_757_000_000, _nanoseconds: 0 },
            closedAt: { _seconds: 1_757_020_000, _nanoseconds: 0 },
          },
        ],
      });

      const [corte] = page!.items;
      expect(corte.openedAt).toBeInstanceOf(Date);
      expect(corte.closedAt).toBeInstanceOf(Date);
      expect(corte.openedByLabel).toBe('Ana Cajera');
    });

    it('listAudit traslada los filtros como query params', async () => {
      service.listAudit({ from: '2026-09-01', to: '2026-09-30', openedBy: 'u1', adjustmentStatus: 'pending' }).subscribe();
      await flushMicrotasks();

      const request = http.expectOne((req) => req.url === BASE);
      expect(request.request.params.get('from')).toBe('2026-09-01');
      expect(request.request.params.get('to')).toBe('2026-09-30');
      expect(request.request.params.get('openedBy')).toBe('u1');
      expect(request.request.params.get('adjustmentStatus')).toBe('pending');
      request.flush({ data: [] });
    });

    it('reviewAdjustment manda la decisión y la nota al endpoint del backend', async () => {
      service.reviewAdjustment('remote-1', 'approved', 'Faltante autorizado').subscribe();
      await flushMicrotasks();

      const request = http.expectOne(`${BASE}/remote-1/adjustment/review`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ decision: 'approved', note: 'Faltante autorizado' });
      request.flush({ data: localSession({ adjustmentStatus: 'approved' }) });
    });

    it('reviewAdjustment sin nota manda la decisión igual', async () => {
      service.reviewAdjustment('remote-1', 'rejected').subscribe();
      await flushMicrotasks();

      const request = http.expectOne(`${BASE}/remote-1/adjustment/review`);
      expect(request.request.body).toEqual({ decision: 'rejected', note: undefined });
      request.flush({ data: localSession({ adjustmentStatus: 'rejected' }) });
    });

    it('la aprobación NUNCA se escribe en local: solo la resuelve el backend', async () => {
      service.reviewAdjustment('remote-1', 'approved').subscribe();
      await flushMicrotasks();
      http.expectOne(`${BASE}/remote-1/adjustment/review`).flush({ data: localSession() });
      await flushMicrotasks();

      expect(cashSessions.updateAdjustmentStatus).not.toHaveBeenCalled();
      expect(cashSessions.closeLocal).not.toHaveBeenCalled();
    });
  });
});
