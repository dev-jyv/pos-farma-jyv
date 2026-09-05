import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { EMPTY, Observable, catchError, concatMap, defaultIfEmpty, finalize, firstValueFrom, from, map, of, switchMap, tap } from 'rxjs';

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

  flushQueue(owner: PushOwner = {}): void {
    this.flush$(owner).subscribe();
  }

  /** Esperable: `SyncScheduler` la encadena después de `CashSessionService.flushQueueAsync()`. */
  flushQueueAsync(owner: PushOwner = {}): Promise<void> {
    return firstValueFrom(this.flush$(owner).pipe(defaultIfEmpty(null))).then(() => undefined);
  }

  private flush$(owner: PushOwner): Observable<unknown> {
    if (this.flushing) {
      return EMPTY;
    }
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
