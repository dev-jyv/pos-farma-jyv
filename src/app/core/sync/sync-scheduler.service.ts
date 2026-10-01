import { HttpClient, HttpParams } from '@angular/common/http';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, from, map, of } from 'rxjs';

import { getApiErrorMessage } from '../api/api.utils';
import { ApiHealthService } from '../health/api-health.service';
import { CashMovementService } from '../../features/pos/services/cash-movement.service';
import { CashSessionService } from '../../features/pos/services/cash-session.service';
import { ProductCatalogService } from '../../features/pos/services/product-catalog.service';
import { SaleService } from '../../features/pos/services/sale.service';
import { StockEntryService } from '../../features/pos/services/stock-entry.service';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { pushOwnerFilter } from './push-owner';
import { PROMOTIONS_SYNCED_EVENT } from './sync-events';

/**
 * Cuánto espera el cajero entre dos sincronizaciones manuales. El admin no pasa
 * por aquí.
 */
const MANUAL_SYNC_COOLDOWN_MS = 15 * 60 * 1000;

/** Llave por usuario: dos cajeros en el mismo equipo no comparten el cupo. */
const manualSyncKey = (uid: string): string => `pos.last-manual-sync.${uid || 'anon'}`;

function formatTime(date: Date): string {
  return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Cada cuánto se revisan **solo** las promociones, aparte del sync completo. El
 * horario fijo deja huecos de hasta 14 h (20:00 → 10:30): una promo que el admin
 * da de baja a las 15:00 se seguía aplicando hasta las 20:00, y cada venta con
 * ella subía marcada para revisión. El pull de promociones es incremental y
 * pesa unos cuantos bytes, así que una vez por hora no le cuesta nada al
 * servidor.
 */
const PROMOTIONS_PULL_INTERVAL_MS = 60 * 60 * 1000;

/** Horarios fijos de sync, en hora local del equipo de caja. */
const FIXED_TIMES: Array<[number, number]> = [
  [10, 30],
  [14, 0],
  [20, 0],
];

/** Fila de un catálogo solo-pull: solo se necesita su `updatedAt` para el cursor. */
interface SyncCatalogItem {
  updatedAt?: unknown;
}

interface SyncProductsResponse {
  data: Array<{ updatedAt?: unknown }>;
}

/**
 * `updatedAt` viaja como `Timestamp` de Firestore, que por HTTP llega
 * `{ _seconds, _nanoseconds }` (no ISO string). A diferencia de `toDate()` en
 * `api.utils.ts`, esto devuelve `null` en vez de "ahora" ante un valor
 * inválido: un cursor mal calculado dejaría de traer productos reales.
 */
function parseTimestamp(value: unknown): Date | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (value && typeof value === 'object' && '_seconds' in value) {
    return new Date((value as { _seconds: number })._seconds * 1000);
  }
  return null;
}

export interface SyncOutcome {
  ok: boolean;
  pulled: number;
  errorMessage?: string;
  /** Presente cuando el límite del cajero rechazó la corrida manual. */
  blockedUntil?: Date;
}

/**
 * Orquesta el sync local-first en los 3 horarios fijos (más una corrida al
 * arrancar): jala el catálogo de `GET /products` (incremental, con
 * `updatedSince`) y empuja lo pendiente de ventas/altas de stock. El proceso
 * main de Electron nunca hace red — todo pasa por aquí, que ya tiene el token
 * de Firebase vía el interceptor de `HttpClient`.
 */
