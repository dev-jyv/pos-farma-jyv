import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { of } from 'rxjs';
import { Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashMovement, CashSession, PermissionArea, StaffProfile, hasPermission } from '../../../shared/models';
import { CashMovementService } from '../services/cash-movement.service';
import { CashSessionService } from '../services/cash-session.service';
import { ExpensesAudit } from '../expenses/audit/expenses-audit';

const BASE = `${environment.apiUrl}/cash-sessions`;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function profileFor(slug: string, areas: PermissionArea[]): StaffProfile {
  return {
    uid: 'u1',
    email: `${slug}@farmajyv.mx`,
    displayName: slug,
    role: { id: `r-${slug}`, name: slug, slug },
    permissions: areas.map((area) => ({ area, level: 'write' as const })),
  };
}

/**
 * Pruebas de seguridad del módulo de caja. No repiten la matriz de nav
 * (`nav.config.spec.ts`) ni los permisos del backend: cubren los tres modos en
 * que este cliente podría convertirse en el eslabón débil — escalar
 * privilegios desde el POS, resolver un ajuste sin pasar por el servidor, o
 * ejecutar texto que capturó un cajero.
 */
describe('seguridad — auditoría de caja y gastos', () => {
  describe('separación de privilegios', () => {
    it('operar la caja no concede auditarla ni aprobar ajustes', () => {
      const cajero = profileFor('cashier', ['pos', 'sales']);

      expect(hasPermission(cajero, 'pos', 'write')).toBe(true);
      expect(hasPermission(cajero, 'cashSessions', 'read')).toBe(false);
      expect(hasPermission(cajero, 'cashSessions', 'write')).toBe(false);
      expect(hasPermission(cajero, 'expenses', 'read')).toBe(false);
    });

    it('poder leer ventas no concede ver el dinero de todas las cajas', () => {
      const supervisor = profileFor('sales', ['sales', 'dashboard', 'inventory']);
      expect(hasPermission(supervisor, 'cashSessions', 'read')).toBe(false);
      expect(hasPermission(supervisor, 'expenses', 'read')).toBe(false);
    });

    it('leer la auditoría de cortes no concede aprobar el ajuste', () => {
      const auditor: StaffProfile = {
        ...profileFor('auditor', []),
        permissions: [{ area: 'cashSessions', level: 'read' }],
      };
      expect(hasPermission(auditor, 'cashSessions', 'read')).toBe(true);
      expect(hasPermission(auditor, 'cashSessions', 'write')).toBe(false);
    });

    it('las áreas de auditoría son independientes entre sí', () => {
      const soloCortes: StaffProfile = {
        ...profileFor('x', []),
        permissions: [{ area: 'cashSessions', level: 'write' }],
      };
      expect(hasPermission(soloCortes, 'expenses', 'read')).toBe(false);
    });
  });

  describe('la aprobación vive solo en el servidor', () => {
    let service: CashSessionService;
    let http: HttpTestingController;
    let cashSessions: {
      getPendingClosePush: Mock;
      getPendingPush: Mock;
      listLocal: Mock;
      updateAdjustmentStatus: Mock;
      closeLocal: Mock;
      markCloseSynced: Mock;
      [key: string]: Mock;
    };

    beforeEach(() => {
      cashSessions = {
        getOpenLocal: vi.fn().mockResolvedValue(null),
        createLocal: vi.fn(),
        getLiveSummary: vi.fn(),
        closeLocal: vi.fn(),
        getPendingPush: vi.fn().mockResolvedValue([]),
        getPendingClosePush: vi.fn().mockResolvedValue([]),
        markCreateSynced: vi.fn(),
        markCloseSynced: vi.fn().mockResolvedValue(undefined),
        markPushFailed: vi.fn(),
        markClosePushFailed: vi.fn(),
        clearPushError: vi.fn(),
        clearClosePushError: vi.fn(),
        listLocal: vi.fn().mockResolvedValue([]),
        updateAdjustmentStatus: vi.fn().mockResolvedValue(undefined),
      };
      window.electronAPI = {
        catalog: {},
        sales: {},
        sync: { getStatus: vi.fn(), recordRun: vi.fn() },
        cashSessions,
        cashMovements: {},
      } as unknown as Window['electronAPI'];

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
      service = TestBed.inject(CashSessionService);
      http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('el cierre que sube el POS no puede declarar el estado del ajuste', async () => {
      cashSessions.getPendingClosePush.mockResolvedValue([
        {
          id: 'local-1',
          remoteId: 'remote-1',
          countedCashAmount: 700,
          autoClosedByExpiry: false,
          // Aunque la fila local trajera un estado "aprobado" (base manipulada),
          // el push no lo lleva: el servidor decide.
          adjustmentStatus: 'approved',
          hasPendingAdjustment: false,
        },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      const request = http.expectOne(`${BASE}/remote-1/close`);
      expect(Object.keys(request.request.body as object)).toEqual(['countedCashAmount', 'autoClosedByExpiry']);
      request.flush({ data: { session: {} } });
      await flushMicrotasks();
    });

    it('el auto-cierre tampoco puede colarse como aprobado', async () => {
      cashSessions.getPendingClosePush.mockResolvedValue([
        { id: 'local-1', remoteId: 'remote-1', countedCashAmount: 700, autoClosedByExpiry: true },
      ]);
      service.flushQueue();
      await flushMicrotasks();

      const request = http.expectOne(`${BASE}/remote-1/close`);
      expect(request.request.body).not.toHaveProperty('adjustmentStatus');
      expect(request.request.body).not.toHaveProperty('hasPendingAdjustment');
      request.flush({ data: { session: {} } });
      await flushMicrotasks();
    });

    it('el pull sobrescribe con lo que dice el servidor, aunque la base local diga otra cosa', async () => {
      // Escenario de manipulación: alguien marcó el turno como aprobado en el
      // SQLite del equipo. El backend sigue diciendo "rechazado" y gana.
      cashSessions.listLocal.mockResolvedValue([
        { id: 'local-1', remoteId: 'remote-1', adjustmentStatus: 'pending' } as CashSession,
      ]);
      service.pullAdjustmentStatus();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/summary`).flush({
        data: { session: { adjustmentStatus: 'rejected', adjustmentReviewedBy: 'uid-admin' } },
      });
      await flushMicrotasks();

      expect(cashSessions.updateAdjustmentStatus).toHaveBeenCalledWith(
        'local-1',
        expect.objectContaining({ status: 'rejected' }),
      );
    });

    it('revisar un ajuste siempre pasa por el endpoint del backend, nunca por IPC', async () => {
      service.reviewAdjustment('remote-1', 'approved').subscribe();
      await flushMicrotasks();

      http.expectOne(`${BASE}/remote-1/adjustment/review`).flush({ data: {} });
      await flushMicrotasks();

      expect(cashSessions.updateAdjustmentStatus).not.toHaveBeenCalled();
      expect(cashSessions.closeLocal).not.toHaveBeenCalled();
    });
  });

  describe('texto capturado por el cajero se muestra como texto, no como marcado', () => {
    let fixture: ComponentFixture<ExpensesAudit>;

    const PELIGROSO = '<img src=x onerror="window.__xss=1">';

    beforeEach(async () => {
      const movimiento: CashMovement = {
        id: 'mov-1',
        cashSessionId: 's1',
        type: 'expense',
        amount: 100,
        reason: PELIGROSO,
        category: 'other',
        description: `<script>window.__xss=1</script>`,
        createdBy: 'u1',
        createdAt: new Date('2026-09-05T15:00:00.000Z'),
      };

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
          providePrimeNG({}),
          MessageService,
          { provide: NotificationService, useValue: { error: vi.fn(), success: vi.fn() } },
          {
            provide: CashMovementService,
            useValue: {
              listMovementsAudit: () =>
                of({ items: [movimiento], meta: { page: 1, limit: 50, total: 1, totalPages: 1 } }),
            },
          },
        ],
      });

      fixture = TestBed.createComponent(ExpensesAudit);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    });

    it('no inyecta elementos al DOM desde el motivo ni la descripción', () => {
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('img[onerror]')).toBeNull();
      expect(host.querySelector('script')).toBeNull();
      expect((window as unknown as Record<string, unknown>)['__xss']).toBeUndefined();
    });

    it('lo muestra literal, para que el admin vea exactamente lo que se capturó', () => {
      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).toContain(PELIGROSO);
    });
  });
});
