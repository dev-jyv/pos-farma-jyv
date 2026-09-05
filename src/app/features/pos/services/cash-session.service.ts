import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  finalize,
  firstValueFrom,
  from,
  map,
  of,
  switchMap,
} from 'rxjs';

import {
  ApiListMeta,
  getApiErrorMessage,
  toDate,
  unwrapEntity,
  unwrapList,
  unwrapListWithMeta,
} from '../../../core/api/api.utils';
import {
  CashOnHand,
  LocalCashSessionCloseInput,
  PendingCashSession,
  PendingCashSessionClose,
} from '../../../core/electron/window.d';
import { CashAdjustmentStatus, CashSession, CashSessionSummary } from '../../../shared/models';
import { isSessionExpired } from '../../../shared/utils/session-expiry';
import { environment } from '../../../../environments/environment';
import { PushOwner } from '../../../core/sync/push-owner';

/**
 * Corte tal como llega de `GET /cash-sessions`, con las fechas todavía en el
 * formato de Firestore (`{_seconds}`) y los uids sin resolver.
 */
interface AuditCashSessionDto {
  id: string;
  openedBy: string;
  closedBy?: string | null;
  openedByLabel?: string | null;
  closedByLabel?: string | null;
  openingAmount: number;
  expectedCashAmount: number | null;
  countedCashAmount: number | null;
  cashDifference: number | null;
  summary?: CashSessionSummary | null;
  hasPendingAdjustment?: boolean;
  adjustmentStatus?: CashAdjustmentStatus | null;
  adjustmentReviewedBy?: string | null;
  adjustmentReviewedAt?: unknown;
  adjustmentNote?: string | null;
  autoClosedByExpiry?: boolean;
  openedAt: unknown;
  closedAt?: unknown;
}

/** Corte del listado de auditoría, ya con fechas reales y quién lo operó. */
export interface AuditCashSession extends CashSession {
  closedBy: string | null;
  /** Nombre o correo de quien abrió/cerró; `null` si el perfil ya no existe. */
  openedByLabel: string | null;
  closedByLabel: string | null;
}

/**
 * El backend serializa `Timestamp` como `{_seconds,_nanoseconds}`: sin este
 * mapeo, `| date` recibía un objeto que no sabe formatear y la columna salía en
 * blanco — parecía que el turno no registraba hora de apertura ni de cierre.
 */
function toAuditCashSession(dto: AuditCashSessionDto): AuditCashSession {
  return {
    id: dto.id,
    openedBy: dto.openedBy,
    closedBy: dto.closedBy ?? null,
    openedByLabel: dto.openedByLabel ?? null,
    closedByLabel: dto.closedByLabel ?? null,
    openingAmount: dto.openingAmount,
    expectedCashAmount: dto.expectedCashAmount,
    countedCashAmount: dto.countedCashAmount,
    cashDifference: dto.cashDifference,
    summary: dto.summary ?? null,
    openedAt: toDate(dto.openedAt),
    closedAt: dto.closedAt ? toDate(dto.closedAt) : null,
    hasPendingAdjustment: dto.hasPendingAdjustment ?? false,
    adjustmentStatus: dto.adjustmentStatus ?? null,
    adjustmentReviewedBy: dto.adjustmentReviewedBy ?? null,
    adjustmentReviewedAt: dto.adjustmentReviewedAt ? toDate(dto.adjustmentReviewedAt) : null,
    adjustmentNote: dto.adjustmentNote ?? null,
    autoClosedByExpiry: dto.autoClosedByExpiry ?? false,
    remoteId: dto.id,
  };
}

interface CashSessionSummaryDto {
  session: CashSession & { id: string };
  summary: CashSessionSummary;
  expectedCashAmount: number;
}

/**
 * Turno de caja — local-first (2026-09): abrir, cerrar y consultar el efectivo
 * esperado son 100% locales (SQLite vía IPC, sin red en el instante de la
 * acción), igual patrón que ventas y catálogo. El push real
 * (`POST /cash-sessions` / `POST /cash-sessions/:id/close`) solo ocurre en
 * `flushQueue()`, llamada por `SyncScheduler`.
 *
 * A propósito **no inyecta `AuthService`**: `AuthService.endExpiredSession()`
 * necesita llamar a `autoCloseForExpiry()` de este servicio, así que la
 * dependencia solo puede ir en una dirección — quien llama pasa
 * `userId`/`userLabel` explícitos, igual que `SaleService.buildPayload`.
 */
