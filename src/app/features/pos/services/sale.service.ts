import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  catchError,
  concatMap,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';

import { getApiErrorMessage, toDate, unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import {
  CartLine,
  PaymentMethod,
  Sale,
  SaleBilling,
  SaleItem,
  SalePrescription,
  SaleTaxSummary,
} from '../../../shared/models';
import {
  isControlledGroup,
  resolveControlledRequirements,
} from '../../../shared/utils/controlled';
import { previewTaxSummary } from '../../../shared/utils/taxes';
import { resolveTender } from '../../../shared/utils/tender';
import { environment } from '../../../../environments/environment';

export interface CreateSalePayload {
  /**
   * Llave de idempotencia: la genera el POS por cobro y se reenvía **sin cambios**
   * en cada retry (incluido el flush de la cola offline). Sin ella un reintento
   * después de un timeout crea una venta duplicada y descuadra el turno.
   */
  idempotencyKey: string;
  items: Array<{ productId: string; quantity: number; discountAmount: number }>;
  saleDiscountAmount: number;
  paymentMethod: PaymentMethod;
  amountReceived: number | null;
  cardPaymentReference: string | null;
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
  page?: number;
  limit?: number;
}

interface QueuedSalePayload extends CreateSalePayload {
  queueId: string;
  offlineItems: SaleItem[];
  offlineTotals: SaleTotals;
  /** Motivo por el que el reenvío se detuvo; requiere intervención del cajero. */
  blockedReason?: string;
}

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
  taxSummary?: SaleTaxSummary | null;
  billing?: SaleBilling | null;
  invoiceStatus?: 'pending' | null;
  voidedAt: unknown;
  createdAt: unknown;
}

const PENDING_SALES_KEY = 'pos.pending-sales';

