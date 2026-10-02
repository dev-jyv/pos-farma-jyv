import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { EMPTY, Observable, catchError, concatMap, defaultIfEmpty, finalize, lastValueFrom, from, map, of, switchMap, tap } from 'rxjs';

import {
  ApiListMeta,
  getApiErrorMessage,
  unwrapEntity,
  unwrapList,
  toDate,
  unwrapListWithMeta,
} from '../../../core/api/api.utils';
import { LocalCashMovementInput, PendingCashMovement } from '../../../core/electron/window.d';
import { CashMovement, CashMovementType, ExpenseCategory } from '../../../shared/models';
import { environment } from '../../../../environments/environment';
import { PushOwner } from '../../../core/sync/push-owner';

/**
 * Depósitos, retiros y gastos de un turno — local-first, igual patrón que
 * `ProductCatalogService`: `create()` escribe directo en SQLite (sin red), el
 * push real (`POST /cash-sessions/:remoteId/movements`) ocurre en
 * `flushQueue()`.
 *
 * Un "gasto" es esta misma entidad con `type: 'expense'` — no hay servicio
 * aparte para el módulo de gastos, solo una pantalla que fija ese tipo.
 *
 * Un movimiento no se puede subir hasta que su `CashSession` padre tenga
 * `remoteId` — por eso `SyncScheduler` corre `CashSessionService.flushQueueAsync()`
 * ANTES que este servicio.
 */
@Injectable({ providedIn: 'root' })
export class CashMovementService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  private flushing = false;

  /** Movimientos locales sin subir, para el indicador de pendientes del header. */
  readonly pendingCount = signal(0);

  constructor() {
    this.refreshPending();
  }

  /**
   * `cashSessionId` en `null` es la caja de la farmacia: el admin mueve
   * efectivo sin turno abierto y el movimiento no entra a ningún corte.
   */
  create(cashSessionId: string | null, input: LocalCashMovementInput): Observable<CashMovement> {
    return from(this.api().add(cashSessionId, input)).pipe(
      switchMap((movement) => {
        this.refreshPending();
        return of(movement);
      }),
    );
  }

  listForSession(cashSessionId: string): Observable<CashMovement[]> {
    return from(this.api().listForSession(cashSessionId));
  }

  /**
   * Movimientos del alcance que pide el reporte: los de un turno, o los del día
   * cuando no hay turno. Local (SQLite), como el resto del reporte.
   */
  listForScope(scope: { cashSessionId?: string; from?: string; to?: string }): Observable<CashMovement[]> {
    return from(this.api().listAllLocal(scope));
  }

  /**
   * Una página del historial local más el total con los mismos filtros. La
   * paginación es contra SQLite (`skip`/`take`), no un recorte en pantalla: el
   * historial de caja crece toda la vida del equipo y traerlo entero para
   * mostrar 50 renglones es trabajo que nadie ve.
   */
  listPageLocal(
    page: number,
    pageSize: number,
    filters: { type?: CashMovementType; category?: ExpenseCategory } = {},
  ): Observable<{ items: CashMovement[]; total: number }> {
    const api = this.api();
    return from(
      Promise.all([
        api.listAllLocal({ ...filters, limit: pageSize, offset: Math.max(0, page) * pageSize }),
        api.countAllLocal(filters),
      ]).then(([items, total]) => ({ items, total })),
    );
  }


  /**
   * Auditoría (solo admin, `GET /cash-sessions/movements`): todos los
   * movimientos de todas las cajas, filtrable por tipo (gastos = `type='expense'`).
   */
  listMovementsAudit(filters: {
    from?: string;
    to?: string;
    type?: CashMovementType;
    category?: ExpenseCategory;
    cashSessionId?: string;
    page?: number;
    /** Máximo 100: es el tope de la API. */
    limit?: number;
  } = {}): Observable<{ items: CashMovement[]; meta: ApiListMeta | null }> {
    let params: Record<string, string> = {};
    if (filters.from) params = { ...params, from: filters.from };
    if (filters.to) params = { ...params, to: filters.to };
    if (filters.type) params = { ...params, type: filters.type };
    if (filters.category) params = { ...params, category: filters.category };
    if (filters.cashSessionId) params = { ...params, cashSessionId: filters.cashSessionId };
    if (filters.page !== undefined) params = { ...params, page: String(filters.page) };
    if (filters.limit !== undefined) params = { ...params, limit: String(filters.limit) };
    return this.http
      .get<unknown>(`${this.apiUrl}/cash-sessions/movements`, { params })
      .pipe(
        map((response) => {
          const { items, meta } = unwrapListWithMeta<CashMovement>(response);
          return {
            // El backend serializa `createdAt` como Timestamp de Firestore
            // (`{_seconds}`), que el `DatePipe` no sabe pintar: la columna Fecha
            // salía vacía. `toDate` normaliza esa forma y las demás.
            items: items.map((item) => ({ ...item, createdAt: toDate(item.createdAt) })),
            meta,
          };
        }),
      );
  }

  /**
   * Disparar y olvidar. Si ya hay un empuje en vuelo **no** encola otro: se
   * apoya en el que corre, que va a leer la cola igual. Encolar aquí duplicaba
   * la pasada sin ganar nada. Un empuje **esperado** (`flushQueueAsync`) sí se
   * encola siempre: quien lo espera necesita que de verdad ocurra.
   */
  flushQueue(owner: PushOwner = {}): void {
    if (this.cola) {
      return;
    }
    void this.flushQueueAsync(owner);
  }

  /** Esperable: `SyncScheduler` la encadena después de `CashSessionService.flushQueueAsync()`. */
    /**
   * **Encadenada, no descartada.** El guard `flushing` de `flush$()` devuelve
   * `EMPTY` cuando ya hay un empuje en vuelo, y con `defaultIfEmpty` esta
   * promesa resolvía de inmediato **sin haber subido nada**: el sincronizador
   * la daba por cumplida y pasaba al cierre del turno, que adelantaba a lo que
   * seguía en vuelo. El backend rechaza a los rezagados con "el turno de caja
   * ya está cerrado".
   *
   * `flushQueue()` entra por aquí también, para que todo empuje quede en la
   * misma fila.
   *
   * `lastValueFrom` y no `firstValueFrom`: `flush$()` emite **un valor por
   * registro** (`concatMap`), y tomar el primero desuscribía la cadena y
   * cancelaba los que faltaban. Con tres gastos en cola subía uno y abandonaba
   * dos, y el cierre salía enseguida: los dos rezagados quedaban rechazados
   * para siempre con "el turno de caja ya está cerrado".
   */