@Injectable({ providedIn: 'root' })
export class CashSessionService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  private flushing = false;

  readonly current = signal<CashSession | null>(null);
  readonly isOpen = signal(false);

  /**
   * Reemplaza al antiguo `fetchCurrent()` HTTP: lee el turno local abierto de
   * este cajero. Antes de leer, cierra un turno rezagado de un día anterior
   * (ver `autoCloseStale`) — así ninguna pantalla llega a operar sobre un
   * turno que ya debió cerrarse.
   */
  refreshCurrent(userId: string): Observable<CashSession | null> {
    const api = window.electronAPI;
    if (!api) {
      this.setCurrent(null);
      return of(null);
    }
    return from(this.autoCloseStale(userId)).pipe(
      switchMap(() => from(api.cashSessions.getOpenLocal(userId))),
      map((session) => {
        this.setCurrent(session);
        return session;
      }),
    );
  }

  openLocal(userId: string, userLabel: string | undefined, openingAmount: number): Observable<CashSession> {
    return from(this.api().createLocal({ openedBy: userId, openedByLabel: userLabel, openingAmount })).pipe(
      map((session) => {
        this.setCurrent(session);
        return session;
      }),
    );
  }

  /**
   * Efectivo que quedó en el cajón tras el último cierre (más/menos lo que se
   * movió entre turnos). Con esto se precarga el fondo al abrir: el dinero no
   * desaparece al cerrar el turno, sigue físicamente en la caja.
   */
  cashOnHand(): Observable<number> {
    const api = window.electronAPI;
    if (!api) {
      return of(0);
    }
    return from(api.cashSessions.getCashOnHand()).pipe(
      map((result) => result.amount),
      // Precargar es una comodidad: si falla, el cajero captura el fondo a mano
      // en vez de quedarse sin poder abrir turno.
      catchError(() => of(0)),
    );
  }

  /**
   * Lo mismo, con el desglose (qué se contó en el último corte y qué se movió
   * después) y **propagando el error**: la caja de la farmacia enseña este
   * número como saldo, y ahí un cero por un fallo de lectura se lee como "no
   * hay efectivo" — justo lo contrario de la verdad.
   */
  cashOnHandDetail(): Observable<CashOnHand> {
    return from(this.api().getCashOnHand());
  }

  /** Efectivo esperado en vivo (fondo + acumulado del turno), sin red. */
  liveSummary(sessionId: string): Observable<{
    summary: CashSessionSummary;
    /** Esperado de farmacia; el del cajón completo suma el de servicios. */
    expectedCashAmount: number;
    expectedServicesCashAmount: number;
  }> {
    return from(this.api().getLiveSummary(sessionId));
  }

  /**
   * El cierre **siempre procede** — si hay diferencia, el componente ya
   * confirmó con el cajero que quedará como ajuste pendiente de un admin; esta
   * llamada no vuelve a preguntar ni bloquea.
   */
  closeLocal(
    sessionId: string,
    countedCashAmount: number,
    closedBy: string,
    closedByLabel?: string,
  ): Observable<CashSession> {
    const input: LocalCashSessionCloseInput = { countedCashAmount, closedBy, closedByLabel };
    return from(this.api().closeLocal(sessionId, input)).pipe(
      map((session) => {
        this.setCurrent(null);
        return session;
      }),
    );
  }

  /**
   * Cierre automático a las 24:00 (expiración de sesión): nunca hay ajuste
   * pendiente (`countedCashAmount = expectedCashAmount` siempre). Best-effort
   * total — si no hay Electron, no hay turno abierto, o algo falla, no debe
   * impedir que `AuthService` complete el logout por expiración.
   */
  async autoCloseForExpiry(userId: string, userLabel?: string): Promise<void> {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    try {
      const open = await api.cashSessions.getOpenLocal(userId);
      if (!open) {
        return;
      }
      await this.closeWithExpectedCash(open, userId, userLabel);
    } catch (error) {
      console.error('[cash-sessions] auto-cierre por expiración falló', error);
    }
  }

  /**
   * Turno rezagado: el cajero salió sin cerrarlo y ya cambió el día (hora
   * CDMX). Se cierra solo con el efectivo que había hasta ese momento —el
   * mismo criterio que el auto-cierre de medianoche, y por la misma razón: no
   * hay nadie que pueda contar hoy el cajón de ayer, así que nunca deja ajuste
   * pendiente. Un turno del MISMO día se respeta: el cajero puede volver a
   * entrar y seguir vendiendo en él.
   *
   * Best-effort: cualquier fallo se traga, porque esto corre en el camino de
   * lectura del turno y no debe impedir operar la caja.
   */
  async autoCloseStale(userId: string, userLabel?: string): Promise<boolean> {
    const api = window.electronAPI;
    if (!api) {
      return false;
    }
    try {
      const open = await api.cashSessions.getOpenLocal(userId);
      if (!open || !isSessionExpired(new Date(open.openedAt).getTime())) {
        return false;
      }
      await this.closeWithExpectedCash(open, userId, userLabel);
      return true;
    } catch (error) {
      console.error('[cash-sessions] cierre del turno rezagado falló', error);
      return false;
    }
  }

  private async closeWithExpectedCash(
    open: CashSession,
    userId: string,
    userLabel?: string,
  ): Promise<void> {
    const api = this.api();
    const { expectedCashAmount } = await api.getLiveSummary(open.id);
    await api.closeLocal(open.id, {
      countedCashAmount: expectedCashAmount,
      closedBy: userId,
      closedByLabel: userLabel,
      autoClosedByExpiry: true,
    });
    this.setCurrent(null);
  }

  /**
   * Sube en orden create→close cada turno pendiente. Un turno puede necesitar
   * las dos llamadas en el mismo ciclo (se abrió y se cerró local antes del
   * primer sync) — el `remoteId` del create se persiste de inmediato para que
   * un fallo del close no dispare un segundo alta en el próximo intento.
   */
  flushQueue(owner: PushOwner = {}): void {
    this.flush$(owner).subscribe();
  }

  /** Esperable: `SyncScheduler` la encadena antes de movimientos y ventas (ambos dependen de esto). */
  flushQueueAsync(owner: PushOwner = {}): Promise<void> {
    return firstValueFrom(this.flush$(owner).pipe(defaultIfEmpty(null))).then(() => undefined);
  }

  /**
   * Solo los cierres. El sincronizador la llama **al final**, después de gastos y
   * ventas: el cierre libera el hueco del cajero, pero cerrar antes que sus hijos
   * hacía que el backend los rechazara con "el turno de caja ya está cerrado" —
   * gastos y ventas reales que quedaban bloqueados sin haber hecho nada mal.
   */
  flushClosesAsync(owner: PushOwner = {}): Promise<void> {
    return firstValueFrom(
      this.pushPendingCloses$(new Set<string>(), owner).pipe(defaultIfEmpty(null)),
    ).then(() => undefined);
  }

  /**
   * Orden: **cierres pendientes primero**, luego altas, y al final los cierres
   * que nacieron de esas altas.
   *
   * El cierre va primero porque el backend solo admite un turno abierto por
   * cajero: si el turno de ayer sigue abierto allá (su cierre no subió) y hoy
   * se sube el alta del turno nuevo, `GET /cash-sessions/current` devuelve el
   * turno viejo y el nuevo intenta adoptar un `remoteId` que ya es de otro —
   * P2002 "Unique constraint failed on the fields: (remoteId)", visto en
   * producción. Cerrando primero, el hueco queda libre y el alta crea uno real.
   */
  private flush$(owner: PushOwner): Observable<unknown> {
    if (this.flushing) {
      return EMPTY;
    }
    this.flushing = true;
    // Un turno solo se cierra una vez por ciclo: `POST /:id/close` no es
    // idempotente (responde 409 "el turno ya está cerrado") y el segundo
    // barrido lo marcaría como rechazo permanente sin serlo.
    const cerradosEnEsteCiclo = new Set<string>();
    return this.pushPendingCloses$(cerradosEnEsteCiclo, owner, { sinHijosPendientes: true }).pipe(
      switchMap(() => from(this.api().getPendingPush(owner))),
      catchError(() => of([] as PendingCashSession[])),
      switchMap((pendingCreates) =>
        pendingCreates.length
          ? from(pendingCreates).pipe(concatMap((item) => this.pushOneCreate(item)))
          : of(null),
      ),
      // La segunda pasada de cierres ya no va aquí: la hace el sincronizador con
      // `flushClosesAsync()` después de subir gastos y ventas, para no cerrar el
      // turno antes que sus propios movimientos (ver ese método).
      finalize(() => {
        this.flushing = false;
      }),
    );
  }

  /**
   * `sinHijosPendientes`: solo los cierres de turnos que ya no tienen ventas ni
   * gastos en cola. Se usa en la **primera** pasada, cuya única razón de ser es
   * liberar el hueco del cajero para el alta de hoy. Sin ese filtro, esa pasada
   * cerraba el turno recién cortado y sus propios gastos rebotaban con "el turno
   * de caja ya está cerrado" — el 400 que se veía al cerrar sesión.
   */
  private pushPendingCloses$(
    yaIntentados: Set<string>,
    owner: PushOwner,
    { sinHijosPendientes = false } = {},
  ): Observable<unknown> {
    return from(this.api().getPendingClosePush({ ...owner, sinHijosPendientes })).pipe(
      catchError(() => of([] as PendingCashSessionClose[])),
      map((pendingCloses) => pendingCloses.filter((item) => !yaIntentados.has(item.id))),
      switchMap((pendingCloses) =>
        pendingCloses.length
          ? from(pendingCloses).pipe(
              concatMap((item) => {
                yaIntentados.add(item.id);
                return this.pushOneClose(item);
              }),
            )
          : of(null),
      ),
    );
  }

  /**
   * `POST /cash-sessions` no tiene llave de idempotencia propia (a diferencia
   * de `/sales`): antes de crear, se comprueba `GET /cash-sessions/current`
   * (mismo patrón que `findExistingBySku` en `product-catalog.service.ts`) —
   * si el cajero ya tiene un turno abierto remoto (de un intento anterior con
   * respuesta perdida), se adopta ese id en vez de crear uno nuevo.
   */
  private pushOneCreate(item: PendingCashSession): Observable<unknown> {
    return this.http.get<unknown>(`${this.apiUrl}/cash-sessions/current`).pipe(
      switchMap((response) => {
        const existing = unwrapEntity<{ id: string } | null>(response);
        if (existing) {
          return from(this.api().markCreateSynced(item.id, existing.id));
        }
        return this.http
          .post<unknown>(`${this.apiUrl}/cash-sessions`, { openingAmount: item.openingAmount })
          .pipe(
            switchMap((created) => {
              const session = unwrapEntity<{ id: string }>(created);
              return from(this.api().markCreateSynced(item.id, session.id));
            }),
          );
      }),
      catchError((error: unknown) => {
        if (this.isPermanentFailure(error)) {
          return from(this.api().markPushFailed(item.id, getApiErrorMessage(error)));
        }
        return EMPTY;
      }),
    );
  }

  private pushOneClose(item: PendingCashSessionClose): Observable<unknown> {
    return this.http
      .post<unknown>(`${this.apiUrl}/cash-sessions/${item.remoteId}/close`, {
        countedCashAmount: item.countedCashAmount,
        autoClosedByExpiry: item.autoClosedByExpiry,
      })
      .pipe(
        switchMap((response) => {
          const result = unwrapEntity<{ session: CashSession }>(response);
          return from(
            this.api().markCloseSynced(item.id, {
              expectedCashAmount: result.session.expectedCashAmount ?? undefined,
              cashDifference: result.session.cashDifference ?? undefined,
            }),
          );
        }),
        catchError((error: unknown) => {
          if (this.isPermanentFailure(error)) {
            return from(this.api().markClosePushFailed(item.id, getApiErrorMessage(error)));
          }
          return EMPTY;
        }),
      );
  }

  /**
   * Pull liviano: solo refleja el `adjustmentStatus` que un admin ya resolvió
   * en el backend, para turnos locales que quedaron `pending`. La aprobación
   * en sí vive exclusivamente en el servidor — el POS nunca la hace localmente.
   */
  pullAdjustmentStatus(): void {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    from(api.cashSessions.listLocal({ adjustmentStatus: 'pending' }))
      .pipe(
        switchMap((pending) => {
          const withRemote = pending.filter((session): session is CashSession & { remoteId: string } =>
            Boolean(session.remoteId),
          );
          if (!withRemote.length) {
            return of(null);
          }
          return from(withRemote).pipe(
            concatMap((session) =>
              this.http.get<unknown>(`${this.apiUrl}/cash-sessions/${session.remoteId}/summary`).pipe(
                switchMap((response) => {
                  const dto = unwrapEntity<CashSessionSummaryDto>(response);
                  const status = dto.session.adjustmentStatus;
                  if (!status || status === 'pending') {
                    return of(undefined);
                  }
                  return from(
                    api.cashSessions.updateAdjustmentStatus(session.id, {
                      status,
                      reviewedBy: dto.session.adjustmentReviewedBy ?? null,
                      // El backend manda `Timestamp` serializado (`{_seconds}`):
                      // `new Date(objeto)` da Invalid Date y `.toISOString()`
                      // lanza RangeError, tirando el pull entero por una fecha.
                      reviewedAt: dto.session.adjustmentReviewedAt
                        ? toDate(dto.session.adjustmentReviewedAt).toISOString()
                        : null,
                      note: dto.session.adjustmentNote ?? null,
                    }),
                  );
                }),
                catchError(() => of(undefined)),
              ),
            ),
          );
        }),
      )
      .subscribe();
  }

  /**
   * Auditoría (solo admin, `GET /cash-sessions`): todas las cajas, no solo la
   * de este equipo. Distinto de `listLocal()` — ese lee SQLite de este equipo
   * únicamente, esto lee el backend, la única fuente que junta todas las cajas.
   */
  /**
   * Auditoría de cortes (solo admin). Pagina contra el servidor: `page` + `meta`,
   * no un lote recortado en pantalla. Sin `from`, el backend acota a 90 días.
   */
  listAudit(filters: {
    from?: string;
    to?: string;
    openedBy?: string;
    adjustmentStatus?: 'pending' | 'approved' | 'rejected';
    page?: number;
    /** Máximo 100: es el tope de la API. */
    limit?: number;
  } = {}): Observable<{ items: AuditCashSession[]; meta: ApiListMeta | null }> {
    let params: Record<string, string> = {};
    if (filters.from) params = { ...params, from: filters.from };
    if (filters.to) params = { ...params, to: filters.to };
    if (filters.openedBy) params = { ...params, openedBy: filters.openedBy };
    if (filters.adjustmentStatus) params = { ...params, adjustmentStatus: filters.adjustmentStatus };
    if (filters.page !== undefined) params = { ...params, page: String(filters.page) };
    if (filters.limit !== undefined) params = { ...params, limit: String(filters.limit) };
    return this.http
      .get<unknown>(`${this.apiUrl}/cash-sessions`, { params })
      .pipe(
        map((response) => {
          const { items, meta } = unwrapListWithMeta<AuditCashSessionDto>(response);
          return { items: items.map(toAuditCashSession), meta };
        }),
      );
  }

  /** Aprueba/rechaza el ajuste pendiente de un turno (solo admin). */
  reviewAdjustment(sessionRemoteId: string, decision: 'approved' | 'rejected', note?: string): Observable<CashSession> {
    return this.http
      .post<unknown>(`${this.apiUrl}/cash-sessions/${sessionRemoteId}/adjustment/review`, { decision, note })
      .pipe(map((response) => unwrapEntity<CashSession>(response)));
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

  private setCurrent(session: CashSession | null): void {
    this.current.set(session);
    this.isOpen.set(session !== null && session.closedAt === null);
  }

  private api() {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI no disponible: el turno de caja requiere correr dentro de Electron.');
    }
    return api.cashSessions;
  }
}