/** uuid v4 cuando el entorno lo soporta; fallback para WebViews viejos de Electron. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function toSaleItems(cart: CartLine[]): SaleItem[] {
  return cart.map((line) => ({
    productId: line.product.id,
    productName: line.product.name,
    unitPrice: line.product.salePrice,
    discountAmount: line.discountAmount,
    quantity: line.quantity,
    subtotal: line.product.salePrice * line.quantity,
  }));
}

function mapSale(dto: SaleDto): Sale {
  return {
    id: dto.id,
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
    voidedAt: dto.voidedAt ? toDate(dto.voidedAt) : null,
    createdAt: toDate(dto.createdAt),
  };
}

@Injectable({ providedIn: 'root' })
export class SaleService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  private flushing = false;

  readonly pendingCount = signal(this.readQueue().length);
  /** Ventas en cola que el servidor rechazó y no se reintentan solas. */
  readonly blockedSales = signal<Array<{ queueId: string; folioHint: string; reason: string }>>(
    this.readBlocked(),
  );

  constructor() {
    window.addEventListener('online', () => this.flushQueue());
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
      /**
       * Llave del cobro en curso. El checkout la genera una vez y la reusa en cada
       * reintento del mismo cobro; sin ella se genera una nueva (cobro nuevo).
       */
      idempotencyKey?: string;
    } = {},
  ): CreateSalePayload {
    return {
      idempotencyKey: extras.idempotencyKey ?? newIdempotencyKey(),
      items: cart.map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
        discountAmount: line.discountAmount,
      })),
      saleDiscountAmount,
      paymentMethod,
      amountReceived,
      cardPaymentReference,
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
    let httpParams = new HttpParams();
    if (params.cashSessionId) {
      httpParams = httpParams.set('cashSessionId', params.cashSessionId);
    }
    if (params.includeVoided !== undefined) {
      httpParams = httpParams.set('includeVoided', String(params.includeVoided));
    }
    if (params.from) {
      httpParams = httpParams.set('from', params.from);
    }
    if (params.to) {
      httpParams = httpParams.set('to', params.to);
    }
    if (params.search) {
      httpParams = httpParams.set('search', params.search);
    }
    if (params.page !== undefined) {
      httpParams = httpParams.set('page', String(params.page));
    }
    if (params.limit !== undefined) {
      httpParams = httpParams.set('limit', String(params.limit));
    }
    return this.http
      .get<unknown>(`${this.apiUrl}/sales`, { params: httpParams })
      .pipe(map((response) => unwrapList<SaleDto>(response).map(mapSale)));
  }

  listAll(params: Omit<ListSalesParams, 'page' | 'limit'> = {}): Observable<Sale[]> {
    const pageSize = 100;
    const fetchPage = (page: number, acc: Sale[]): Observable<Sale[]> =>
      this.list({ ...params, page, limit: pageSize }).pipe(
        switchMap((sales) => {
          const all = [...acc, ...sales];
          return sales.length < pageSize ? of(all) : fetchPage(page + 1, all);
        }),
      );
    return fetchPage(1, []);
  }

  get(saleId: string): Observable<Sale> {
    return this.http
      .get<unknown>(`${this.apiUrl}/sales/${saleId}`)
      .pipe(map((response) => mapSale(unwrapEntity<SaleDto>(response))));
  }

  create(payload: CreateSalePayload, cart: CartLine[], totals: SaleTotals): Observable<Sale> {
    return this.http.post<unknown>(`${this.apiUrl}/sales`, payload).pipe(
      map((response) => mapSale(unwrapEntity<SaleDto>(response))),
      catchError((error) => {
        if (this.isOffline(error)) {
          return of(this.enqueueOffline(payload, cart, totals));
        }
        throw error;
      }),
    );
  }

  void(saleId: string): Observable<Sale> {
    return this.http
      .post<unknown>(`${this.apiUrl}/sales/${saleId}/void`, {})
      .pipe(map((response) => mapSale(unwrapEntity<SaleDto>(response))));
  }

  /**
   * Reenvía la cola en orden de captura. Cada venta viaja con su `idempotencyKey`
   * original: si el POST anterior sí llegó al servidor y se perdió la respuesta, el
   * backend responde con la venta ya registrada en vez de duplicarla.
   *
   * Los envíos van en serie (`concatMap`) para no perder el orden de folios ni
   * abrir N peticiones al recuperar la red.
   */
  flushQueue(): void {
    if (this.flushing) {
      return;
    }
    const queue = this.readQueue().filter((item) => !item.blockedReason);
    if (queue.length === 0) {
      return;
    }
    this.flushing = true;
    from(queue)
      .pipe(
        concatMap((item) => {
          const { queueId, offlineItems, offlineTotals, blockedReason, ...payload } = item;
          void offlineItems;
          void offlineTotals;
          void blockedReason;
          return this.http.post<unknown>(`${this.apiUrl}/sales`, payload).pipe(
            tap(() => this.removeFromQueue(queueId)),
            catchError((error: unknown) => {
              // 4xx = la venta nunca va a pasar tal cual (turno cerrado, sin stock,
              // order Point reusada). Se marca y deja de reintentarse para que el
              // cajero la vea en vez de girar en vacío contra el servidor.
              if (this.isPermanentFailure(error)) {
                this.blockInQueue(queueId, getApiErrorMessage(error));
              }
              return EMPTY;
            }),
          );
        }),
        finalize(() => {
          this.flushing = false;
        }),
      )
      .subscribe();
  }

  private isOffline(error: unknown): boolean {
    return error instanceof HttpErrorResponse && error.status === 0;
  }

  /** Error del cliente que no se resuelve reintentando (excluye auth y rate limit). */
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

  private enqueueOffline(payload: CreateSalePayload, cart: CartLine[], totals: SaleTotals): Sale {
    const now = toDate(new Date().toISOString());
    const queued: QueuedSalePayload = {
      ...payload,
      queueId: payload.idempotencyKey,
      offlineItems: toSaleItems(cart),
      offlineTotals: totals,
    };
    const queue = this.readQueue();
    queue.push(queued);
    this.writeQueue(queue);
    // El cambio se calcula contra la parte en efectivo, igual que en el backend:
    // en pago mixto la tarjeta ya cubrió `cardAmount` y restarlo del total sería
    // devolverle al cliente dinero que nunca entregó en efectivo.
    const tender = resolveTender({
      paymentMethod: payload.paymentMethod,
      total: totals.total,
      amountReceived: payload.amountReceived,
      cardAmount: totals.cardAmount,
    });
    return {
      id: `offline-${now.getTime()}`,
      folio: `PENDIENTE-${now.getTime()}`,
      items: queued.offlineItems,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
      // Ticket offline con desglose fiscal propio: se calcula con la misma
      // aritmética del backend, que lo recalculará al sincronizar.
      taxSummary: previewTaxSummary(
        cart.map((line) => ({
          product: line.product,
          grossAmount: line.product.salePrice * line.quantity - line.discountAmount,
        })),
        payload.saleDiscountAmount,
      ),
      paymentMethod: payload.paymentMethod,
      amountReceived: payload.amountReceived,
      change: payload.amountReceived !== null ? tender.change : null,
      cashAmount: tender.cashAmount,
      cardAmount: tender.cardAmount,
      cardPaymentReference: payload.cardPaymentReference,
      cashierId: '',
      cashSessionId: payload.cashSessionId,
      customerId: payload.customerId ?? null,
      customerName: payload.customerName ?? null,
      prescription: payload.prescription ?? null,
      prescriptionRetained: payload.prescriptionRetained === true,
      controlledGroups: resolveControlledRequirements(cart.map((line) => line.product)).groups,
      billing: payload.billing ?? null,
      invoiceStatus: payload.billing ? 'pending' : null,
      voidedAt: null,
      createdAt: now,
    };
  }

  private removeFromQueue(queueId: string): void {
    const queue = this.readQueue().filter((item) => item.queueId !== queueId);
    this.writeQueue(queue);
  }

  private blockInQueue(queueId: string, reason: string): void {
    this.writeQueue(
      this.readQueue().map((item) =>
        item.queueId === queueId ? { ...item, blockedReason: reason } : item,
      ),
    );
  }

  /** Descarta una venta rechazada por el servidor (decisión explícita del cajero). */
  discardBlockedSale(queueId: string): void {
    this.removeFromQueue(queueId);
  }

  /**
   * Vuelve a poner en cola una venta bloqueada e intenta enviarla. Se usa después de
   * corregir la causa (abrir turno, reponer stock): la `idempotencyKey` es la misma,
   * así que si el intento anterior sí llegó, el backend devuelve la venta existente.
   */
  retryBlockedSale(queueId: string): void {
    this.writeQueue(
      this.readQueue().map((item) =>
        item.queueId === queueId ? { ...item, blockedReason: undefined } : item,
      ),
    );
    this.flushQueue();
  }

  private readQueue(): QueuedSalePayload[] {
    try {
      const raw = localStorage.getItem(PENDING_SALES_KEY);
      const parsed = raw ? (JSON.parse(raw) as QueuedSalePayload[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private readBlocked(): Array<{ queueId: string; folioHint: string; reason: string }> {
    return this.readQueue()
      .filter((item) => item.blockedReason)
      .map((item) => ({
        queueId: item.queueId,
        folioHint: `${item.offlineItems.length} art. · $${item.offlineTotals.total.toFixed(2)}`,
        reason: item.blockedReason ?? '',
      }));
  }

  private writeQueue(queue: QueuedSalePayload[]): void {
    localStorage.setItem(PENDING_SALES_KEY, JSON.stringify(queue));
    this.pendingCount.set(queue.length);
    this.blockedSales.set(this.readBlocked());
  }
}
