import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { EMPTY } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CashSession } from '../../shared/models';
import { CashSessionService } from '../../features/pos/services/cash-session.service';
import { SaleService } from '../../features/pos/services/sale.service';
import { ApiHealthService } from '../health/api-health.service';
import { AuthService } from '../auth/auth.service';
import { NotificationService } from '../notifications/notification.service';
import { SyncScheduler } from '../sync/sync-scheduler.service';
import { NAV_ITEMS } from './nav.config';
import { Shell } from './shell';

describe('Shell', () => {
  let fixture: ComponentFixture<Shell>;
  let component: Shell;
  let navigate: ReturnType<typeof vi.fn>;
  let logout: ReturnType<typeof vi.fn>;
  let can: (area: string, level?: string) => boolean;
  let turnoAbierto: CashSession | null;
  let electronApp: {
    onCloseRequested: ReturnType<typeof vi.fn>;
    closePending: ReturnType<typeof vi.fn>;
    confirmClose: ReturnType<typeof vi.fn>;
    cancelClose: ReturnType<typeof vi.fn>;
  };
  /** Handler que el shell registró para la X de la ventana. */
  let cerrarSolicitado: (() => void) | null;

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        {
          provide: Router,
          useValue: { navigate, createUrlTree: () => ({}), serializeUrl: () => '', events: EMPTY, url: '/pos' },
        },
        {
          provide: AuthService,
          useValue: {
            user: signal({ email: 'caja@farmajyv.mx' }),
            role: signal('cashier'),
            roleName: signal('Cajero'),
            isAdmin: signal(false),
            can: (area: string, level?: string) => can(area, level),
            logout,
          },
        },
        {
          provide: ApiHealthService,
          useValue: { browserOnline: signal(true), degraded: signal(false) },
        },
        {
          // Evita construir la cadena real SyncScheduler -> SaleService -> HttpClient:
          // estas pruebas no ejercitan el sync, solo el resto del shell.
          provide: SyncScheduler,
          useValue: { syncing: signal(false), syncNow: vi.fn().mockResolvedValue({ ok: true, pulled: 0 }) },
        },
        { provide: NotificationService, useValue: { success: vi.fn(), error: vi.fn() } },
        {
          provide: CashSessionService,
          useValue: { current: () => turnoAbierto, isOpen: () => turnoAbierto !== null },
        },
        { provide: SaleService, useValue: { pendingCount: signal(0) } },
      ],
    });

    fixture = TestBed.createComponent(Shell);
    component = fixture.componentInstance;
  }

  beforeEach(async () => {
    // Doble de la ventana de Electron: `onCloseRequested` guarda el handler para
    // poder disparar la X desde la prueba.
    cerrarSolicitado = null;
    electronApp = {
      onCloseRequested: vi.fn((handler: () => void) => {
        cerrarSolicitado = handler;
        return () => undefined;
      }),
      closePending: vi.fn().mockResolvedValue(undefined),
      confirmClose: vi.fn().mockResolvedValue(undefined),
      cancelClose: vi.fn().mockResolvedValue(undefined),
    };
    (window as unknown as { electronAPI?: unknown }).electronAPI = { app: electronApp };
    navigate = vi.fn(() => Promise.resolve(true));
    logout = vi.fn(() => Promise.resolve());
    can = () => true;
    turnoAbierto = null;
    await build();
  });

  it('con todos los permisos muestra el menú completo', () => {
    expect(component.navItems()).toHaveLength(NAV_ITEMS.length);
  });

  it('oculta los enlaces cuyo permiso no tiene el rol: un enlace que da 403 no es navegación', async () => {
    can = (area) => area !== 'inventory';
    await build();

    expect(component.navItems().some((item) => item.path === '/pos/libro-control')).toBe(false);
  });

  it('el nombre del rol viene del backend, no de una llave i18n', () => {
    expect(component.roleLabel()).toBe('Cajero');
  });

  it('F1 lleva a la venta y F3 al historial', () => {
    const event = new KeyboardEvent('keydown');
    component.goToSale(event);
    expect(navigate).toHaveBeenCalledWith(['/pos']);

    component.goToHistory(event);
    expect(navigate).toHaveBeenCalledWith(['/pos/historial']);
  });

  it('cerrar sesión termina la sesión y manda al login', async () => {
    await component.logout();

    expect(logout).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  /**
   * Cerrar la ventana con la X no puede llevarse por delante un turno a medias:
   * se pregunta primero. Y no cierra la sesión de Firebase — cerrar la app no es
   * cambiar de cajero.
   */
  describe('cerrar la ventana de la app', () => {
    it('sin turno ni pendientes cierra directo', () => {
      cerrarSolicitado?.();

      expect(electronApp.confirmClose).toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
    });

    it('con turno abierto pregunta en vez de cerrar', async () => {
      turnoAbierto = { id: 's1' } as CashSession;
      await build();

      cerrarSolicitado?.();

      expect(component.logoutPromptVisible()).toBe(true);
      expect(electronApp.confirmClose).not.toHaveBeenCalled();
      // Avisa al proceso principal que hay alguien decidiendo: contar el efectivo
      // tarda más que cualquier timeout de emergencia.
      expect(electronApp.closePending).toHaveBeenCalled();
    });

    it('"salir sin cerrar turno" cierra la app pero conserva la sesión', async () => {
      turnoAbierto = { id: 's1' } as CashSession;
      await build();
      cerrarSolicitado?.();

      await component.logoutLeavingShiftOpen();

      expect(electronApp.confirmClose).toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalledWith(['/login']);
    });

    it('cancelar deja la app abierta', async () => {
      turnoAbierto = { id: 's1' } as CashSession;
      await build();
      cerrarSolicitado?.();

      component.dismissLogoutPrompt();

      expect(electronApp.cancelClose).toHaveBeenCalled();
      expect(electronApp.confirmClose).not.toHaveBeenCalled();
    });

    /**
     * Desistir del corte también cancela la salida: si no, el intento quedaba vivo
     * y la app se cerraba sola al vencer el plazo del proceso principal.
     */
    it('cerrar el modal del corte sin cortar cancela la salida', async () => {
      turnoAbierto = { id: 's1' } as CashSession;
      await build();
      cerrarSolicitado?.();
      component.closeShiftBeforeLogout();

      component.dismissLogoutCashSession();

      expect(electronApp.cancelClose).toHaveBeenCalled();
      expect(electronApp.confirmClose).not.toHaveBeenCalled();
    });

    it('cerrar sesión desde el menú sí termina la sesión', async () => {
      await component.logout();

      expect(logout).toHaveBeenCalled();
      expect(electronApp.confirmClose).not.toHaveBeenCalled();
    });
  });

  /**
   * Salir con el turno abierto ofrece tres caminos, no un sí/no: quedarse,
   * salir dejando el turno abierto, o cortar caja antes de salir.
   */
  describe('salir con turno abierto', () => {
    beforeEach(async () => {
      turnoAbierto = { id: 's1' } as CashSession;
      await build();
    });

    it('no cierra sesión de inmediato: abre las opciones', async () => {
      await component.logout();

      expect(component.logoutPromptVisible()).toBe(true);
      expect(logout).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalledWith(['/login']);
    });

    it('cancelar deja todo como estaba: ni logout ni corte', () => {
      void component.logout();

      component.dismissLogoutPrompt();

      expect(component.logoutPromptVisible()).toBe(false);
      expect(component.logoutCashSessionDialogVisible()).toBe(false);
      expect(logout).not.toHaveBeenCalled();
    });

    it('salir sin cerrar turno hace logout y no abre el corte', async () => {
      void component.logout();

      await component.logoutLeavingShiftOpen();

      expect(component.logoutCashSessionDialogVisible()).toBe(false);
      expect(logout).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/login']);
    });

    it('cerrar turno abre el corte y todavía NO cierra la sesión', () => {
      void component.logout();

      component.closeShiftBeforeLogout();

      expect(component.logoutPromptVisible()).toBe(false);
      expect(component.logoutCashSessionDialogVisible()).toBe(true);
      expect(logout).not.toHaveBeenCalled();
    });

    it('cuando el corte se confirma, sale', async () => {
      void component.logout();
      component.closeShiftBeforeLogout();

      turnoAbierto = null;
      component.onLogoutShiftClosed();
      await Promise.resolve();
      await Promise.resolve();

      expect(logout).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/login']);
    });

    it('si el cajero cancela el corte, se queda en la caja con su turno', async () => {
      void component.logout();
      component.closeShiftBeforeLogout();

      // El turno sigue abierto: el corte se canceló.
      component.dismissLogoutCashSession();
      await Promise.resolve();

      expect(component.logoutCashSessionDialogVisible()).toBe(false);
      expect(logout).not.toHaveBeenCalled();
    });

    it('cancelar no cierra sesión ni aunque el turno ya no esté abierto', async () => {
      void component.logout();
      component.closeShiftBeforeLogout();

      // El turno pudo cerrarse por otra vía (auto-cierre por cambio de día).
      // Cancelar sigue siendo solo "cerrar el modal".
      turnoAbierto = null;
      component.dismissLogoutCashSession();
      await Promise.resolve();

      expect(component.logoutCashSessionDialogVisible()).toBe(false);
      expect(logout).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalledWith(['/login']);
    });

    it('el corte recibe el turno abierto del cajero', () => {
      expect(component.openCashSession()).toEqual({ id: 's1' });
    });
  });

  it('sin turno abierto no pregunta nada: sale directo', async () => {
    await component.logout();

    expect(component.logoutPromptVisible()).toBe(false);
    expect(logout).toHaveBeenCalled();
  });
});