flushQueueAsync(owner: PushOwner = {}): Promise<void> {
    return this.enFila(() => lastValueFrom(this.flush$(owner).pipe(defaultIfEmpty(null))).then(() => undefined));
  }

  /**
   * Fila de un solo carril: cada empuje espera al anterior, ninguno se descarta.
   *
   * Con la fila vacía el trabajo arranca **en el acto**, sin diferir un tick: el
   * push debe salir en el mismo turno en que se pide, como antes de encolarlo.
   */
  private cola: Promise<void> | null = null;

  private enFila(trabajo: () => Promise<void>): Promise<void> {
    const propia = this.cola ? this.cola.catch(() => undefined).then(trabajo) : trabajo();
    let seguimiento: Promise<void>;
    seguimiento = propia.catch(() => undefined).then(() => {
      // Solo el último de la fila la libera; si ya hay otro detrás, es suyo.
      if (this.cola === seguimiento) {
        this.cola = null;
      }
    });
    this.cola = seguimiento;
    return propia;
  }

  private flush$(owner: PushOwner): Observable<unknown> {
    this.flushing = true;
    return from(this.api().getPendingPush(owner)).pipe(
      catchError(() => of([] as PendingCashMovement[])),
      switchMap((pending) => {
        if (!pending.length) {
          return of(null);
        }
        return from(pending).pipe(concatMap((item) => this.pushOne(item)));
      }),
      finalize(() => {
        this.flushing = false;
        this.refreshPending();
      }),
    );
  }

  /**
   * Corrige un gasto del turno **en SQLite**, igual que el alta: la caja sigue
   * cuadrando sin red porque el efectivo esperado del corte se recalcula de las
   * filas locales. La corrección queda marcada como pendiente de subir, y el
   * reenvío la manda como `PATCH` si el gasto ya existía en el servidor.
   */
  updateExpense(
    id: string,
    patch: { amount?: number; reason?: string; category?: ExpenseCategory; description?: string },
  ): Observable<CashMovement> {
    return from(this.api().updateExpense(id, patch)).pipe(
      tap(() => this.refreshPending()),
    );
  }

  /**
   * Dos destinos según de dónde salga el movimiento: el del turno va a la ruta
   * de siempre; el de la caja de la farmacia, que no tiene turno al cual
   * colgarse, va a `POST /cash-sessions/movements` con el id (o su ausencia)
   * en el cuerpo.
   */
  private pushOne(item: PendingCashMovement): Observable<unknown> {
    // Con `remoteId` el movimiento ya existe en el servidor: esto es una
    // corrección, no un alta. Reenviarlo como POST crearía un gasto duplicado y
    // descuadraría el efectivo esperado del corte.
    if (item.remoteId) {
      return this.http
        .patch<unknown>(`${this.apiUrl}/cash-sessions/movements/${item.remoteId}`, {
          amount: item.amount,
          reason: item.reason,
          ...(item.category ? { category: item.category } : {}),
          ...(item.description ? { description: item.description } : {}),
        })
        .pipe(
          switchMap(() => from(this.api().markSynced(item.id, item.remoteId ?? null))),
          catchError((error: unknown) => {
            if (this.isPermanentFailure(error)) {
              return from(this.api().markPushFailed(item.id, getApiErrorMessage(error)));
            }
            return EMPTY;
          }),
        );
    }

    /**
     * Cerrojo del **momento del envío**. La cola se leyó antes, y entre esa
     * lectura y este `POST` cabe un cierre: basta que el `close` suba en esa
     * ventana para que esta petición salga condenada a 400 "el turno de caja ya
     * está cerrado" — la petición en rojo que aparecía justo después del cierre.
     *
     * `assertPushable` mira el estado **ahora**, y si el turno ya cerró en el
     * servidor deja el movimiento bloqueado con su motivo y no se manda nada.
     */
    if (item.cashSessionRemoteId) {
      return from(this.api().assertPushable(item.id)).pipe(
        switchMap((sePuede) => (sePuede ? this.pushOneNow(item) : EMPTY)),
        catchError(() => EMPTY),
      );
    }
    return this.pushOneNow(item);
  }

  private pushOneNow(item: PendingCashMovement): Observable<unknown> {
    const request$ = item.cashSessionRemoteId
      ? this.http.post<unknown>(
          `${this.apiUrl}/cash-sessions/${item.cashSessionRemoteId}/movements`,
          {
            type: item.type,
            amount: item.amount,
            reason: item.reason,
            ...(item.category ? { category: item.category } : {}),
            ...(item.description ? { description: item.description } : {}),
          },
        )
      : this.http.post<unknown>(`${this.apiUrl}/cash-sessions/movements`, {
          type: item.type,
          amount: item.amount,
          reason: item.reason,
        });

    return request$
      .pipe(
        switchMap((response) => {
          // El `remoteId` es lo que evita duplicar el movimiento si el push se
          // reintenta; antes se llamaba sin él y siempre quedaba en `null`.
          const remote = unwrapEntity<CashMovement | null>(response);
          return from(this.api().markSynced(item.id, remote?.id ?? null));
        }),
        catchError((error: unknown) => {
          if (this.isPermanentFailure(error)) {
            return from(this.api().markPushFailed(item.id, getApiErrorMessage(error)));
          }
          return EMPTY;
        }),
      );
  }

  private isPermanentFailure(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse)) {
      return false;
    }
    return (
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 401 &&
      error.status !== 408 &&
      error.status !== 429
    );
  }

  private refreshPending(): void {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    // El conteo es informativo (puntito del header): si el IPC falla, se deja
    // el valor anterior en vez de propagar un rechazo sin dueño al renderer.
    from(api.cashMovements.getPendingPush())
      .pipe(catchError(() => EMPTY))
      .subscribe((pending) => this.pendingCount.set(pending.length));
  }

  private api() {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI no disponible: los movimientos de caja requieren correr dentro de Electron.');
    }
    return api.cashMovements;
  }
}
