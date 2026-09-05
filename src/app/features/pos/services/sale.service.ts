import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  catchError,
  defaultIfEmpty,
  finalize,
  firstValueFrom,
  forkJoin,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';

import { getApiErrorMessage, getApiErrorStatus, unwrapEntity } from '../../../core/api/api.utils';
import { AuthService } from '../../../core/auth/auth.service';
import {
  CartLine,
  PaymentMethod,
  Sale,
  SaleBilling,
  SaleItem,
  SalePrescription,
} from '../../../shared/models';
import {
  isControlledGroup,
  resolveControlledRequirements,
} from '../../../shared/utils/controlled';
import { LocalSaleInput, PendingSale, SaleMovement } from '../../../core/electron/window.d';
import {
  commissionTotalOf,
  isProductLine,
  isServiceLine,
  lineCommission,
  lineCommissionRate,
  lineGross,
  lineTaxable,
  lineUnitPrice,
  pharmacyTotalOf,
  servicesTotalOf,
  splitCash,
} from '../../../shared/utils/cart-line';
import { previewTaxSummary } from '../../../shared/utils/taxes';
import { resolveTender } from '../../../shared/utils/tender';
import { environment } from '../../../../environments/environment';
import { pushOwnerFilter } from '../../../core/sync/push-owner';

export interface CreateSalePayload {
  /**
   * Llave de idempotencia: la genera el POS por cobro y se reenvía **sin cambios**
   * en cada reintento del push (incluidos los de `flushQueue`). Sin ella un
   * reintento después de un timeout crea una venta duplicada en el backend.
   */
  idempotencyKey: string;
  /**
   * Partida discriminada: el backend distingue por `kind` qué mueve inventario
   * y qué es un servicio. Un payload sin `kind` (venta encolada por una versión
   * anterior del POS) el backend lo trata como producto.
   */
  items: Array<
    | {
        kind: 'product';
        productId: string;
        quantity: number;
        discountAmount: number;
        /** Precio cobrado por unidad; el backend lo respeta sobre el de catálogo. */
        unitPrice: number;
      }
    | {
        kind: 'service';
        serviceId: string;
        quantity: number;
        discountAmount: number;
        providerId: string | null;
      }
  >;
  saleDiscountAmount: number;
  paymentMethod: PaymentMethod;
  amountReceived: number | null;
  cardPaymentReference: string | null;
  /**
   * Reparto con tarjeta en pago mixto **sin** terminal Point. Con terminal, el
   * backend toma el monto de la order y este campo se ignora.
   */
  cardAmount?: number | null;
  cashSessionId: string;
  customerId?: string | null;
  customerName?: string | null;
  prescription?: SalePrescription | null;
  /** Constancia de retención de la receta; obligatoria en grupos I a III. */
  prescriptionRetained?: boolean;
  billing?: SaleBilling | null;
}

/** Totales del ticket más el reparto de cobro resuelto (ver `resolveTender`). */
export interface SaleTotals {
  subtotal: number;
  discountTotal: number;
  total: number;
  /** Parte a cubrir en efectivo; en `mixed` es `total − cardAmount`. */
  cashDue: number;
  cardAmount: number | null;
}

export interface ListSalesParams {
  cashSessionId?: string;
  includeVoided?: boolean;
  from?: string;
  to?: string;
  search?: string;
  /** Ignorados: el catálogo local no pagina contra un servidor. Se aceptan por compatibilidad. */
  page?: number;
  limit?: number;
}

/** Un elemento de la respuesta de `POST /sales/bulk`, en el mismo orden que se mandó. */
type BulkSaleResult = { ok: true; sale: { id: string; folio: string } } | { ok: false; error: string };

interface SaleDto {
  id: string;
  folio: string;
  items: SaleItem[];
  subtotal: number;
  discountTotal: number;
  total: number;
  paymentMethod: string;
  amountReceived: number | null;
  change: number | null;
  cashAmount?: number | null;
  cardAmount?: number | null;
  cardPaymentReference: string | null;
  cashierId: string;
  cashSessionId: string | null;
  customerId?: string | null;
  customerName?: string | null;
  prescription?: SalePrescription | null;
  prescriptionRetained?: boolean;
  controlledGroups?: unknown;
  taxSummary?: Sale['taxSummary'];
  billing?: SaleBilling | null;
  invoiceStatus?: 'pending' | null;
  voidedAt: unknown;
  createdAt: unknown;
}

