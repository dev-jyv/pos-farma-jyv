import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import {
  Observable,
  catchError,
  concat,
  concatMap,
  defaultIfEmpty,
  defer,
  finalize,
  firstValueFrom,
  lastValueFrom,
  forkJoin,
  from,
  last,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';

import { getApiErrorStatus, unwrapEntity } from '../../../core/api/api.utils';
import { AuthService } from '../../../core/auth/auth.service';
import { AutoPushService } from '../../../core/sync/auto-push.service';
import {
  CartLine,
  PaymentMethod,
  Sale,
  SaleBilling,
  SaleCoupon,
  SaleItem,
  SalePrescription,
  SaleStockShortfall,
  SaleSyncReview,
} from '../../../shared/models';
import {
  isControlledGroup,
  resolveControlledRequirements,
} from '../../../shared/utils/controlled';
import { LocalSaleInput, PendingSale, SaleMovement } from '../../../core/electron/window.d';
import {
  commissionTotalOf,
  isBoxLine,
  isProductLine,
  isServiceLine,
  lineCommission,
  lineCommissionRate,
  lineGross,
  linePieces,
  linePiecesPerUnit,
  lineTaxable,
  lineUnitPrice,
  pharmacyTotalOf,
  servicesTotalOf,
  splitCash,
} from '../../../shared/utils/cart-line';
import { previewTaxSummary, prorateDiscount } from '../../../shared/utils/taxes';
import { fromCents, toCents } from '../../../shared/utils/money';
import { resolveTender } from '../../../shared/utils/tender';
import { environment } from '../../../../environments/environment';
import { pushOwnerFilter } from '../../../core/sync/push-owner';
import { CartStorageService } from './cart-storage.service';
import {
  SyncFailure,
  SyncRejectionError,
  legacyAlreadyVoided,
  legacySaleRejectionAction,
  syncActionFor,
  syncFailureFromError,
  syncFailureFromResult,
  withSyncCode,
} from '../../../core/sync/sync-error-codes';

export interface CreateSalePayload {
  /**
   * Llave de idempotencia: la genera el POS por cobro y se reenvía **sin cambios**
   * en cada reintento del push (incluidos los de `flushQueue`). Sin ella un
   * reintento después de un timeout crea una venta duplicada en el backend.
   */
  idempotencyKey: string;
  /**
   * Hora local del cobro (ISO). El payload se guarda tal cual y se empuja
   * después por `/sales/bulk`; con ella el backend decide si la promoción estaba
   * vigente **cuando se cobró**, no cuando llegó la red.
   */
  soldAt: string;
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
        /** Promoción aplicada; el backend recalcula su monto con la regla guardada. */
        promotionId?: string;
        /**
         * Venta por caja completa (SPEC 46): `quantity` cuenta **cajas** y
         * `unitPrice` es el precio de la caja; el servidor lo convierte a piezas.
         * Nunca va junto con `promotionId`.
         */
        saleUnit?: 'box';
      }
    | {
        kind: 'service';
        serviceId: string;
        quantity: number;
        discountAmount: number;
        /** Precio cobrado por unidad; el backend no debe retarifar al sincronizar. */
        unitPrice: number;
        providerId: string | null;
      }
  >;
  /** Descuento a nivel venta. Hoy solo lo usa un cupón de alcance de venta. */
  saleDiscountAmount: number;
  /**
   * Cupón aplicado (SPEC 47). Uno de producto ya va dentro del `discountAmount`
   * de sus líneas; uno de venta, en `saleDiscountAmount`. El servidor recalcula
   * y, en `/sales/bulk`, nunca rechaza la venta por el cupón.
   */
  couponCode?: string;
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
  /**
   * Uid de quien **cobró** (SPEC 54). No se llena al cobrar: lo agrega
   * `electron/db/sales.js#conAutor` al subir, desde el `cashierId` de la venta
   * local, para que otro usuario pueda subir la cola sin quedarse con la venta
   * ni cambiar su llave de idempotencia.
   */
  soldBy?: string;
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
  /** Solo las de este cajero; sin él, las de todo el equipo (uso de admin). */
  cashierId?: string;
  includeVoided?: boolean;
  from?: string;
  to?: string;
  search?: string;
  /** Ignorados: el catálogo local no pagina contra un servidor. Se aceptan por compatibilidad. */
  page?: number;
  limit?: number;
}

/**
 * Venta tal como la devuelve `/sales/bulk`. Desde SPEC 52 una venta offline con
 * faltante, catálogo inactivo o turno cerrado **se acepta** con su marca.
 */
interface BulkAcceptedSale {
  id: string;
  folio: string;
  stockReview?: { items?: unknown } | null;
  catalogReview?: { inactive?: unknown } | null;
  lateSync?: boolean | null;
}

/** Un elemento de la respuesta de `POST /sales/bulk`, en el mismo orden que se mandó. */
type BulkSaleResult =
  | { ok: true; sale: BulkAcceptedSale }
  /** `code`/`retryable` desde SPEC 49; un backend viejo manda el código HTTP o nada. */
  | { ok: false; error: string; code?: string; retryable?: boolean };

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

function asShortfall(value: unknown): SaleStockShortfall | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (typeof item['productId'] !== 'string') {
    return null;
  }
  const num = (key: string): number => (typeof item[key] === 'number' ? (item[key] as number) : 0);
  return {
    productId: item['productId'],
    requested: num('requested'),
    allocated: num('allocated'),
    shortfall: num('shortfall'),
  };
}