@Injectable({ providedIn: 'root' })
export class SyncScheduler {
  private readonly http = inject(HttpClient);
  private readonly saleService = inject(SaleService);
  private readonly stockEntryService = inject(StockEntryService);
  private readonly productCatalogService = inject(ProductCatalogService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly cashMovementService = inject(CashMovementService);
  private readonly apiHealth = inject(ApiHealthService);
  private readonly auth = inject(AuthService);
  private readonly apiUrl = environment.apiUrl;

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Pull liviano de promociones (ver `PROMOTIONS_PULL_INTERVAL_MS`). */
  private promotionsTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Pull de promociones en vuelo: el horario de cada hora y la autorrecuperación
   * del cobro pueden pedirlo a la vez, y ambos esperan la misma corrida en vez de
   * duplicar el fetch y la escritura en SQLite.
   */
  private promotionsPullInFlight: Promise<boolean> | null = null;
  /**
   * A diferencia de `flushQueue()` en `SaleService`/`StockEntryService`, que sí
   * tienen su propia bandera, `pullProducts()` no tenía guardia de reentrancia:
   * un sync manual y el horario fijo cayendo casi al mismo tiempo duplicaban el
   * fetch a `/products/sync` y la escritura en SQLite. Ambos llamadores ahora
   * comparten la misma promesa en vuelo.
   */
  private pullInFlight: Promise<SyncOutcome> | null = null;

  /** Para el botón/modal manual: si hay un pull en curso ahora mismo. */
  readonly syncing = signal(false);
  /**
   * Se está liquidando el turno que quedó abierto de un día anterior. Lo
   * enciende `settleStaleShift()` **solo cuando de verdad hay uno**, para que la
   * pantalla no parpadee en el caso normal, que es el 99 % de las entradas.
   */
  readonly settlingStaleShift = signal(false);
  /**
   * Última sincronización manual, por usuario. Persistida: si viviera en memoria,
   * cerrar y reabrir la app saltaría el límite del cajero.
   */
  private readonly lastManualSyncAt = signal<number | null>(null);
  /**
   * Tick al vencer el cupo del cajero. `manualSyncAvailableAt` compara contra
   * `Date.now()`, que no es reactivo: sin esto, el `computed` del botón no se
   * vuelve a evaluar y queda deshabilitado aunque el cooldown ya pasó.
   */
  private readonly cooldownEpoch = signal(0);
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resultado del último pull (manual o de horario), para mostrarlo en UI. */
  readonly lastOutcome = signal<SyncOutcome | null>(null);
  readonly lastSyncedAt = signal<Date | null>(null);

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.clearCooldownTimer();
      this.stop();
    });
  }

  /**
   * Solo arma el horario fijo (10:30/14:00/20:00). La corrida inmediata al
   * entrar es responsabilidad de `Shell` (con su modal) — si esta función
   * también disparara una aquí, quedarían dos pulls completos corriendo a la
   * vez (arranque de la app + login) y se duplicarían todas las páginas.
   */
  start(): void {
    // Igual que en `Shell`: se guía por `window.electronAPI` real, no por el
    // flag de build — `electron:dev` corre contra `ng serve` normal.
    if (this.timer || !window.electronAPI) {
      return;
    }
    this.scheduleNext();
    // Se arma junto con el horario fijo y por la misma razón: sin `electronAPI`
    // no hay SQLite donde guardar lo que baje.
    this.promotionsTimer = setInterval(() => void this.pullPromotions(), PROMOTIONS_PULL_INTERVAL_MS);
  }

  /** Desarma el horario fijo y el pull de promociones de cada hora. */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.promotionsTimer !== null) {
      clearInterval(this.promotionsTimer);
      this.promotionsTimer = null;
    }
  }

  /**
   * Pull **solo de promociones**, incremental (mismo cursor que el del sync
   * completo) y sin push. Lo corre el temporizador de cada hora y la caja cuando
   * el backend rechaza un cobro por una promo que ya cerró.
   *
   * - Sin sesión o sin `electronAPI` no hace nada: no hay token para el backend
   *   ni SQLite donde escribir.
   * - **No cuenta para el límite del botón "Sincronizar"**: ese cupo protege del
   *   pull del catálogo completo y del push de toda la cola, no de esto.
   * - Si ya hay un sync completo en curso, espera a ese en vez de pedir otro: el
   *   completo también baja las promociones y avisa al carrito.
   *
   * Devuelve `true` si las promociones quedaron al día (y se avisó al carrito).
   */
  pullPromotions(): Promise<boolean> {
    if (!window.electronAPI || !this.auth.user()) {
      return Promise.resolve(false);
    }
    if (this.promotionsPullInFlight) {
      return this.promotionsPullInFlight;
    }
    if (this.pullInFlight) {
      return this.pullInFlight.then(
        () => true,
        () => false,
      );
    }
    this.promotionsPullInFlight = this.doPullPromotions().finally(() => {
      this.promotionsPullInFlight = null;
    });
    return this.promotionsPullInFlight;
  }

  private async doPullPromotions(): Promise<boolean> {
    const ok = await this.pullCatalog('promotions', 'promotions', (items) =>
      window.electronAPI?.promotions?.upsertMany(items),
    );
    // Se avisa aunque falle: `PromoService` relee lo que haya en SQLite, que no
    // cambió, y quien espera la recarga no se queda colgado.
    window.dispatchEvent(new Event(PROMOTIONS_SYNCED_EVENT));
    return ok;
  }

  /** Corrida de horario/arranque: no bloquea a nadie, dispara y sigue. */
  runNow(): void {
    // Sin polling propio: aquí es donde de verdad importa saber si hay red.
    this.apiHealth.checkNow();
    void this.pullProducts();
    this.cashSessionService.pullAdjustmentStatus();
    void this.pushPending();
  }

  /**
   * Corrida al cerrar el turno de caja, para **cualquier** rol.
   *
   * Un corte recién hecho es justo lo que no debe quedarse en el equipo: es el
   * dinero contado del día y el turno que el backend necesita cerrado para
   * aceptar el siguiente. Se dispara aquí y no al cerrar el modal porque el
   * cajero puede quedarse imprimiendo el corte (o irse sin cerrarlo).
   *
   * **No pasa por el límite entre sincronizaciones manuales**: ese tope existe
   * para el botón "Sincronizar" del mostrador, no para un evento del negocio que
   * ocurre una vez por turno.
   */
  syncAfterShiftClose(): void {
    void this.syncAfterShiftCloseAsync();
  }

  /**
   * Liquida el turno que quedó abierto de un día anterior, **antes** de que la
   * caja vuelva a operar.
   *
   * Sustituye al auto-cierre de medianoche. Aquel cerraba el turno con la app a
   * punto de expirar la sesión y sin nadie delante: el cierre entraba a la cola
   * junto con gastos y ventas que aún no habían subido, y los rezagados morían
   * en 400 contra un turno ya cerrado, sin que nadie viera el error.
   *
   * Aquí el orden está garantizado y es el punto entero de este método:
   *
   * 1. se cierra el turno **en local** con el efectivo esperado (nadie puede
   *    contar hoy el cajón de ayer, así que nunca deja ajuste pendiente);
   * 2. `pushPending` sube en su orden —movimientos, ventas, anulaciones— y deja
   *    el cierre para el final;
   * 3. hasta que eso termina no se ofrece abrir el turno nuevo.
   *
   * Devuelve `true` solo si de verdad había un turno rezagado, para que la
   * pantalla sepa si tiene que mostrar el bloqueo.
   */
  async settleStaleShift(userId: string, userLabel?: string): Promise<boolean> {
    if (!window.electronAPI || !userId) {
      return false;
    }
    const cerrado = await this.cashSessionService.autoCloseStale(userId, userLabel);
    if (!cerrado) {
      return false;
    }
    // El bloqueo se enciende **aquí**, no antes: encenderlo al empezar hacía
    // parpadear el modal en cada entrada a Ventas, incluso cuando no había
    // ningún turno rezagado que liquidar.
    this.settlingStaleShift.set(true);
    try {
      // El push va aquí y no en `autoCloseStale`: ese método corre también en el
      // camino de lectura del turno, donde no se puede esperar a la red.
      await this.pushPending();
    } finally {
      this.settlingStaleShift.set(false);
    }
    return true;
  }

  /**
   * Igual, pero **esperable**: el corte no debe darse por terminado en pantalla
   * mientras sus movimientos, ventas y el propio cierre siguen viajando. Si el
   * cajero avanza antes, se lleva la impresión de un corte que el servidor
   * todavía no tiene, y un fallo de red aparece cuando ya no está mirando.
   *
   * Solo espera el **push**: el pull del catálogo se dispara aparte y tarda,
   * y nada del corte depende de él.
   */
  async syncAfterShiftCloseAsync(): Promise<void> {
    // Sin `electronAPI` no hay colas locales que subir (la app corre en el
    // navegador, todo va contra el backend en tiempo real).
    if (!window.electronAPI) {
      return;
    }
    this.apiHealth.checkNow();
    void this.pullProducts();
    this.cashSessionService.pullAdjustmentStatus();
    await this.pushPending();
  }

  /**
   * Todo lo que sigue en cola local, no solo las ventas: turnos y sus cierres,
   * productos del catálogo, entradas de stock y movimientos de caja. Se lee de
   * las colas (IPC) y no de los contadores en memoria porque varios de esos
   * servicios no publican ninguno, y salir creyendo que "solo faltaban ventas"
   * dejaba un corte o una entrada de mercancía sin subir.
   *
   * Cada cola falla por su cuenta: si una consulta revienta, cuenta 0 en vez de
   * tumbar el conteo entero — el objetivo es avisar, no bloquear la salida.
   *
   * **Se cuenta con el mismo filtro con el que se sube.** Sin él, el conteo veía
   * las colas de TODOS los cajeros del equipo y el empuje solo subía las del
   * que está en sesión (`pushOwnerFilter`): el residuo no bajaba nunca, así que
   * al salir aparecía "quedan N movimientos sin sincronizar" en cada intento, y
   * era imposible de resolver — el aviso además prometía que se enviarían solos,
   * cosa que para el cajero que está delante no iba a pasar. Lo de otro cajero
   * sube cuando entra ese cajero, o cuando entra un admin (que no lleva filtro).
   */
  async countPending(): Promise<number> {
    const api = window.electronAPI;
    if (!api) {
      return 0;
    }
    const owner = pushOwnerFilter(this.auth);
    const queues = await Promise.allSettled([
      api.sales.getPendingPush(owner),
      api.sales.getPendingVoided(),
      /**
       * Anulaciones que el servidor todavía no aplicó. No aparecían en este
       * conteo, así que el aviso de salida decía "0 pendientes" con una venta
       * viva en el servidor que en la caja ya estaba anulada.
       */
      api.sales.getNeedingRemoteVoid(),
      api.catalog.getPendingCatalogPush(),
      api.catalog.getPendingStockEntries(),
      api.cashMovements.getPendingPush(owner),
      api.cashSessions.getPendingPush(owner),
      api.cashSessions.getPendingClosePush(owner),
    ]);
    return queues.reduce(
      (total, queue) => total + (queue.status === 'fulfilled' ? queue.value.length : 0),
      0,
    );
  }

  /**
   * Empuje **esperable**, para el camino de salida: `syncNow()` dispara el push
   * sin esperarlo (`void this.pushPending()`) porque su trabajo visible es traer
   * el catálogo. Al cerrar sesión o la app no hay después: hay que esperar.
   * También lo usa "Reintentar" en el panel de rechazados, que necesita el orden
   * completo (catálogo y turnos antes que ventas) y no debe gastar el cupo manual.
   */
  async flushPendingNow(): Promise<void> {
    if (!window.electronAPI) {
      return;
    }
    await this.pushPending();
  }

  /**
   * Empuja en **orden**, no en paralelo: catálogo → entradas de stock →
   * gastos/ventas → cierres de turno → altas de turno → gastos/ventas otra vez.
   *
   * Los cierres van **antes** de las altas y **después** de los hijos. Cerrar
   * antes que los hijos los condena ("el turno de caja ya está cerrado"); abrir
   * antes de cerrar el anterior choca contra el único turno abierto que admite
   * el backend ("el turno remoto ya pertenece a otro turno de este equipo").
   * Ambos errores se vieron en producción.
   *
   * El turno va primero porque tanto los movimientos de caja (gastos, depósitos,
   * retiros) como las ventas necesitan que su `CashSession` ya tenga `remoteId`
   * — `POST /cash-sessions/:id/movements` y el `cashSessionId` del payload de
   * venta no existen sin eso. Una venta de un producto recién dado de alta
   * necesita que ese producto ya exista en el servidor (o el backend responde
   * "producto no encontrado"), y una venta que consumió mercancía recién
   * recibida necesita que su entrada de stock haya subido antes (o responde
   * "stock insuficiente"). Saliendo todos a la vez, la venta perdía la carrera
   * y quedaba rechazada.
   */
  private pushPending(): Promise<void> {
    /**
     * **Un solo empuje a la vez.** El orden de abajo solo vale dentro de una
     * corrida: cuatro sitios pueden arrancar una (el horario, el botón de
     * sincronizar, el cierre de turno y la salida de sesión), y dos corridas
     * solapadas lo rompen — el ciclo A ya subió el cierre cuando el B llega a su
     * paso de movimientos, y el servidor responde "el turno de caja ya está
     * cerrado" a un gasto que estaba en cola desde antes de cerrar. Se vio en
     * producción: un `POST /movements` en rojo justo después del `close`.
     *
     * Encadenar y no descartar: quien llega mientras hay una corrida espera a
     * que termine y arranca la suya, porque puede traer trabajo que la primera
     * ya no alcanzó a ver.
     */
    this.pushChain = this.pushChain
      .catch(() => undefined)
      .then(() => this.runPush());
    return this.pushChain;
  }

  private pushChain: Promise<void> = Promise.resolve();

  private async runPush(): Promise<void> {
    // Cada cajero sube lo suyo: el backend rechaza el turno de otro con 403 y
    // el POS lo mostraba como un "rechazado" que ese cajero no podía resolver.
    const owner = pushOwnerFilter(this.auth);

    // 1) Catálogo y entradas primero: una venta de un producto recién dado de
    //    alta necesita que ese producto exista arriba, y una que consumió
    //    mercancía recién recibida necesita su entrada de stock.
    await this.productCatalogService.flushQueueAsync();
    await this.stockEntryService.flushQueueAsync();

    // 2) Hijos de los turnos que **ya existen** en el servidor. Van antes que
    //    los cierres: un turno cerrado no acepta movimientos ni ventas.
    await this.cashMovementService.flushQueueAsync(owner);
    await this.saleService.flushQueueAsync();

    // 3) Cierres, ya con sus hijos arriba. Además liberan el hueco del cajero:
    //    el backend admite un turno abierto por persona, así que el alta del
    //    turno nuevo (paso 4) fallaría con "el turno remoto ya pertenece a otro
    //    turno de este equipo" si el anterior siguiera abierto allá.
    await this.cashSessionService.flushClosesAsync(owner);

    // 4) Altas de turnos nuevos, con el hueco ya libre.
    await this.cashSessionService.flushQueueAsync(owner);

    // 5) Segunda pasada de hijos: los de los turnos que acaban de nacer en el
    //    paso 4 no tenían `remoteId` cuando corrió el paso 2.
    await this.cashMovementService.flushQueueAsync(owner);
    await this.saleService.flushQueueAsync();
  }


  /**
   * Corrida manual (botón "sincronizar ahora" o el modal de inicio de sesión):
   * expone `syncing`/`lastOutcome` para que la UI muestre progreso y espere.
   * El push de ventas/altas pendientes sigue disparándose aparte (su propio
   * estado ya se ve en el banner de pendientes): esto solo bloquea por el pull,
   * que es lo que de verdad importa tener fresco antes de vender.
   */
  /**
   * Sincronización manual con la regla de uso: el cajero puede forzarla **una vez
   * cada 15 minutos**, el admin sin límite.
   *
   * El tope no es capricho: el pull trae el catálogo completo y el push recorre
   * toda la cola, así que un botón sin freno en el mostrador se convierte en
   * decenas de corridas por turno contra el mismo servidor. El admin sí lo
   * necesita libre — es quien resuelve un problema de sincronización en el
   * momento, y esperar una hora sería el bloqueo, no la protección.
   *
   * Las corridas automáticas (horarios fijos y la de inicio de sesión) no
   * consumen ni consultan este cupo: el límite es sobre el botón, no sobre el
   * hecho de sincronizar.
   */
  canSyncManually(uid: string, isAdmin: boolean): boolean {
    return isAdmin || this.manualSyncAvailableAt(uid) === null;
  }

  /**
   * Momento en que el cajero podrá volver a sincronizar a mano, o `null` si ya
   * puede. Devuelve `null` siempre que no haya corrida manual previa.
   */
  manualSyncAvailableAt(uid: string): Date | null {
    this.cooldownEpoch();
    const last = this.readLastManualSync(uid);
    if (last === null) {
      return null;
    }
    const availableAt = last + MANUAL_SYNC_COOLDOWN_MS;
    if (availableAt > Date.now()) {
      this.armCooldownTimer(availableAt);
      return new Date(availableAt);
    }
    return null;
  }

  /**
   * Corrida manual del botón. Aplica el límite del cajero y, si pasa, registra el
   * momento para que la siguiente espere su turno.
   */
  async syncManually(uid: string, isAdmin: boolean): Promise<SyncOutcome> {
    const availableAt = isAdmin ? null : this.manualSyncAvailableAt(uid);
    if (availableAt) {
      return {
        ok: false,
        pulled: 0,
        errorMessage: `Ya sincronizaste hace poco. Podrás volver a hacerlo a las ${formatTime(availableAt)}.`,
        blockedUntil: availableAt,
      };
    }
    const outcome = await this.syncNow();
    // Se marca aunque falle: un servidor caído no se arregla reintentando cada
    // segundo desde el mostrador, y el horario fijo sigue corriendo igual.
    this.rememberManualSync(uid);
    return outcome;
  }

  async syncNow(): Promise<SyncOutcome> {
    this.apiHealth.checkNow();
    this.cashSessionService.pullAdjustmentStatus();

    // Antes el push iba en `void` y el botón pintaba éxito solo con el pull del
    // catálogo: los gastos/ventas podían fallar (o ni terminar) mientras el
    // cajero ya veía "Catálogo sincronizado".
    this.syncing.set(true);
    try {
      await this.pushPending();
      const outcome = await this.pullProducts();
      this.lastOutcome.set(outcome);
      if (outcome.ok) {
        this.lastSyncedAt.set(new Date());
      }
      return outcome;
    } finally {
      this.syncing.set(false);
    }
  }

  /**
   * Lee siempre del almacenamiento y no de una copia en memoria: en el mismo
   * equipo se turnan cajeros distintos, y un valor cacheado sin dueño le aplicaría
   * a uno el cupo ya gastado por el otro. La señal solo sirve para que la UI
   * recalcule cuando cambia.
   */
  private readLastManualSync(uid: string): number | null {
    this.lastManualSyncAt();
    try {
      const raw = localStorage.getItem(manualSyncKey(uid));
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    } catch {
      // Almacenamiento no disponible: sin registro previo, se permite sincronizar.
    }
    return null;
  }

  private rememberManualSync(uid: string): void {
    const now = Date.now();
    this.lastManualSyncAt.set(now);
    try {
      localStorage.setItem(manualSyncKey(uid), String(now));
    } catch {
      // Si no se puede persistir, el límite vale solo para esta ejecución.
    }
    this.clearCooldownTimer();
    this.armCooldownTimer(now + MANUAL_SYNC_COOLDOWN_MS);
  }

  private armCooldownTimer(availableAtMs: number): void {
    if (this.cooldownTimer !== null) {
      return;
    }
    const delay = Math.max(0, availableAtMs - Date.now()) + 50;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.cooldownEpoch.update((n) => n + 1);
    }, delay);
  }

  private clearCooldownTimer(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private scheduleNext(): void {
    const delay = this.msUntilNextRun();
    this.timer = setTimeout(() => {
      this.runNow();
      this.scheduleNext();
    }, delay);
  }

  private msUntilNextRun(): number {
    const now = new Date();
    const candidates = FIXED_TIMES.map(([hour, minute]) => {
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    });
    return Math.min(...candidates) - now.getTime();
  }

  private pullProducts(): Promise<SyncOutcome> {
    if (this.pullInFlight) {
      return this.pullInFlight;
    }
    this.pullInFlight = this.doPullProducts().finally(() => {
      this.pullInFlight = null;
    });
    return this.pullInFlight;
  }

  private async doPullProducts(): Promise<SyncOutcome> {
    const cursor = await this.getCursor();
    let newestUpdatedAt = cursor;

    try {
      const response = await firstValueFrom(this.fetchAll(cursor));
      const items = response.data;

      for (const item of items) {
        const updatedAt = parseTimestamp(item.updatedAt)?.toISOString() ?? null;
        if (updatedAt && (!newestUpdatedAt || updatedAt > newestUpdatedAt)) {
          newestUpdatedAt = updatedAt;
        }
      }
      if (items.length) {
        await window.electronAPI?.catalog.upsertMany(items);
      }
      await window.electronAPI?.sync.recordRun({
        entity: 'products',
        direction: 'pull',
        status: 'ok',
        cursor: newestUpdatedAt ?? undefined,
      });
      await this.doPullServiceCatalogs();
      return { ok: true, pulled: items.length };
    } catch (error: unknown) {
      const errorMessage = getApiErrorMessage(error);
      await window.electronAPI?.sync.recordRun({
        entity: 'products',
        direction: 'pull',
        status: 'error',
        errorMessage,
      });
      // Los demás catálogos no dependen de los productos: cada uno lleva su
      // cursor y su registro de error. Sin esto, un producto que el SQLite no
      // aceptaba dejaba sin bajar la baja de una promoción, y la caja la seguía
      // aplicando.
      await this.doPullServiceCatalogs();
      return { ok: false, pulled: 0, errorMessage };
    }
  }

  /** `GET /products/sync`: catálogo completo (o incremental) en una sola llamada, sin paginar. */
  private fetchAll(updatedSince: string | null) {
    let params = new HttpParams();
    if (updatedSince) {
      params = params.set('updatedSince', updatedSince);
    }
    return this.http.get<SyncProductsResponse>(`${this.apiUrl}/products/sync`, { params });
  }

  /**
   * Cursor = `updatedAt` más nuevo visto en el último pull exitoso de ESA
   * entidad; null = trae todo. Cada catálogo lleva el suyo: si compartieran
   * cursor, el primero en sincronizar dejaría a los otros creyendo que ya
   * estaban al día.
   */
  private getCursor(entity = 'products'): Promise<string | null> {
    const api = window.electronAPI;
    if (!api) {
      return Promise.resolve(null);
    }
    return firstValueFrom(
      from(api.sync.getStatus()).pipe(
        map((runs) => {
          const lastOk = runs.find(
            (run) =>
              run.entity === entity && run.direction === 'pull' && run.status === 'ok' && run.cursor,
          );
          return lastOk?.cursor ?? null;
        }),
        catchError(() => of(null)),
      ),
    );
  }

  /**
   * Catálogos de servicios y doctores: **solo-pull**, los administra el admin
   * web. Corren después de los productos y son best-effort: si fallan, la caja
   * sigue vendiendo medicamentos con el catálogo que ya tiene.
   */
  private async doPullServiceCatalogs(): Promise<void> {
    await this.pullCatalog('pharmacyServices', 'pharmacy-services', (items) =>
      window.electronAPI?.pharmacyServices.upsertMany(items),
    );
    await this.pullCatalog('serviceProviders', 'service-providers', (items) =>
      window.electronAPI?.pharmacyServices.upsertProviders(items),
    );
    // Promociones: mismo pull incremental. Al terminar se avisa al carrito para
    // que relea las vigentes sin esperar a reiniciar la caja. Si el pull de cada
    // hora va a medias se espera: con los dos a la vez se pediría dos veces lo
    // mismo con el mismo cursor.
    await this.promotionsPullInFlight?.catch(() => false);
    await this.pullCatalog('promotions', 'promotions', (items) =>
      window.electronAPI?.promotions?.upsertMany(items),
    );
    window.dispatchEvent(new Event(PROMOTIONS_SYNCED_EVENT));
  }

  private async pullCatalog(
    entity: string,
    path: string,
    write: (items: SyncCatalogItem[]) => unknown,
  ): Promise<boolean> {
    const cursor = await this.getCursor(entity);
    let newestUpdatedAt = cursor;
    try {
      let params = new HttpParams();
      if (cursor) {
        params = params.set('updatedSince', cursor);
      }
      const response = await firstValueFrom(
        this.http.get<{ data: SyncCatalogItem[] }>(`${this.apiUrl}/${path}/sync`, { params }),
      );
      const items = response.data ?? [];
      for (const item of items) {
        const updatedAt = parseTimestamp(item.updatedAt)?.toISOString() ?? null;
        if (updatedAt && (!newestUpdatedAt || updatedAt > newestUpdatedAt)) {
          newestUpdatedAt = updatedAt;
        }
      }
      if (items.length) {
        await write(items);
      }
      await window.electronAPI?.sync.recordRun({
        entity,
        direction: 'pull',
        status: 'ok',
        cursor: newestUpdatedAt ?? undefined,
      });
      return true;
    } catch (error: unknown) {
      await window.electronAPI?.sync.recordRun({
        entity,
        direction: 'pull',
        status: 'error',
        errorMessage: getApiErrorMessage(error),
      });
      return false;
    }
  }
}