/** uuid v4 cuando el entorno lo soporta; fallback para WebViews viejos de Electron. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function toSaleItems(cart: CartLine[]): SaleItem[] {
  return cart.map((line) => {
    const comun = {
      unitPrice: lineUnitPrice(line),
      discountAmount: line.discountAmount,
      quantity: line.quantity,
      subtotal: lineUnitPrice(line) * line.quantity,
    };
    if (isProductLine(line)) {
      // Id LOCAL: es la copia que vive en SQLite y la que ve el ticket.
      return { ...comun, kind: 'product' as const, productId: line.product.id, productName: line.product.name };
    }
    return {
      ...comun,
      kind: 'service' as const,
      serviceId: line.service.id,
      productName: line.service.name,
      providerId: line.provider?.id ?? null,
      providerName: line.provider?.name ?? null,
      // Congelada: la tarifa del catálogo puede cambiar después, lo devengado no.
      commissionRate: lineCommissionRate(line),
      commissionAmount: lineCommission(line),
    };
  });
}

/** Solo para el `void()` de una venta ya sincronizada (`POST /sales/:id/void` sigue siendo online). */
function mapRemoteSale(dto: SaleDto): Sale {
  return {
    id: dto.id,
    remoteId: dto.id,
    pendingPush: false,
    folio: dto.folio,
    items: dto.items,
    subtotal: dto.subtotal,
    discountTotal: dto.discountTotal,
    total: dto.total,
    taxSummary: dto.taxSummary ?? null,
    paymentMethod: dto.paymentMethod as PaymentMethod,
    amountReceived: dto.amountReceived,
    change: dto.change,
    cashAmount: dto.cashAmount ?? null,
    cardAmount: dto.cardAmount ?? null,
    cardPaymentReference: dto.cardPaymentReference,
    cashierId: dto.cashierId,
    cashSessionId: dto.cashSessionId,
    customerId: dto.customerId ?? null,
    customerName: dto.customerName ?? null,
    prescription: dto.prescription ?? null,
    prescriptionRetained: dto.prescriptionRetained === true,
    controlledGroups: Array.isArray(dto.controlledGroups)
      ? dto.controlledGroups.filter(isControlledGroup)
      : [],
    billing: dto.billing ?? null,
    invoiceStatus: dto.invoiceStatus ?? null,
    voidedAt: dto.voidedAt ? new Date(dto.voidedAt as string) : null,
    createdAt: new Date(dto.createdAt as string),
  };
}

/**
 * Ventas local-first: `create()` siempre escribe en el SQLite de Electron
 * (`electron/db/sales.js`), nunca directo al backend. `flushQueue()` (llamada
 * por `SyncScheduler` en los horarios fijos, o a mano desde la pantalla) es lo
 * único que de verdad manda `POST /sales`.
 */
