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
import { BlockedSyncRecord } from '../electron/window.d';
import { BlockedSyncService } from '../sync/blocked-sync.service';
import { describeBlocked } from '../sync/sync-diagnosis';
import { SyncHelpReply, SyncHelpService } from '../sync/sync-help.service';
import { NotificationService } from '../notifications/notification.service';
import { CashSessionDialog } from '../../features/pos/cash-session/cash-session-dialog';
import { CashMovementService } from '../../features/pos/services/cash-movement.service';
import { CashSessionService } from '../../features/pos/services/cash-session.service';
import { SaleService } from '../../features/pos/services/sale.service';
import { SyncScheduler } from '../sync/sync-scheduler.service';
import { environment } from '../../../environments/environment';
import { NAV_ITEMS, NavItem } from './nav.config';

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
  private readonly blockedSync = inject(BlockedSyncService);
  private readonly syncScheduler = inject(SyncScheduler);
  private readonly notifications = inject(NotificationService);
  private readonly saleService = inject(SaleService);
  private readonly cashMovementService = inject(CashMovementService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly translate = inject(TranslateService);

  /** Turno abierto de este cajero — para preguntar si se cierra al hacer logout. */
  readonly openCashSession = this.cashSessionService.current;
  /** Visible mientras el cajero cuenta/cierra su turno desde el flujo de logout. */
  readonly logoutCashSessionDialogVisible = signal(false);
  /** Las tres opciones al salir con turno abierto (ver `logout()`). */
  readonly logoutPromptVisible = signal(false);
  /**
   * Subiendo lo pendiente antes de salir. Sin este aviso la app se queda unos
   * segundos sin responder al pulsar "Cerrar sesión" y parece colgada.
   */
  readonly flushingBeforeExit = signal(false);

  /** Registros que el servidor rechazó: se avisan aparte de los pendientes. */
  readonly blockedCount = this.blockedSync.count;
  readonly blockedRecords = this.blockedSync.records;
  /** Cada registro con su causa en palabras del cajero y qué hacer primero. */
  readonly blockedItems = computed(() =>
    this.blockedRecords().map((record) => ({ record, help: describeBlocked(record) })),
  );
  readonly blockedDialogVisible = signal(false);

  openBlocked(): void {
    this.blockedDialogVisible.set(true);
    void this.blockedSync.refresh();
  }

  private readonly syncHelp = inject(SyncHelpService);

  /**
   * Ayuda con IA por registro (llave `kind:id`). Solo para lo que las reglas
   * locales no reconocen, y solo con red: sin conexión la IA no responde, y las
   * causas conocidas ya traen su explicación sin preguntarle a nadie.
   */
  readonly aiHelp = signal<Record<string, { loading: boolean; reply?: SyncHelpReply; error?: string }>>({});

  canAskAi(record: BlockedSyncRecord): boolean {
    return (record.diagnosis?.code ?? 'desconocido') === 'desconocido' && !this.health.degraded();
  }

  aiHelpFor(record: BlockedSyncRecord) {
    return this.aiHelp()[`${record.kind}:${record.id}`];
  }

  async askAi(record: BlockedSyncRecord): Promise<void> {
    const key = `${record.kind}:${record.id}`;
    if (this.aiHelp()[key]?.loading) {
      return;
    }
    this.aiHelp.update((estado) => ({ ...estado, [key]: { loading: true } }));
    try {
      const reply = await this.syncHelp.ask(record);
      this.aiHelp.update((estado) => ({ ...estado, [key]: { loading: false, reply } }));
    } catch (error: unknown) {
      const mensaje = error instanceof Error ? error.message : 'La ayuda con IA no está disponible.';
      this.aiHelp.update((estado) => ({ ...estado, [key]: { loading: false, error: mensaje } }));
    }
  }

  /** Registro que se está reintentando: deshabilita sus botones mientras viaja. */
  readonly retryingBlockedId = signal<string | null>(null);

  /**
   * Destraba y **empuja en el acto**, en el orden completo del sincronizador
   * (catálogo → turnos → ventas). Antes solo se limpiaba el `pushError`: el
   * registro esperaba al próximo horario fijo (hasta seis horas) y al cajero le
   * parecía que el botón no hacía nada. Empujar solo las ventas tampoco bastaba:
   * si lo que faltaba era el turno o un producto, la venta volvía a esperar.
   * `flushPendingNow` no gasta el cupo del sync manual: reintentar no es
   * sincronizar a mano.
   */
  async retryBlocked(record: BlockedSyncRecord): Promise<void> {
    this.retryingBlockedId.set(record.id);
    try {
      await this.blockedSync.retry(record);
      await this.syncScheduler.flushPendingNow();
      await this.blockedSync.refresh();
    } catch (error: unknown) {
      this.notifications.error(
        error instanceof Error ? error.message : 'No se pudo reintentar el registro.',
      );
    } finally {
      this.retryingBlockedId.set(null);
    }
    this.closeBlockedIfEmpty();
  }

  canFixBlocked(record: BlockedSyncRecord): boolean {
    return this.blockedSync.canFix(record);
  }

  canDiscardBlocked(record: BlockedSyncRecord): boolean {
    return this.blockedSync.canDiscard(record);
  }

  /** Abre el gasto en su pantalla, ya cargado para corregirlo. */
  fixBlocked(record: BlockedSyncRecord): void {
    this.blockedDialogVisible.set(false);
    void this.router.navigate(['/pos/gastos'], { queryParams: { corregir: record.id } });
  }

  /**
   * Borrar es irreversible y puede ser dinero ya cobrado: se confirma nombrando
   * el registro, no con un "¿estás seguro?" genérico.
   */
  async discardBlocked(record: BlockedSyncRecord): Promise<void> {
    const confirmado = window.confirm(
      `¿Descartar "${record.label}" (${record.detail})?\n\n` +
        'Se borra de este equipo y nunca llegará al servidor. ' +
        'Si ya se cobró o se pagó, quedará sin registro.',
    );
    if (!confirmado) {
      return;
    }
    try {
      await this.blockedSync.discard(record);
      this.notifications.success('Registro descartado.');
    } catch (error: unknown) {
      this.notifications.error(
        error instanceof Error ? error.message : 'No se pudo descartar el registro.',
      );
    }
    this.closeBlockedIfEmpty();
  }

  private closeBlockedIfEmpty(): void {
    if (this.blockedCount() === 0) {
      this.blockedDialogVisible.set(false);
    }
  }
  /**
   * El diálogo se abrió por la X de la ventana, no por "Cerrar sesión": al
   * terminar hay que cerrar la app (y **no** cerrar la sesión de Firebase, para
   * que la siguiente apertura no pida contraseña otra vez).
   */
  readonly closingApp = signal(false);

  /** Solo lo que el rol puede abrir: un enlace que devuelve 403 no es navegación. */
  readonly navItems = computed(() =>
    NAV_ITEMS.filter(
      (item) =>
        item.enabled !== false &&
        (!item.permission || this.authService.can(item.permission.area, item.permission.level)),
    ),
  );
  /** Lo que se toca a cada rato: siempre visible como botón directo. */
  readonly barNavItems = computed(() => this.navItems().filter((item) => (item.group ?? 'bar') === 'bar'));
  /** Menú "Catálogo": cómo se clasifica la mercancía y quién la surte. */
  readonly catalogNavItems = computed(() => this.navItems().filter((item) => item.group === 'catalog'));
  /** Menú "Inventario": qué entra, con qué factura, y el maestro de productos. */
  readonly inventoryNavItems = computed(() =>
    this.navItems().filter((item) => item.group === 'inventory'),
  );
  /**
   * Menú "Administración": lo que el mostrador **no** puede hacer. Para un
   * cajero queda vacío —`navItems` ya filtró por permiso— y el botón no se
   * pinta: su barra se ve igual de simple que antes de separar los grupos.
   */
  readonly adminNavItems = computed(() => this.navItems().filter((item) => item.group === 'admin'));

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  /** Resalta el botón del menú cuando la pantalla activa vive dentro, no en la barra. */
  private isGroupActive(items: NavItem[]): boolean {
    return items.some((item) => this.currentUrl().startsWith(item.path));
  }
  readonly isCatalogGroupActive = computed(() => this.isGroupActive(this.catalogNavItems()));
  readonly isInventoryGroupActive = computed(() => this.isGroupActive(this.inventoryNavItems()));
  readonly isAdminGroupActive = computed(() => this.isGroupActive(this.adminNavItems()));

  private toMenuItems(items: NavItem[]): MenuItem[] {
    return items.map((item) => ({
      label: this.translate.instant(item.labelKey),
      icon: item.icon,
      routerLink: item.path,
    }));
  }
  readonly catalogMenuItems = computed<MenuItem[]>(() => this.toMenuItems(this.catalogNavItems()));
  readonly inventoryMenuItems = computed<MenuItem[]>(() =>
    this.toMenuItems(this.inventoryNavItems()),
  );
  readonly adminMenuItems = computed<MenuItem[]>(() => this.toMenuItems(this.adminNavItems()));

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
  /** Puntito en el botón: hay ventas o gastos que aún no suben. */
  readonly hasPendingSync = computed(
    () => this.saleService.pendingCount() > 0 || this.cashMovementService.pendingCount() > 0,
  );

  /**
   * El sync automático ya no se dispara aquí. `Shell` se monta también cuando
   * la sesión de Firebase persiste de una corrida anterior (el cajero nunca
   * tocó el formulario de login) — el disparo real vive en `Login.onSubmit()`,
   * justo tras un inicio de sesión explícito.
   */
  /**
   * El cajero puede forzar la sincronización cada 15 minutos; el admin, siempre.
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
      // Al abrir la caja: un rechazo de ayer no puede esperar a que alguien
      // pulse Sincronizar para hacerse visible.
      void this.blockedSync.refresh();
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
    const ventas = this.saleService.pendingCount();
    const gastos = this.cashMovementService.pendingCount();
    const partes: string[] = [];
    if (ventas > 0) {
      partes.push(`${ventas} venta(s)`);
    }
    if (gastos > 0) {
      partes.push(`${gastos} gasto(s)`);
    }
    const detail =
      partes.length > 0 ? `Hay ${partes.join(' y ')} pendiente(s) de sincronizar. ` : '';
    if (
      !window.confirm(
        `${detail}¿Sincronizar ahora? Se subirán ventas, gastos y lo demás pendiente, y se traerá el catálogo.`,
      )
    ) {
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
    if (!result.ok) {
      this.notifications.error(result.errorMessage || 'No se pudo sincronizar.');
      await this.blockedSync.refresh();
      return;
    }
    const pending = await this.syncScheduler.countPending().catch(() => 0);
    if (pending > 0) {
      this.notifications.error(
        `Catálogo actualizado (${result.pulled} cambios), pero quedan ${pending} movimiento(s) sin subir. Revisa los rechazados o vuelve a intentar.`,
      );
    } else {
      this.notifications.success(`Sincronizado (${result.pulled} cambios de catálogo).`);
    }
    await this.blockedSync.refresh();
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
    void this.closeAfterFlush(api);
  }

  /**
   * Antes se avisaba de lo pendiente pero no se intentaba subirlo, y el conteo
   * solo miraba las ventas: un corte de caja o una entrada de mercancía sin
   * sincronizar salían del equipo en silencio. Ahora se intenta el envío y solo
   * se pregunta por lo que de verdad quedó.
   */
  private async closeAfterFlush(api: NonNullable<Window['electronAPI']>): Promise<void> {
    if ((await this.syncScheduler.countPending()) === 0) {
      void api.app.confirmClose();
      return;
    }

    // El proceso principal no puede esperar indefinidamente: avisa que hay
    // trabajo antes de ponerse a subir.
    void api.app.closePending();
    const pending = await this.flushBeforeLeaving();
    if (pending > 0) {
      const salir = window.confirm(
        `Quedan ${pending} movimiento(s) sin sincronizar (ventas, cortes, entradas o gastos). ` +
          'Se enviarán la próxima vez que abras la app. ¿Salir de todas formas?',
      );
      if (!salir) {
        void api.app.cancelClose();
        return;
      }
    }
    void api.app.confirmClose();
  }

  /**
   * Intenta subir todo lo que queda en cola y devuelve lo que sobrevivió al
   * intento. Sin red no hay nada que hacer —el push fallaría entero—, así que
   * se salta el envío y se reporta el pendiente tal cual.
   */
  private async flushBeforeLeaving(): Promise<number> {
    this.flushingBeforeExit.set(true);
    try {
      if (this.browserOnline()) {
        await this.syncScheduler.flushPendingNow();
      }
      return await this.syncScheduler.countPending();
    } catch {
      // Un fallo del envío no puede dejar al cajero encerrado: se reporta lo que
      // haya en cola y él decide.
      return this.syncScheduler.countPending().catch(() => 0);
    } finally {
      this.flushingBeforeExit.set(false);
    }
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

  /**
   * Cerrar sesión no revisaba nada: lo que quedara en cola se iba con el equipo
   * y el siguiente cajero heredaba ventas, cortes y gastos ajenos sin subir. Se
   * intenta el envío y, si algo sobrevive, se pregunta antes de salir.
   *
   * Devuelve `false` solo si el cajero decide quedarse.
   */
  private async confirmPendingBeforeLogout(): Promise<boolean> {
    if (!window.electronAPI || (await this.syncScheduler.countPending()) === 0) {
      return true;
    }
    const pending = await this.flushBeforeLeaving();
    if (pending === 0) {
      return true;
    }
    return window.confirm(
      `Quedan ${pending} movimiento(s) sin sincronizar (ventas, cortes, entradas o gastos). ` +
        'Se enviarán cuando este equipo vuelva a tener red. ¿Cerrar sesión de todas formas?',
    );
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

  /**
   * "Cerrar turno": mismo motor que el botón Sincronizar (sube ventas, gastos,
   * productos, entradas y trae el catálogo), con el turno todavía abierto, y
   * luego abre el corte. Sin el tope de 15 min del cajero: al cortar no se puede
   * posponer. Si se cerrara antes de subir, el servidor rechazaría esos POST.
   */
  async closeShiftBeforeLogout(): Promise<void> {
    this.logoutPromptVisible.set(false);
    this.flushingBeforeExit.set(true);
    try {
      if (this.browserOnline()) {
        await this.syncScheduler.syncNow();
      }
      const pending = await this.syncScheduler.countPending();
      if (pending > 0) {
        this.notifications.error(
          this.browserOnline()
            ? `Quedan ${pending} movimiento(s) sin sincronizar (ventas, gastos, productos o entradas). ` +
              'Hay red, pero el servidor no los confirmó. Revisa los rechazados o pulsa Sincronizar; ' +
              'puedes cerrar el turno igual.'
            : `Quedan ${pending} movimiento(s) sin sincronizar (ventas, gastos, productos o entradas). ` +
              'Sin red se reintentarán al volver a conectar; puedes cerrar el turno igual.',
        );
      }
      await this.blockedSync.refresh();
    } catch {
      const pending = await this.syncScheduler.countPending().catch(() => 0);
      if (pending > 0) {
        this.notifications.error(
          `Quedan ${pending} movimiento(s) sin sincronizar. Puedes cerrar el turno igual.`,
        );
      }
    } finally {
      this.flushingBeforeExit.set(false);
    }
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
    // Único punto por el que pasan los tres caminos de salida (cerrar sesión,
    // salir dejando el turno abierto y salir tras cortar caja), así que la
    // comprobación de pendientes vive aquí y no en cada uno.
    if (!(await this.confirmPendingBeforeLogout())) {
      if (this.closingApp()) {
        this.closingApp.set(false);
        void window.electronAPI?.app.cancelClose();
      }
      return;
    }

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
