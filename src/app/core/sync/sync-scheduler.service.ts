import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, from, map, of } from 'rxjs';

import { getApiErrorMessage } from '../api/api.utils';
import { ApiHealthService } from '../health/api-health.service';
import { CashMovementService } from '../../features/pos/services/cash-movement.service';
import { CashSessionService } from '../../features/pos/services/cash-session.service';
import { ProductCatalogService } from '../../features/pos/services/product-catalog.service';
import { SaleService } from '../../features/pos/services/sale.service';
import { StockEntryService } from '../../features/pos/services/stock-entry.service';
import { environment } from '../../../environments/environment';

/**
 * Cuánto espera el cajero entre dos sincronizaciones manuales. El admin no pasa
 * por aquí.
 */
const MANUAL_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

/** Llave por usuario: dos cajeros en el mismo equipo no comparten el cupo. */
const manualSyncKey = (uid: string): string => `pos.last-manual-sync.${uid || 'anon'}`;

function formatTime(date: Date): string {
  return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

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
  private readonly apiUrl = environment.apiUrl;

  private timer: ReturnType<typeof setTimeout> | null = null;
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
   * Última sincronización manual, por usuario. Persistida: si viviera en memoria,
   * cerrar y reabrir la app saltaría el límite del cajero.
   */
  private readonly lastManualSyncAt = signal<number | null>(null);
  /** Resultado del último pull (manual o de horario), para mostrarlo en UI. */
  readonly lastOutcome = signal<SyncOutcome | null>(null);
  readonly lastSyncedAt = signal<Date | null>(null);

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
   * Empuja en **orden**, no en paralelo: turno de caja → catálogo → entradas
   * de stock → gastos/movimientos → ventas.
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
  private async pushPending(): Promise<void> {
    await this.cashSessionService.flushQueueAsync();
    await this.productCatalogService.flushQueueAsync();
    await this.stockEntryService.flushQueueAsync();
    await this.cashMovementService.flushQueueAsync();
    this.saleService.flushQueue();
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
   * por hora**, el admin sin límite.
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
    const last = this.readLastManualSync(uid);
    if (last === null) {
      return null;
    }
    const availableAt = last + MANUAL_SYNC_COOLDOWN_MS;
    return availableAt > Date.now() ? new Date(availableAt) : null;
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
    void this.pushPending();

    this.syncing.set(true);
    const outcome = await this.pullProducts();
    this.syncing.set(false);
    this.lastOutcome.set(outcome);
    if (outcome.ok) {
      this.lastSyncedAt.set(new Date());
    }
    return outcome;
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
  }

  private async pullCatalog(
    entity: string,
    path: string,
    write: (items: SyncCatalogItem[]) => unknown,
  ): Promise<void> {
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
    } catch (error: unknown) {
      await window.electronAPI?.sync.recordRun({
        entity,
        direction: 'pull',
        status: 'error',
        errorMessage: getApiErrorMessage(error),
      });
    }
  }
}