@Injectable({ providedIn: 'root' })
export class SaleService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly apiUrl = environment.apiUrl;

  private flushing = false;

  /** Cuántas ventas locales siguen sin subir (sin contar las bloqueadas). */
  readonly pendingCount = signal(0);
  /** Ventas locales pendientes de enviar, para que el cajero las vea. */
  readonly pendingSales = signal<Array<{ queueId: string; folioHint: string; total: number }>>([]);
  /** Ventas que el servidor rechazó en el último intento; no se reintentan solas. */
  readonly blockedSales = signal<Array<{ queueId: string; folioHint: string; reason: string }>>([]);
  /** Se conserva por compatibilidad con pantallas que lo leen; local ya no trunca. */
  readonly lastListTruncated = signal(false);

  constructor() {
    this.refreshPending();
  }

  buildPayload(
    cart: CartLine[],
    saleDiscountAmount: number,
    paymentMethod: PaymentMethod,
    amountReceived: number | null,
    cardPaymentReference: string | null,
    cashSessionId: string,
    extras: {
      customerId?: string | null;
      customerName?: string | null;
      prescription?: SalePrescription | null;
      prescriptionRetained?: boolean;
      billing?: SaleBilling | null;
      /** Parte con tarjeta capturada por el cajero (mixto sin terminal). */
      cardAmount?: number | null;
      /**
       * Llave del cobro en curso. El checkout la genera una vez y la reusa en cada
       * reintento del mismo cobro; sin ella se genera una nueva (cobro nuevo).
       */
      idempotencyKey?: string;
    } = {},
  ): CreateSalePayload {
    return {
      idempotencyKey: extras.idempotencyKey ?? newIdempotencyKey(),
      // El backend conoce el producto por su id de Firestore (`remoteId`), no
      // por el id local de SQLite (`id`) — son el mismo producto pero con
      // identidades distintas a cada lado hasta que el catálogo sincroniza.
      items: cart.map((line) =>
        isProductLine(line)
          ? {
              kind: 'product' as const,
              productId: line.product.remoteId ?? line.product.id,
              quantity: line.quantity,
              discountAmount: line.discountAmount,
              // Precio **cobrado**, no el que tenga el catálogo al sincronizar.
              // Una venta sin conexión que subía después de un cambio de precio
              // se rechazaba con "el monto recibido es menor al total": el
              // servidor la tarifaba de nuevo con el precio nuevo.
              unitPrice: lineUnitPrice(line),
            }
          : {
              // El catálogo de servicios es solo-pull: su `id` ya es el remoto,
              // así que no hay identidad local que traducir al sincronizar.
              kind: 'service' as const,
              serviceId: line.service.id,
              quantity: line.quantity,
              discountAmount: line.discountAmount,
              providerId: line.provider?.id ?? null,
            },
      ),
      saleDiscountAmount,
      paymentMethod,
      amountReceived,
      cardPaymentReference,
      ...(extras.cardAmount === undefined || extras.cardAmount === null
        ? {}
        : { cardAmount: extras.cardAmount }),
      cashSessionId,
      customerId: extras.customerId ?? null,
      customerName: extras.customerName ?? null,
      prescription: extras.prescription ?? null,
      ...(extras.prescriptionRetained === undefined
        ? {}
        : { prescriptionRetained: extras.prescriptionRetained }),
      billing: extras.billing ?? null,
    };
  }

  list(params: ListSalesParams = {}): Observable<Sale[]> {
    return from(
      this.api().sales.list({
        cashSessionId: params.cashSessionId,
        includeVoided: params.includeVoided,
        from: params.from,
        to: params.to,
        search: params.search,
      }),
    );
  }

  /** Ya no pagina contra un servidor: el catálogo local siempre cabe en una sola llamada. */
  listAll(params: Omit<ListSalesParams, 'page' | 'limit'> = {}): Observable<Sale[]> {
    this.lastListTruncated.set(false);
    return this.list(params);
  }

  create(payload: CreateSalePayload, cart: CartLine[], totals: SaleTotals): Observable<Sale> {
    const tender = resolveTender({
      paymentMethod: payload.paymentMethod,
      total: totals.total,
      amountReceived: payload.amountReceived,
      cardAmount: totals.cardAmount,
    });

    const input: LocalSaleInput = {
      idempotencyKey: payload.idempotencyKey,
      folio: `PENDIENTE-${Date.now()}`,
      items: toSaleItems(cart),
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
      // Desglose fiscal propio: se calcula con la misma aritmética del backend,
      // que lo recalculará (autoritativo) al sincronizar.
      taxSummary: previewTaxSummary(
        cart.map((line) => ({ product: lineTaxable(line), grossAmount: lineGross(line) })),
        payload.saleDiscountAmount,
      ),
      paymentMethod: payload.paymentMethod,
      amountReceived: payload.amountReceived,
      change: payload.amountReceived !== null ? tender.change : null,
      cashAmount: tender.cashAmount,
      cardAmount: tender.cardAmount,
      cardPaymentReference: payload.cardPaymentReference,
      cashierId: this.auth.user()?.uid ?? '',
      cashierLabel: this.auth.user()?.email ?? undefined,
      cashSessionId: payload.cashSessionId,
      customerId: payload.customerId ?? null,
      customerName: payload.customerName ?? null,
      prescription: payload.prescription ?? null,
      prescriptionRetained: payload.prescriptionRetained === true,
      // Solo productos: un servicio nunca es una sustancia controlada.
      controlledGroups: resolveControlledRequirements(
        cart.filter(isProductLine).map((line) => line.product),
      ).groups,
      billing: payload.billing ?? null,
      invoiceStatus: payload.billing ? 'pending' : null,
      // Denormalizados por rama: el corte proyecta la venta y nunca recorre sus
      // partidas, así que el bloque de servicios tiene que poder calcularse sin
      // abrirlas. El backend los recalcula de forma autoritativa al sincronizar.
      pharmacyTotal: pharmacyTotalOf(cart),
      servicesTotal: servicesTotalOf(cart),
      commissionTotal: commissionTotalOf(cart),
      ...splitCash(tender.cashAmount ?? 0, servicesTotalOf(cart)),
      payload,
    };

    return from(this.api().sales.createLocal(input)).pipe(tap(() => this.refreshPending()));
  }

  /**
   * Anula la venta. Si nunca sincronizó, todo pasa en local (no existe nada que
   * anular en el servidor). Si ya sincronizó, primero se anula en el backend
   * (online) y el resultado se refleja en la copia local.
   */
  void(sale: Sale): Observable<Sale> {
    const voidedBy = this.auth.user()?.uid ?? '';
    const voidedByLabel = this.auth.user()?.email ?? undefined;
    if (sale.pendingPush || !sale.remoteId) {
      return from(this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel)).pipe(
        switchMap((voided) =>
          voided ? of(voided) : throwError(() => new Error('Venta no encontrada.')),
        ),
        tap(() => this.refreshPending()),
      );
    }
    return this.http.post<unknown>(`${this.apiUrl}/sales/${sale.remoteId}/void`, {}).pipe(
      map((response) => mapRemoteSale(unwrapEntity<SaleDto>(response))),
      switchMap((voided) =>
        from(this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel)).pipe(
          map(() => voided),
        ),
      ),
      catchError((error: unknown) => {
        /**
         * **Sin red** la anulación no puede quedarse esperando a que vuelva el
         * internet: el cliente está enfrente y el dinero ya se devolvió. Se anula
         * en local (repone stock) y se marca para cerrarla en el servidor en el
         * próximo sync, con la misma maquinaria que resuelve la carrera de
         * `markSynced` (`needsRemoteVoid` → `reconcileRemoteVoids`).
         *
         * Cualquier otro error **sí** se propaga: un 400 ("ya está anulada",
         * "tiene devoluciones") o un 403 de rol son negativas del servidor, y
         * anular en local de todos modos dejaría las dos bases discrepando.
         */
        if (getApiErrorStatus(error) !== 0) {
          throw error;
        }
        return from(this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel)).pipe(
          switchMap((voided) =>
            voided
              ? from(this.api().sales.markNeedsRemoteVoid(sale.id)).pipe(map(() => voided))
              : throwError(() => new Error('Venta no encontrada.')),
          ),
          tap(() => this.refreshPending()),
        );
      }),
    );
  }

  /** Bitácora de la venta: cobro y anulación, con quién y cuándo. */
  movements(saleId: string): Observable<SaleMovement[]> {
    return from(this.api().sales.listMovements(saleId));
  }

  /** Descarta una venta rechazada por el servidor (decisión explícita del cajero). */
  discardBlockedSale(queueId: string): void {
    from(this.api().sales.discard(queueId)).subscribe(() => this.refreshPending());
  }

  /**
   * Vuelve a intentar una venta bloqueada. Se usa después de corregir la causa
   * (abrir turno, reponer stock): la `idempotencyKey` es la misma, así que si el
   * intento anterior sí llegó, el backend devuelve la venta ya registrada.
   */
  retryBlockedSale(queueId: string): void {
    from(this.api().sales.clearPushError(queueId)).subscribe(() => {
      this.refreshPending();
      this.flushQueue();
    });
  }

  /**
   * Envía TODAS las ventas locales pendientes en una sola llamada a
   * `POST /sales/bulk`, en el orden en que se capturaron — nunca un `POST
   * /sales` por venta. Cada una viaja con su `idempotencyKey` original: si un
   * intento anterior sí llegó al servidor y se perdió la respuesta, el backend
   * devuelve la venta ya registrada en vez de duplicarla.
   *
   * El backend procesa el lote y responde con un resultado por índice: una
   * venta rechazada (turno cerrado, sin stock…) no tumba el resto ni hace
   * fallar la llamada completa. Solo si la llamada en sí falla (red, 401, 500)
   * no se marca nada y se reintenta en el próximo sync.
   */
  flushQueue(): void {
    this.flush$().subscribe();
  }

  /**
   * Igual que `flushQueue()`, pero esperable. El sincronizador la necesita para
   * subir las ventas **antes** de cerrar el turno: si el cierre gana la carrera,
   * el backend rechaza la venta con "el turno de caja ya está cerrado".
   */
  flushQueueAsync(): Promise<void> {
    return firstValueFrom(this.flush$().pipe(defaultIfEmpty(null))).then(() => undefined);
  }

  private flush$(): Observable<unknown> {
    if (this.flushing) {
      return EMPTY;
    }
    this.flushing = true;
    return from(this.api().sales.getPendingPush(pushOwnerFilter(this.auth)))
      .pipe(
        // Un fallo del propio IPC (p. ej. SQLite bloqueada) no debe tumbar la
        // suscripción sin dejar rastro: se degrada a "nada pendiente" en este
        // intento y se reintenta en el siguiente sync.
        catchError(() => of([] as never[])),
        switchMap((pending) => {
          if (!pending.length) {
            return of(null);
          }
          return this.http
            .post<unknown>(`${this.apiUrl}/sales/bulk`, {
              items: pending.map((item) => item.payload),
            })
            .pipe(
              switchMap((response) => {
                const results = unwrapEntity<BulkSaleResult[]>(response);
                const marks = pending.map((item, index) => {
                  const result = results[index];
                  if (!result) {
                    return of(undefined);
                  }
                  return result.ok
                    ? from(this.api().sales.markSynced(item.id, result.sale.id, result.sale.folio))
                    : this.handleRejected(item, result.error);
                });
                return forkJoin(marks);
              }),
              catchError(() => of(null)),
            );
        }),
        tap(() => {
          this.pushVoidedSales();
          this.reconcileRemoteVoids();
        }),
        finalize(() => {
          this.flushing = false;
          this.refreshPending();
        }),
      );
  }

  /**
   * Qué hacer con una venta que el servidor rechazó.
   *
   * El dinero ya se cobró y el ticket ya se imprimió: la venta **no** puede
   * quedarse muerta en la caja. Si el motivo es de inventario (stock que no
   * alcanza allá, producto que no existe), reintentar no la va a arreglar —el
   * stock remoto no se corrige solo—, así que se registra en
   * `unreconciledSales`: el movimiento y el importe quedan guardados en el
   * servidor, el inventario no se descuadra, y alguien concilia a mano.
   *
   * El resto de rechazos (turno cerrado, llave reciclada) sí se marcan como
   * bloqueados: son decisiones que el cajero puede corregir y reintentar.
   */
  private handleRejected(item: PendingSale, error: string): Observable<unknown> {
    if (!this.isInventoryRejection(error)) {
      return from(this.api().sales.markPushFailed(item.id, error));
    }

    return this.http
      .post<unknown>(`${this.apiUrl}/sales/unreconciled`, {
        localId: item.id,
        localFolio: item.folio,
        reason: error,
        total: item.total,
        occurredAt: item.createdAt.toISOString(),
        ...(item.cashSessionId ? { cashSessionId: item.cashSessionId } : {}),
        payload: item.payload,
      })
      .pipe(
        // Registrada aparte: sale de la cola para que el badge no mienta, pero
        // el historial la sigue mostrando con su motivo.
        switchMap(() => from(this.api().sales.markUnreconciled(item.id, error))),
        // Si ni eso se pudo, se marca como bloqueada y el cajero la ve.
        catchError(() => from(this.api().sales.markPushFailed(item.id, error))),
      );
  }

  /** Rechazo por inventario: no se resuelve reintentando el mismo push. */
  private isInventoryRejection(error: string): boolean {
    const normalized = error.toLowerCase();
    return (
      normalized.includes('stock') ||
      normalized.includes('lote') ||
      normalized.includes('producto no encontrado') ||
      normalized.includes('producto no existe')
    );
  }

  /**
   * Ventas anuladas que **nunca** llegaron al servidor: se crean y se anulan
   * allá, en dos pasos. Sin esto el backend no se entera de que esa venta
   * ocurrió, y el libro de control se queda sin el asiento ni su reversa.
   */
  private pushVoidedSales(): void {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    from(api.sales.getPendingVoided())
      .pipe(
        catchError(() => of([])),
        switchMap((pending) => {
          if (!pending.length) {
            return of(null);
          }
          const pushes = pending.map((item) =>
            this.http
              .post<unknown>(`${this.apiUrl}/sales`, item.payload)
              .pipe(
                map((response) => mapRemoteSale(unwrapEntity<SaleDto>(response))),
                switchMap((created) =>
                  this.http
                    .post<unknown>(`${this.apiUrl}/sales/${created.id}/void`, {
                      ...(item.voidedAt ? { voidedAt: item.voidedAt } : {}),
                      ...(item.voidedBy ? { voidedBy: item.voidedBy } : {}),
                    })
                    .pipe(
                      switchMap(() =>
                        from(api.sales.markSynced(item.id, created.id, created.folio)),
                      ),
                      switchMap(() => from(api.sales.markRemoteVoided(item.id))),
                    ),
                ),
                // Un fallo deja la venta como estaba: se reintenta en el próximo
                // sync. Crear sin anular queda cubierto por `needsRemoteVoid`.
                catchError((error: unknown) =>
                  from(this.api().sales.markPushFailed(item.id, getApiErrorMessage(error))),
                ),
              ),
          );
          return forkJoin(pushes);
        }),
        catchError(() => of(null)),
      )
      .subscribe(() => this.refreshPending());
  }

  /**
   * Ventas que se anularon en local justo mientras su push seguía en vuelo
   * (`markSynced` detectó la carrera y las marcó `needsRemoteVoid` en vez de
   * darlas por sincronizadas sin más): el servidor las tiene activas, hace
   * falta el `POST /sales/:id/void` remoto explícito para cerrarlas.
   */
  private reconcileRemoteVoids(): void {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    from(api.sales.getNeedingRemoteVoid())
      .pipe(
        switchMap((pending) => {
          if (!pending.length) {
            return of(null);
          }
          const voids = pending.map((item) =>
            this.http
              .post<unknown>(`${this.apiUrl}/sales/${item.remoteId}/void`, {
                // Sin esto el backend sellaría la anulación con la hora del sync
                // y a nombre de quien sincronizó, que puede ser otro turno.
                ...(item.voidedAt ? { voidedAt: item.voidedAt } : {}),
                ...(item.voidedBy ? { voidedBy: item.voidedBy } : {}),
              })
              .pipe(
              switchMap(() => from(api.sales.markRemoteVoided(item.id))),
              // Un fallo aquí (red, 404 si ya se anuló por otra vía) se reintenta en
              // el próximo sync: el flag `needsRemoteVoid` no se limpia solo.
              catchError(() => of(undefined)),
            ),
          );
          return forkJoin(voids);
        }),
        catchError(() => of(null)),
      )
      .subscribe();
  }

  private refreshPending(): void {
    const api = window.electronAPI;
    if (!api) {
      // Fuera de Electron (`ng serve` en navegador): no hay nada que leer. Se
      // resuelve en silencio para no tumbar el constructor del servicio, que se
      // instancia igual con solo abrir el shell aunque el cajero nunca cobre.
      return;
    }
    from(api.sales.getPendingPush(pushOwnerFilter(this.auth))).subscribe((pending) => {
      const notBlocked = pending.filter((item) => !item.pushError);
      const blocked = pending.filter((item) => item.pushError);
      const hint = (sale: { items: unknown[]; total: number }) =>
        `${sale.items.length} art. · $${sale.total.toFixed(2)}`;
      this.pendingSales.set(
        notBlocked.map((sale) => ({ queueId: sale.id, folioHint: hint(sale), total: sale.total })),
      );
      this.blockedSales.set(
        blocked.map((sale) => ({
          queueId: sale.id,
          folioHint: hint(sale),
          reason: sale.pushError ?? '',
        })),
      );
      this.pendingCount.set(notBlocked.length);
    });
  }

  private api() {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI no disponible: las ventas requieren correr dentro de Electron.');
    }
    return api;
  }
}
