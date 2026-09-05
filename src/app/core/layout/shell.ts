import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MenuItem } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MenuModule } from 'primeng/menu';
import { PopoverModule } from 'primeng/popover';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TooltipModule } from 'primeng/tooltip';
import { filter, map } from 'rxjs';

import { AuthService } from '../auth/auth.service';
import { ApiHealthService } from '../health/api-health.service';
import { NotificationService } from '../notifications/notification.service';
import { CashSessionDialog } from '../../features/pos/cash-session/cash-session-dialog';
import { CashSessionService } from '../../features/pos/services/cash-session.service';
import { SaleService } from '../../features/pos/services/sale.service';
import { SyncScheduler } from '../sync/sync-scheduler.service';
import { environment } from '../../../environments/environment';
import { NAV_ITEMS } from './nav.config';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    TranslatePipe,
    ButtonModule,
    DialogModule,
    MenuModule,
    PopoverModule,
    ProgressSpinnerModule,
    TooltipModule,
    CashSessionDialog,
  ],
  templateUrl: './shell.html',
  host: {
    '(document:keydown.f1)': 'goToSale($event)',
    '(document:keydown.f3)': 'goToHistory($event)',
  },
})
export class Shell {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly health = inject(ApiHealthService);
  private readonly syncScheduler = inject(SyncScheduler);
  private readonly notifications = inject(NotificationService);
  private readonly saleService = inject(SaleService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly translate = inject(TranslateService);

  /** Turno abierto de este cajero — para preguntar si se cierra al hacer logout. */
  readonly openCashSession = this.cashSessionService.current;
  /** Visible mientras el cajero cuenta/cierra su turno desde el flujo de logout. */
  readonly logoutCashSessionDialogVisible = signal(false);
  /** Las tres opciones al salir con turno abierto (ver `logout()`). */
  readonly logoutPromptVisible = signal(false);
  /**
   * El diálogo se abrió por la X de la ventana, no por "Cerrar sesión": al
   * terminar hay que cerrar la app (y **no** cerrar la sesión de Firebase, para
   * que la siguiente apertura no pida contraseña otra vez).
   */
  readonly closingApp = signal(false);

  /** Solo lo que el rol puede abrir: un enlace que devuelve 403 no es navegación. */
  readonly navItems = computed(() =>
    NAV_ITEMS.filter(
      (item) => !item.permission || this.authService.can(item.permission.area, item.permission.level),
    ),
  );
  /** Lo que el cajero toca todo el turno: siempre visible como botón directo. */
  readonly primaryNavItems = computed(() =>
    this.navItems().filter((item) => (item.group ?? 'primary') === 'primary'),
  );
  /** Pantallas de administración/consulta ocasional: agrupadas detrás de "Más". */
  readonly secondaryNavItems = computed(() => this.navItems().filter((item) => item.group === 'secondary'));

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  /** Resalta el botón "Más" cuando la pantalla activa vive dentro del menú, no en la barra. */
  readonly isSecondaryActive = computed(() =>
    this.secondaryNavItems().some((item) => this.currentUrl().startsWith(item.path)),
  );
  readonly secondaryMenuItems = computed<MenuItem[]>(() =>
    this.secondaryNavItems().map((item) => ({
      label: this.translate.instant(item.labelKey),
      icon: item.icon,
      routerLink: item.path,
    })),
  );

  readonly userMenuItems = computed<MenuItem[]>(() => {
    const email = this.user()?.email;
    const items: MenuItem[] = [];
    if (email) {
      items.push({ label: email, icon: 'pi pi-envelope', disabled: true });
      items.push({ separator: true });
    }
    items.push({
      label: this.translate.instant('auth.logout'),
      icon: 'pi pi-sign-out',
      command: () => void this.logout(),
    });
    return items;
  });

  readonly user = this.authService.user;
  readonly role = this.authService.role;
  /**
   * Nombre del rol tal como lo define el backend (`roles.name`). Los slugs ya no son
   * un enum de dos valores, así que traducir por clave dejaría "shell.role.manager"
   * a la vista; el nombre del documento siempre viene en español.
   */
  readonly roleLabel = computed(() => this.authService.roleName() || this.role() || '');
  readonly isAdmin = this.authService.isAdmin;
  readonly browserOnline = this.health.browserOnline;
  readonly degraded = this.health.degraded;
  readonly appVersion = environment.version;
  /**
   * `environment.isElectron` solo cambia con `ng build --configuration electron`;
   * `electron:dev` corre la app contra el `ng serve` normal (`isElectron: false`)
   * dentro de una ventana de Electron real. Lo que de verdad importa aquí es si
   * el preload expuso `window.electronAPI`, no la config de build.
   */
  readonly isElectron = !!window.electronAPI;

  /** Sincronizando ahora mismo (botón manual o el modal al iniciar sesión). */
  readonly syncing = this.syncScheduler.syncing;
  /** Puntito en el botón: hay ventas que aún no suben. Nada de texto permanente en pantalla. */
  readonly hasPendingSync = computed(() => this.saleService.pendingCount() > 0);

  /**
   * El sync automático ya no se dispara aquí. `Shell` se monta también cuando
   * la sesión de Firebase persiste de una corrida anterior (el cajero nunca
   * tocó el formulario de login) — el disparo real vive en `Login.onSubmit()`,
   * justo tras un inicio de sesión explícito.
   */
  /**
   * El cajero puede forzar la sincronización una vez por hora; el admin, siempre.
   * La regla vive en `SyncScheduler` (que además la persiste): aquí solo se
   * consulta para no ofrecer un botón que va a rebotar.
   */
  readonly canSyncManually = computed(() =>
    this.syncScheduler.canSyncManually(this.user()?.uid ?? '', this.isAdmin()),
  );
  readonly nextManualSyncAt = computed(() =>
    this.isAdmin() ? null : this.syncScheduler.manualSyncAvailableAt(this.user()?.uid ?? ''),
  );

  constructor() {
    const api = window.electronAPI;
    if (api) {
      const off = api.app.onCloseRequested(() => this.onWindowCloseRequested());
      inject(DestroyRef).onDestroy(off);
    }
  }

  syncNow(): void {
    const blockedUntil = this.nextManualSyncAt();
    if (blockedUntil) {
      this.notifications.error(
        `Ya sincronizaste hace poco. Podrás volver a hacerlo a las ${this.formatTime(blockedUntil)}.`,
      );
      return;
    }
    const pending = this.saleService.pendingCount();
    // El conteo solo se muestra aquí, al ir a sincronizar — no como badge fijo en pantalla.
    const detail = pending > 0 ? `Hay ${pending} venta(s) pendiente(s) de sincronizar. ` : '';
    if (!window.confirm(`${detail}¿Sincronizar ahora? Se subirán las ventas pendientes y se traerá el catálogo más reciente.`)) {
      return;
    }
    void this.runSync();
  }

  formatTime(date: Date): string {
    return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  private async runSync(): Promise<void> {
    const result = await this.syncScheduler.syncManually(
      this.user()?.uid ?? '',
      this.isAdmin(),
    );
    if (result.ok) {
      this.notifications.success(`Catálogo sincronizado (${result.pulled} cambios).`);
    } else {
      this.notifications.error(result.errorMessage || 'No se pudo sincronizar el catálogo.');
    }
  }

  /**
   * Cierre de la ventana de Electron. No se cierra en seco: con turno abierto se
   * ofrecen los mismos tres caminos que al cerrar sesión (cortar caja y salir,
   * salir dejando el turno abierto, cancelar), y con ventas en cola se avisa.
   * La sesión de Firebase se conserva: cerrar la app no es cambiar de cajero.
   */
  private onWindowCloseRequested(): void {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    if (this.openCashSession()) {
      // Avisa que hay alguien atendiendo: contar el efectivo tarda más que
      // cualquier timeout razonable del proceso principal.
      void api.app.closePending();
      this.closingApp.set(true);
      this.logoutPromptVisible.set(true);
      return;
    }
    const pending = this.saleService.pendingCount();
    if (pending > 0) {
      void api.app.closePending();
      const salir = window.confirm(
        `Hay ${pending} venta(s) sin sincronizar. Se enviarán la próxima vez que abras la app. ¿Salir de todas formas?`,
      );
      if (!salir) {
        void api.app.cancelClose();
        return;
      }
    }
    void api.app.confirmClose();
  }

  goToSale(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/pos']);
  }

  goToHistory(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/pos/historial']);
  }

  /**
   * Con turno abierto, salir no es una pregunta de sí/no: son tres caminos
   * distintos (quedarse, salir dejando el turno abierto, o cortar caja antes
   * de salir), así que se pregunta con un diálogo propio y no con el
   * `window.confirm` del sistema, que solo ofrece dos.
   */
  async logout(): Promise<void> {
    if (this.openCashSession()) {
      this.logoutPromptVisible.set(true);
      return;
    }
    await this.finishLogout();
  }

  /** "Cancelar": no se cierra sesión, ni se toca el turno, ni se cierra la app. */
  dismissLogoutPrompt(): void {
    this.logoutPromptVisible.set(false);
    if (this.closingApp()) {
      this.closingApp.set(false);
      void window.electronAPI?.app.cancelClose();
    }
  }

  /**
   * "Salir sin cerrar turno": el turno queda abierto y se puede retomar hoy
   * mismo. Si el cajero no vuelve y cambia el día, `autoCloseStale()` lo
   * cierra solo con el efectivo que hubiera hasta ese momento.
   */
  async logoutLeavingShiftOpen(): Promise<void> {
    this.logoutPromptVisible.set(false);
    await this.finishLogout();
  }

  /** "Cerrar turno": abre el corte. El logout espera a que termine. */
  closeShiftBeforeLogout(): void {
    this.logoutPromptVisible.set(false);
    this.logoutCashSessionDialogVisible.set(true);
  }

  /**
   * El cajero cerró el modal del corte sin cortar (Cancelar, la ×, Esc): **solo**
   * se cierra el modal. No se cierra sesión ni se toca el turno — antes esto se
   * deducía de si quedaba turno abierto, y un turno cerrado por otra vía (el
   * auto-cierre por cambio de día) hacía que cancelar sacara al cajero.
   */
  dismissLogoutCashSession(): void {
    this.logoutCashSessionDialogVisible.set(false);
    // Desistir del corte también cancela la salida: si no, el intento de cierre
    // quedaba vivo y la app se cerraba sola al vencer el plazo del proceso principal.
    if (this.closingApp()) {
      this.closingApp.set(false);
      void window.electronAPI?.app.cancelClose();
    }
  }

  /** El corte se confirmó: recién entonces se completa la salida. */
  onLogoutShiftClosed(): void {
    this.logoutCashSessionDialogVisible.set(false);
    void this.finishLogout();
  }

  private async finishLogout(): Promise<void> {
    // Salida por la X: se cierra la app conservando la sesión. Cerrar sesión
    // aquí obligaría a teclear la contraseña al abrir mañana, que no es lo que
    // pidió quien solo cerró la ventana.
    if (this.closingApp()) {
      this.closingApp.set(false);
      await window.electronAPI?.app.confirmClose();
      return;
    }
    await this.authService.logout();
    await this.router.navigate(['/login']);
  }
}