/**
 * Marcas de revisión de una venta aceptada (SPEC 52), o `null` si no trae
 * ninguna. Se toleran formas parciales: la marca existe aunque el detalle no
 * venga completo, y eso es lo que el historial necesita mostrar.
 */
export function syncReviewOf(sale: BulkAcceptedSale): SaleSyncReview | null {
  const stock = sale.stockReview && typeof sale.stockReview === 'object'
    ? {
        items: (Array.isArray(sale.stockReview.items) ? sale.stockReview.items : [])
          .map(asShortfall)
          .filter((item): item is SaleStockShortfall => item !== null),
      }
    : null;
  const catalog = sale.catalogReview && typeof sale.catalogReview === 'object'
    ? {
        inactive: (Array.isArray(sale.catalogReview.inactive) ? sale.catalogReview.inactive : [])
          .filter((id): id is string => typeof id === 'string'),
      }
    : null;
  const late = sale.lateSync === true;
  return stock || catalog || late ? { stock, catalog, late } : null;
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
      return {
        ...comun,
        // Caja (SPEC 46): la partida local guarda **piezas**, igual que el
        // backend, y la caja aparte; el payload sí manda cajas.
        ...(isBoxLine(line)
          ? {
              quantity: linePieces(line),
              saleUnit: {
                type: 'box' as const,
                boxes: line.quantity,
                piecesPerBox: linePiecesPerUnit(line),
                boxPrice: lineUnitPrice(line),
              },
            }
          : {}),
        kind: 'product' as const,
        productId: line.product.id,
        productName: line.product.name,
        ...(line.promotion
          ? {
              promotionId: line.promotion.id,
              promotionName: line.promotion.name,
              promotionDiscount: line.promotion.discountAmount,
            }
          : {}),
        ...(line.coupon ? { couponDiscount: line.coupon.discountAmount } : {}),
      };
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

/**
 * Totales por rama después del descuento de venta, prorrateado por partida con
 * `prorateDiscount` (centavo exacto: farmacia + servicios = total cobrado).
 */
function branchTotals(
  cart: CartLine[],
  saleDiscountAmount: number,
): { pharmacyTotal: number; servicesTotal: number } {
  if (!(saleDiscountAmount > 0)) {
    return { pharmacyTotal: pharmacyTotalOf(cart), servicesTotal: servicesTotalOf(cart) };
  }
  const shares = prorateDiscount(cart.map(lineGross), saleDiscountAmount);
  let pharmacy = 0;
  let services = 0;
  cart.forEach((line, index) => {
    const net = toCents(lineGross(line)) - toCents(shares[index]);
    if (isServiceLine(line)) {
      services += net;
    } else {
      pharmacy += net;
    }
  });
  return { pharmacyTotal: fromCents(pharmacy), servicesTotal: fromCents(services) };
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
/**
 * Tope de ventas por petición (SPEC 48). El backend acepta como máximo 50
 * (`bulkCreateSalesSchema`) y responde 400 al arreglo entero si pasa; además
 * procesa el lote en serie con un presupuesto de 40 s, así que un lote chico
 * también acota lo que queda diferido (`DEFERRED`) y lo que hay que bisecar
 * cuando un backend viejo rechaza el lote por una venta mal formada.
 */
export const BULK_MAX_ITEMS = 50;

/**
 * Por qué una venta de la cola todavía no se puede enviar. En español y en
 * términos de caja: la cajera no sabe qué es un `remoteId`, pero sí entiende que
 * primero tiene que subir su turno.
 */
function motivoDeEspera(esperandoPor: 'turno' | 'catalogo' | undefined): string | null {
  if (esperandoPor === 'turno') {
    return 'Espera a que suba el turno';
  }
  if (esperandoPor === 'catalogo') {
    return 'Espera a que suba un producto nuevo';
  }
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const trozos: T[][] = [];
  for (let inicio = 0; inicio < items.length; inicio += size) {
    trozos.push(items.slice(inicio, inicio + size));
  }
  return trozos;
}

/** Motivo de anulación o descarte (SPEC 62): de 5 a 300 caracteres. */
export const VOID_REASON_MIN_LENGTH = 5;
export const VOID_REASON_MAX_LENGTH = 300;

/**
 * Motivo que viaja con una anulación local hecha **antes** de pedir motivo: el
 * backend exige `reason` y usa este mismo texto con un POS viejo, así el reporte
 * de cancelaciones no distingue entre los dos caminos.
 */
export const LEGACY_VOID_REASON = 'Sin motivo (POS anterior)';

/** Motivo recortado y acotado; `null` si no llega al mínimo. */
export function normalizeVoidReason(reason: string | null | undefined): string | null {
  const trimmed = (reason ?? '').trim();
  return trimmed.length >= VOID_REASON_MIN_LENGTH ? trimmed.slice(0, VOID_REASON_MAX_LENGTH) : null;
}

/**
 * Qué hacer con un fallo del `POST /sales/:id/void` remoto (SPEC 62):
 *
 * - `done`: ya estaba anulada allá (`ALREADY_VOIDED`, o el texto de un backend
 *   sin código);
 * - `rejected`: cualquier otro 4xx (`VOID_FORBIDDEN`, `HAS_RETURNS`,
 *   `SESSION_FORBIDDEN`…): reintentar lo mismo no lo va a cambiar, se muestra en
 *   "Rechazados" y espera a un admin;
 * - `retry`: red, 5xx o `retryable`: sigue en cola sin ruido. 401/408/429 también:
 *   hablan de la sesión o del tráfico, no de la venta.
 */
export function remoteVoidOutcome(failure: SyncFailure): 'done' | 'rejected' | 'retry' {
  const action = syncActionFor(failure);
  if (action === 'done' || (action === null && legacyAlreadyVoided(failure.message))) {
    return 'done';
  }
  if (action === 'retry') {
    return 'retry';
  }
  const status = failure.status;
  if (status === null || status < 400 || status >= 500 || [401, 408, 429].includes(status)) {
    return 'retry';
  }
  return 'rejected';
}

/** 4xx que describen un problema del contenido del lote, no de la ruta o el permiso. */
const BULK_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 409, 413, 422]);

@Injectable({ providedIn: 'root' })
export class SaleService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly autoPush = inject(AutoPushService);
  private readonly cartStorage = inject(CartStorageService);
  private readonly apiUrl = environment.apiUrl;

  private flushing = false;

  /**
   * Ventas que el servidor dejó `DEFERRED` (SPEC 48): se le acabó el presupuesto
   * de tiempo del lote antes de llegar a ellas. Contador monotónico: el envío
   * automático lo lee antes y después de empujar para no contar ese intento como
   * fallido (no hubo rechazo, el servidor solo pidió que se reintente).
   */
  private deferredTotal = 0;
  /** En el empuje en curso ya hubo un `DEFERRED`: los trozos siguientes esperan. */
  private deferredInFlush = false;

  /** Petición en curso o resuelta del id del equipo (`deviceId()`). */
  private deviceIdRequest: Promise<string | null> | null = null;

  /** Cuántas ventas ha diferido el servidor desde que arrancó la app. */
  deferredCount(): number {
    return this.deferredTotal;
  }

  /** Cuántas ventas locales siguen sin subir (sin contar las bloqueadas). */
  readonly pendingCount = signal(0);
  /** Ventas locales pendientes de enviar, para que el cajero las vea. */
  readonly pendingSales = signal<
    Array<{ queueId: string; folioHint: string; total: number; waitingFor: string | null }>
  >([]);
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
      /** Código del cupón aplicado (SPEC 47). */
      couponCode?: string | null;
    } = {},
  ): CreateSalePayload {
    return {
      idempotencyKey: extras.idempotencyKey ?? newIdempotencyKey(),
      soldAt: new Date().toISOString(),
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
              // Solo el id: el monto lo calcula el servidor con la regla, y el
              // tope del 20 % allá excluye la parte de la promo. Una caja nunca
              // lleva promoción (el backend responde 400).
              ...(line.promotion && !isBoxLine(line) ? { promotionId: line.promotion.id } : {}),
              // Caja: cantidad en cajas y precio de la caja (SPEC 46).
              ...(isBoxLine(line) ? { saleUnit: 'box' as const } : {}),
            }
          : {
              // El catálogo de servicios es solo-pull: su `id` ya es el remoto,
              // así que no hay identidad local que traducir al sincronizar.
              kind: 'service' as const,
              serviceId: line.service.id,
              quantity: line.quantity,
              discountAmount: line.discountAmount,
              // Igual que la mercancía: el precio **cobrado**. Una consulta de
              // las 11:00 no puede retarifarse porque el admin subió el precio a
              // la 13:00 — se rechazaba con "el monto recibido es menor al
              // total" y quedaba bloqueada con el dinero ya en el cajón.
              unitPrice: lineUnitPrice(line),
              providerId: line.provider?.id ?? null,
            },
      ),
      saleDiscountAmount,
      // Solo si hay cupón: un payload sin él queda idéntico al de antes (la
      // huella de idempotencia del backend suma el código solo cuando existe).
      ...(extras.couponCode ? { couponCode: extras.couponCode } : {}),
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

  /**
   * `defer` y no `from(...)` directo: `api()` lanza si no hay `electronAPI`, y
   * lanzándolo al construir el observable la excepción salía **fuera** del
   * stream, así que el `catchError` de la pantalla no la veía. El historial
   * quedaba con la tabla vacía y el error solo en la consola — indistinguible
   * de "no hay ventas". Dentro de `defer` el fallo viaja por el canal de error
   * y cada pantalla lo muestra con su propio mensaje.
   */
  list(params: ListSalesParams = {}): Observable<Sale[]> {
    return defer(() =>
      this.api().sales.list({
        cashSessionId: params.cashSessionId,
        cashierId: params.cashierId,
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

  create(
    payload: CreateSalePayload,
    cart: CartLine[],
    totals: SaleTotals,
    coupon: SaleCoupon | null = null,
  ): Observable<Sale> {
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
      //
      // Un cupón de venta (SPEC 47) se reparte entre farmacia y servicios con el
      // mismo prorrateo del desglose fiscal: si no, las dos ramas sumarían más
      // que el total cobrado y el corte no cuadraría.
      ...branchTotals(cart, payload.saleDiscountAmount),
      commissionTotal: commissionTotalOf(cart),
      ...splitCash(tender.cashAmount ?? 0, branchTotals(cart, payload.saleDiscountAmount).servicesTotal),
      ...(coupon ? { coupon } : {}),
      payload,
    };

    // `defer` por lo mismo que `list()`: si no hay `electronAPI`, el cobro debe
    // fallar por el canal de error del observable y no como excepción suelta.
    const uid = this.auth.user()?.uid ?? '';
    return defer(() => this.api().sales.createLocal(input)).pipe(
      tap(() => {
        // En la misma secuencia que confirma la venta en SQLite (SPEC 66): el
        // borrador del ticket ya cobrado se borra antes de avisar a la pantalla.
        // Si la luz se va justo entre las dos, el borrador trae la llave de este
        // cobro y la pantalla lo descarta al restaurarlo (`findByIdempotencyKey`).
        this.cartStorage.clear(uid);
        this.refreshPending();
        // Sube en segundo plano (debounce): nunca baja el catálogo.
        this.autoPush.notifyChange();
      }),
    );
  }

  /**
   * Anula la venta. Si nunca sincronizó, todo pasa en local (no existe nada que
   * anular en el servidor). Si ya sincronizó, primero se anula en el backend
   * (online) y el resultado se refleja en la copia local.
   *
   * La decisión se basa en `remoteId`, no en `pendingPush`: la lista puede
   * seguir mostrando `pendingPush: true` después de que el sync ya escribió el
   * `remoteId` en SQLite, y con el criterio viejo la anulación quedaba solo en
   * local sin encolar el void remoto.
   */
  void(sale: Sale, reason: string): Observable<Sale> {
    // Motivo obligatorio (SPEC 62): se guarda en la venta local y viaja con la
    // anulación, en línea o diferida.
    const motivo = normalizeVoidReason(reason);
    if (!motivo) {
      return throwError(
        () => new Error(`Escribe el motivo de la anulación (mínimo ${VOID_REASON_MIN_LENGTH} caracteres).`),
      );
    }
    const voidedBy = this.auth.user()?.uid ?? '';
    const voidedByLabel = this.auth.user()?.email ?? undefined;
    if (!sale.remoteId) {
      return defer(() => this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel, motivo)).pipe(
        switchMap((voided) =>
          voided ? of(voided) : throwError(() => new Error('Venta no encontrada.')),
        ),
        tap(() => {
          this.refreshPending();
          this.autoPush.notifyChange();
        }),
      );
    }
    const remoteId = sale.remoteId;
    return this.http.post<unknown>(`${this.apiUrl}/sales/${remoteId}/void`, { reason: motivo }).pipe(
      switchMap(() =>
        from(this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel, motivo)).pipe(
          switchMap((voided) => {
            if (!voided) {
              return throwError(() => new Error('Venta no encontrada.'));
            }
            // `voidLocal` encola `needsRemoteVoid` cuando hay remoteId; el void
            // remoto ya corrió, así que se limpia el flag.
            return from(this.api().sales.markRemoteVoided(sale.id)).pipe(
              map(() => ({ ...voided, id: sale.id, remoteId })),
            );
          }),
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
        return from(this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel, motivo)).pipe(
          switchMap((voided) =>
            voided
              ? from(this.api().sales.markNeedsRemoteVoid(sale.id)).pipe(
                  map(() => ({ ...voided, id: sale.id, remoteId })),
                )
              : throwError(() => new Error('Venta no encontrada.')),
          ),
          tap(() => this.refreshPending()),
        );
      }),
    );
  }

  /** Bitácora de la venta: cobro y anulación, con quién y cuándo. */
  movements(saleId: string): Observable<SaleMovement[]> {
    // Mismo motivo que en `list()`: el fallo tiene que viajar por el stream.
    return defer(() => this.api().sales.listMovements(saleId));
  }

  /**
   * Venta local con esa llave de cobro (SPEC 66), o `null`. La pantalla de venta
   * la usa al restaurar un borrador: si ya existe, ese ticket ya se cobró.
   * Un fallo del IPC se toma como "no existe": el borrador se restaura como antes.
   */
  async findByIdempotencyKey(idempotencyKey: string): Promise<Sale | null> {
    try {
      return (await window.electronAPI?.sales.getByIdempotencyKey?.(idempotencyKey)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Descarta una venta que nunca llegó al servidor (SPEC 62). Es lógico: la caja
   * guarda quién, cuándo y por qué, y lo asienta en `SyncLog`. La SQLite rechaza
   * la venta que ya está allá (`remoteId`) o que ya salió hacia allá
   * (`pushAttempts`): el error llega con el texto para el cajero.
   *
   * Después, **best-effort**, deja rastro en el servidor como venta no conciliada
   * con motivo `descartada: <razón>`: el admin ve que hubo un cobro que esta
   * caja retiró. Sin red o con error, el rastro local basta.
   */
  async discardSale(localId: string, reason: string): Promise<void> {
    const motivo = normalizeVoidReason(reason);
    if (!motivo) {
      throw new Error(`Escribe el motivo del descarte (mínimo ${VOID_REASON_MIN_LENGTH} caracteres).`);
    }
    const api = this.api();
    const discarded = await api.sales.discard(localId, {
      discardedBy: this.auth.user()?.uid ?? '',
      reason: motivo,
    });
    this.refreshPending();
    if (!discarded) {
      return;
    }
    try {
      const draft = await api.sales.prepareUnreconciled(localId);
      if (draft) {
        await firstValueFrom(this.postUnreconciled$(draft, `descartada: ${motivo}`, draft.payload));
      }
    } catch {
      // Best-effort: el descarte ya quedó en la caja y en su bitácora.
    }
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
  /**
   * Disparar y olvidar. El empuje en vuelo leyó la cola **una sola vez** al
   * arrancar, así que lo capturado o reintentado después no entra en esa pasada:
   * si ya hay uno corriendo se encola **a lo más una** pasada de seguimiento
   * (varias peticiones seguidas se funden en ella). Un empuje **esperado**
   * (`flushQueueAsync`) siempre se encola.
   */
  flushQueue(): void {
    if (!this.cola) {
      void this.flushQueueAsync();
      return;
    }
    if (this.seguimientoPendiente) {
      return;
    }
    this.seguimientoPendiente = true;
    void this.enFila(() => {
      // Se libera al arrancar: desde aquí la pasada ya lee la cola completa.
      this.seguimientoPendiente = false;
      return lastValueFrom(this.flush$().pipe(defaultIfEmpty(null))).then(() => undefined);
    });
  }

  private seguimientoPendiente = false;

  /**
   * Igual que `flushQueue()`, pero esperable. El sincronizador la necesita para
   * subir las ventas **antes** de cerrar el turno: si el cierre gana la carrera,
   * el backend rechaza la venta con "el turno de caja ya está cerrado".
   */
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
flushQueueAsync(): Promise<void> {
    return this.enFila(() => lastValueFrom(this.flush$().pipe(defaultIfEmpty(null))).then(() => undefined));
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

  private flush$(): Observable<unknown> {
    this.flushing = true;
    this.deferredInFlush = false;
    // `contarIntentos`: este es el push real. Las lecturas de la UI
    // (`refreshPending`, el conteo del shell) NO deben gastar el cupo.
    return from(
      this.api().sales.getPendingPush({ ...pushOwnerFilter(this.auth), contarIntentos: true }),
    )
      .pipe(
        // Un fallo del propio IPC (p. ej. SQLite bloqueada) no debe tumbar la
        // suscripción sin dejar rastro: se degrada a "nada pendiente" en este
        // intento y se reintenta en el siguiente sync.
        catchError(() => of([] as never[])),
        switchMap((cola) => {
          // Con `contarIntentos` estas no vienen, pero se filtra igual: una venta
          // sin `payload` no se puede enviar, y mandarla sería un 400 que la
          // condenaría por algo que se resuelve solo en el sync siguiente.
          const pending = cola.filter((venta) => venta.payload);
          if (!pending.length) {
            return of(null);
          }
          // En trozos y **en serie**: el backend rechaza el arreglo entero si pasa
          // de 50 (`bulkCreateSalesSchema`, SPEC 48), así que un fin de semana sin
          // red con 210 ventas en cola devolvía 400 y las condenaba todas — y
          // reintentar volvía a mandar las mismas 210. En serie, además, el orden
          // de folios sigue el de cobro.
          //
          // Si el servidor difirió ventas de un trozo (`DEFERRED`, SPEC 48), los
          // trozos siguientes no salen en esta pasada: van detrás de las
          // diferidas, y mandarlos ahora desordenaría los folios. Sin cargar
          // intento: el siguiente envío los toma en orden.
          const trozos = chunk(pending, BULK_MAX_ITEMS);
          return from(trozos).pipe(
            concatMap((trozo) => (this.deferredInFlush ? of(null) : this.pushBatch$(trozo))),
            defaultIfEmpty(null),
            last(null, null),
          );
        }),
        /**
         * Las anulaciones van **dentro** de la cadena, no en un `tap`.
         *
         * Disparadas y olvidadas, corrían por fuera del orden del sincronizador
         * y podían adelantarlas el cierre del turno. Las dos formas de anulación
         * mueren si el cierre gana:
         *
         * - la venta anulada que nunca llegó al servidor se crea con `POST
         *   /sales`, que rechaza con "el turno de caja ya está cerrado": ni el
         *   asiento ni su reversa entran al libro de control;
         * - la anulación remota pendiente rechaza con "solo un administrador
         *   puede anularla" (un turno cerrado tiene su arqueo firmado), y el
         *   servidor conserva como **activa** una venta que la caja anuló.
         */
        concatMap((resultado) =>
          concat(this.pushVoidedSales$(), this.reconcileRemoteVoids$()).pipe(
            defaultIfEmpty(null),
            last(null, null),
            map(() => resultado),
          ),
        ),
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
   * quedarse muerta en la caja. Si el motivo no se arregla reintentando
   * (inventario remoto), se registra en `unreconciledSales`: el movimiento y el
   * importe quedan en el servidor, el inventario no se descuadra, y alguien
   * concilia a mano.
   *
   * Desde SPEC 49 decide el **código** del servidor (`core/sync/sync-error-codes.ts`):
   * un rechazo `retryable` se queda pendiente sin `pushError`, solo
   * `PRODUCT_NOT_FOUND` va a conciliación (SPEC 52: faltante, inactivo y turno
   * cerrado ya llegan como venta aceptada con marca) y lo demás se bloquea
   * visible. Solo sin código (backend viejo) se clasifica por el texto, como antes.
   */
  private handleRejected(item: PendingSale, failure: SyncFailure): Observable<unknown> {
    const action = syncActionFor(failure) ?? legacySaleRejectionAction(failure.message);
    if (action === 'retry') {
      // Transitorio (contención, lote diferido, error interno): sigue en cola.
      return of(undefined);
    }
    const pushError = withSyncCode(failure.message, failure);
    if (action !== 'reconcile') {
      return from(this.api().sales.markPushFailed(item.id, pushError));
    }

    return this.postUnreconciled$(item, failure.message)
      .pipe(
        // Registrada aparte: sale de la cola para que el badge no mienta, pero
        // el historial la sigue mostrando con su motivo.
        switchMap(() => from(this.api().sales.markUnreconciled(item.id, failure.message))),
        // Si ni eso se pudo, se marca como bloqueada y el cajero la ve.
        catchError(() => from(this.api().sales.markPushFailed(item.id, pushError))),
      );
  }

  /**
   * `POST /sales/unreconciled`. Compartido por el rechazo automático y por
   * "Mandar a conciliación" del panel de rechazados (`sendToUnreconciled`).
   */
  private postUnreconciled$(
    item: { id: string; folio: string; total: number; createdAt: Date | string; cashSessionId: string | null },
    reason: string,
    payload: unknown = (item as { payload?: unknown }).payload,
  ): Observable<unknown> {
    // `deviceId` (SPEC 53): el servidor arma el id del registro como
    // `<deviceId>:<localId>`, así dos cajas con el mismo id local no se pisan.
    // Sin él (fuera de Electron, o si falla) el servidor usa al cajero.
    return from(this.deviceId()).pipe(
      switchMap((deviceId) =>
        this.http.post<unknown>(`${this.apiUrl}/sales/unreconciled`, {
          localId: item.id,
          localFolio: item.folio,
          reason,
          total: item.total,
          occurredAt: new Date(item.createdAt).toISOString(),
          ...(item.cashSessionId ? { cashSessionId: item.cashSessionId } : {}),
          ...(deviceId ? { deviceId } : {}),
          payload,
        }),
      ),
    );
  }

  /**
   * Id del equipo: el mismo `id` de `get-device-info` que viaja en el
   * diagnóstico remoto (hostname + MAC). Se pide una vez; un fallo no se queda
   * en caché, el siguiente envío lo vuelve a intentar.
   */
  private deviceId(): Promise<string | null> {
    if (!this.deviceIdRequest) {
      const request = (async () => {
        try {
          const info = (await window.electronAPI?.getDeviceInfo?.()) as
            | { id?: unknown }
            | null
            | undefined;
          return typeof info?.id === 'string' && info.id.trim() ? info.id : null;
        } catch {
          return null;
        }
      })();
      this.deviceIdRequest = request;
      void request.then((id) => {
        if (!id && this.deviceIdRequest === request) {
          this.deviceIdRequest = null;
        }
      });
    }
    return this.deviceIdRequest;
  }

  /**
   * Manda a conciliación una venta que **no puede** subir por la vía normal: su
   * turno nunca existió en el servidor (el alta se rechazó de forma permanente)
   * y la venta no saldría jamás de la caja. El dinero ya se cobró; así al menos
   * queda registrado en `unreconciledSales` para que el admin lo concilie.
   *
   * El payload viaja **sin** el id local del turno (`prepareUnreconciled`): el
   * servidor no lo conoce. Lanza si la venta no existe o si el servidor la
   * rechaza; en ese caso la venta se queda como estaba.
   */
  async sendToUnreconciled(localId: string, reason: string): Promise<void> {
    const draft = await this.api().sales.prepareUnreconciled(localId);
    if (!draft) {
      throw new Error('La venta ya no existe en esta caja.');
    }
    // Un comando remoto puede repetirse si se perdió su resultado: no se manda
    // dos veces lo que ya quedó registrado.
    if (draft.unreconciledAt) {
      return;
    }
    await firstValueFrom(this.postUnreconciled$(draft, reason, draft.payload));
    await this.api().sales.markUnreconciled(localId, reason);
    this.refreshPending();
  }

  /**
   * Sube un trozo de la cola. Si el servidor lo rechaza en bloque con un 4xx,
   * **parte el trozo en dos y reintenta cada mitad** hasta aislar la venta
   * culpable.
   *
   * `POST /sales/bulk` valida el arreglo completo antes de procesar nada
   * (`bulkCreateSalesSchema` con `ZodValidationPipe`), así que una sola venta mal
   * formada —un `prescription` de una versión anterior del POS, un descuento con
   * tres decimales— tumbaba el lote entero y arrastraba a las 40 ventas buenas
   * que iban con ella. Bisecando, la culpable queda marcada sola y el resto sube.
   */
  private pushBatch$(pending: PendingSale[]): Observable<unknown> {
    if (!pending.length) {
      return of(null);
    }
    return this.http
      .post<unknown>(`${this.apiUrl}/sales/bulk`, { items: pending.map((item) => item.payload) })
      .pipe(
        switchMap((response) => {
          const results = unwrapEntity<BulkSaleResult[]>(response);
          const marks = pending.map((item, index) => {
            const result = results[index];
            if (!result) {
              return of(undefined);
            }
            if (result.ok) {
              // Aceptada, con o sin marcas de revisión (SPEC 52): está registrada.
              // Las marcas se guardan para que el historial las muestre.
              const review = syncReviewOf(result.sale);
              return from(
                review
                  ? this.api().sales.markSynced(item.id, result.sale.id, result.sale.folio, review)
                  : this.api().sales.markSynced(item.id, result.sale.id, result.sale.folio),
              );
            }
            if (result.code === 'DEFERRED') {
              // Pendiente sin contar intento ni bloquear (SPEC 48).
              this.deferredTotal += 1;
              this.deferredInFlush = true;
              return of(undefined);
            }
            return this.handleRejected(item, syncFailureFromResult(result));
          });
          return forkJoin(marks).pipe(defaultIfEmpty([] as unknown[]));
        }),
        catchError((error: unknown) => {
          // Rechazo transitorio de la petición entera (SPEC 49): ni se marca ni
          // se biseca, el lote completo vuelve a salir en el próximo envío.
          if (syncActionFor(syncFailureFromError(error)) === 'retry') {
            return of(null);
          }
          if (!this.isBulkRejection(error) || pending.length === 1) {
            // Una sola venta (o un fallo de red/5xx): el marcado de siempre.
            return this.markBulkHttpFailure(pending, error);
          }
          const mitad = Math.ceil(pending.length / 2);
          return concat(
            this.pushBatch$(pending.slice(0, mitad)),
            this.pushBatch$(pending.slice(mitad)),
          ).pipe(defaultIfEmpty(null), last(null, null));
        }),
      );
  }

  /**
   * El servidor rechazó **el contenido** del lote: reintentar el mismo cuerpo no
   * lo va a arreglar. Solo cuentan los 4xx que hablan del payload (validación,
   * conflicto, tamaño). Un 403/404/405 es del despliegue o del permiso —un
   * deploy a medias, un rol cambiado un rato—, no de una venta: marcarlas como
   * rechazadas sacaba de la cola ventas ya cobradas hasta intervención manual.
   */
  private isBulkRejection(error: unknown): boolean {
    const status = getApiErrorStatus(error);
    return status !== null && BULK_REJECTION_STATUSES.has(status);
  }

  /**
   * Fallo HTTP del lote entero (antes se tragaba y las ventas quedaban
   * `pendingPush` sin `pushError`: el aviso hablaba de "sin red" con red).
   * Un 4xx estable se marca rechazado para que el cajero lo vea; 5xx/red se
   * dejan en cola para el próximo ciclo.
   */
  private markBulkHttpFailure(pending: PendingSale[], error: unknown): Observable<null> {
    if (!this.isBulkRejection(error) || pending.length === 0) {
      return of(null);
    }
    const failure = syncFailureFromError(error);
    const message = withSyncCode(failure.message, failure);
    return forkJoin(
      pending.map((item) => from(this.api().sales.markPushFailed(item.id, message))),
    ).pipe(
      catchError(() => of(null)),
      map(() => null),
    );
  }

  /**
   * Ventas anuladas que **nunca** llegaron al servidor: se crean y se anulan
   * allá, en dos pasos. Sin esto el backend no se entera de que esa venta
   * ocurrió, y el libro de control se queda sin el asiento ni su reversa.
   */
  private pushVoidedSales$(): Observable<unknown> {
    const api = window.electronAPI;
    if (!api) {
      return of(null);
    }
    // `contarIntentos`: este es el envío real (SPEC 62: ya no se puede descartar).
    return from(api.sales.getPendingVoided({ ...pushOwnerFilter(this.auth), contarIntentos: true }))
      .pipe(
        catchError(() => of([])),
        switchMap((pending) => {
          if (!pending.length) {
            return of(null);
          }
          // Por `/sales/bulk` y no `POST /sales`: la venta se cobró sin red, y
          // la ruta en línea rechaza una promoción que cerró entre el cobro y el
          // sync. Así la venta quedaba en error para siempre y el backend nunca
          // se enteraba ni de ella ni de su anulación (libro de control incluido).
          const pushes = pending.map((item) =>
            this.http
              .post<unknown>(`${this.apiUrl}/sales/bulk`, { items: [item.payload] })
              .pipe(
                map((response) => {
                  const [result] = unwrapEntity<BulkSaleResult[]>(response) ?? [];
                  if (!result) {
                    throw new Error('El servidor no devolvió resultado para la venta');
                  }
                  if (!result.ok) {
                    throw new SyncRejectionError(syncFailureFromResult(result));
                  }
                  return result;
                }),
                // El alta funcionó: la venta **ya existe** allá. Se marca subida en
                // el acto (SPEC 62): `markSynced` sobre una venta anulada guarda el
                // `remoteId` y la deja `needsRemoteVoid`. Antes, si el `void` fallaba
                // por red, se marcaba `pushError` sin `remoteId` y la venta quedaba
                // bloqueada —y descartable— mientras el servidor la tenía activa.
                switchMap((result) => {
                  const created = result.sale;
                  const review = syncReviewOf(created);
                  return from(
                    review
                      ? api.sales.markSynced(item.id, created.id, created.folio, review)
                      : api.sales.markSynced(item.id, created.id, created.folio),
                  ).pipe(map(() => created));
                }),
                switchMap((created) =>
                  this.http
                    .post<unknown>(`${this.apiUrl}/sales/${created.id}/void`, this.voidBody(item))
                    .pipe(
                      switchMap(() => from(api.sales.markRemoteVoided(item.id))),
                      // Red/5xx: sigue `needsRemoteVoid`, sin `pushError`; 4xx:
                      // además `voidError` visible. `ALREADY_VOIDED` la cierra.
                      catchError((error: unknown) => this.handleRemoteVoidFailure$(item.id, error)),
                    ),
                ),
                // Solo fallos del **alta**: la venta sigue como estaba y se
                // reintenta en el próximo sync.
                catchError((error: unknown) => {
                  const failure = syncFailureFromError(error);
                  // Transitorio con código (SPEC 49): se queda como estaba, sin
                  // `pushError`, y se reintenta en el próximo sync.
                  if (syncActionFor(failure) === 'retry') {
                    return of(undefined);
                  }
                  return from(
                    this.api().sales.markPushFailed(item.id, withSyncCode(failure.message, failure)),
                  );
                }),
              ),
          );
          return forkJoin(pushes);
        }),
        catchError(() => of(null)),
        tap(() => this.refreshPending()),
      );
  }

  /**
   * Ventas que se anularon en local justo mientras su push seguía en vuelo
   * (`markSynced` detectó la carrera y las marcó `needsRemoteVoid` en vez de
   * darlas por sincronizadas sin más): el servidor las tiene activas, hace
   * falta el `POST /sales/:id/void` remoto explícito para cerrarlas.
   */
  private reconcileRemoteVoids$(): Observable<unknown> {
    const api = window.electronAPI;
    if (!api) {
      return of(null);
    }
    return from(api.sales.getNeedingRemoteVoid(pushOwnerFilter(this.auth)))
      .pipe(
        switchMap((pending) => {
          if (!pending.length) {
            return of(null);
          }
          const voids = pending.map((item) =>
            this.http
              // Sin `voidedAt`/`voidedBy` el backend sellaría la anulación con la
              // hora del sync y a nombre de quien sincronizó (otro turno, quizá).
              .post<unknown>(`${this.apiUrl}/sales/${item.remoteId}/void`, this.voidBody(item))
              .pipe(
                switchMap(() => from(api.sales.markRemoteVoided(item.id))),
                catchError((error: unknown) => this.handleRemoteVoidFailure$(item.id, error)),
              ),
          );
          return forkJoin(voids);
        }),
        catchError(() => of(null)),
      );
  }

  /**
   * Cuerpo del `POST /sales/:id/void` diferido: el motivo, el instante y el autor
   * de **entonces**. Una anulación local anterior al motivo obligatorio viaja con
   * el texto que el backend usa para un POS viejo (`LEGACY_VOID_REASON`).
   */
  private voidBody(item: {
    voidedAt: string | null;
    voidedBy: string | null;
    voidReason?: string | null;
  }): { reason: string; voidedAt?: string; voidedBy?: string } {
    return {
      reason: normalizeVoidReason(item.voidReason) ?? LEGACY_VOID_REASON,
      ...(item.voidedAt ? { voidedAt: item.voidedAt } : {}),
      ...(item.voidedBy ? { voidedBy: item.voidedBy } : {}),
    };
  }

  /**
   * Fallo de una anulación remota (SPEC 62), por código y no por texto:
   * `ALREADY_VOIDED` cierra el pendiente; cualquier otro 4xx deja `voidError`
   * visible en "Rechazados" (ya no se reintenta en silencio); red/5xx sigue en
   * cola tal cual.
   */
  private handleRemoteVoidFailure$(localId: string, error: unknown): Observable<unknown> {
    const api = this.api();
    const failure = syncFailureFromError(error);
    const outcome = remoteVoidOutcome(failure);
    if (outcome === 'done') {
      return from(api.sales.markRemoteVoided(localId));
    }
    if (outcome === 'rejected') {
      return from(api.sales.markVoidFailed(localId, withSyncCode(failure.message, failure)));
    }
    return of(undefined);
  }

  private refreshPending(): void {
    const api = window.electronAPI;
    if (!api) {
      // Fuera de Electron (`ng serve` en navegador): no hay nada que leer. Se
      // resuelve en silencio para no tumbar el constructor del servicio, que se
      // instancia igual con solo abrir el shell aunque el cajero nunca cobre.
      return;
    }
    // Las rechazadas no llegan por aquí: `getPendingPush` filtra `pushError:
    // null`. Las lleva `BlockedSyncService` (insignia "Rechazados N" del shell),
    // que además abarca gastos y catálogo. Este servicio partía la lista en
    // "bloqueadas" y "no bloqueadas" y publicaba una señal que siempre estaba
    // vacía, con su propio aviso y diálogo inalcanzables.
    from(api.sales.getPendingPush(pushOwnerFilter(this.auth))).subscribe((pending) => {
      const hint = (sale: { items: unknown[]; total: number }) =>
        `${sale.items.length} art. · $${sale.total.toFixed(2)}`;
      this.pendingSales.set(
        pending.map((sale) => ({
          queueId: sale.id,
          folioHint: hint(sale),
          total: sale.total,
          waitingFor: motivoDeEspera(sale.esperandoPor),
        })),
      );
      this.pendingCount.set(pending.length);
    });
  }

  private api() {
    const api = window.electronAPI;
    if (!api) {
      // Redactado para el cajero, no para el desarrollador: este texto llega a
      // la pantalla (el historial lo muestra vía `getApiErrorMessage`), y
      // "electronAPI no disponible" no le dice nada a quien está en la caja.
      throw new Error(
        'La caja local no está disponible: esta pantalla necesita la app de escritorio ' +
          'FarmaJyV Venta (electronAPI ausente).',
      );
    }
    return api;
  }
}
