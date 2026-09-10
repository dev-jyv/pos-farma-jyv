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
        /** Precio cobrado por unidad; el backend no debe retarifar al sincronizar. */
        unitPrice: number;
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
/**
 * Tope de ventas por petición. El backend rechaza el arreglo completo si pasa de
 * 200 (`bulkCreateSalesSchema`), así que se manda con margen: un lote de 100
 * también acota lo que hay que bisecar cuando una venta viene mal formada.
 */
const BULK_MAX_ITEMS = 100;

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

@Injectable({ providedIn: 'root' })
export class SaleService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly apiUrl = environment.apiUrl;

  private flushing = false;

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
              // Igual que la mercancía: el precio **cobrado**. Una consulta de
              // las 11:00 no puede retarifarse porque el admin subió el precio a
              // la 13:00 — se rechazaba con "el monto recibido es menor al
              // total" y quedaba bloqueada con el dinero ya en el cajón.
              unitPrice: lineUnitPrice(line),
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

    // `defer` por lo mismo que `list()`: si no hay `electronAPI`, el cobro debe
    // fallar por el canal de error del observable y no como excepción suelta.
    return defer(() => this.api().sales.createLocal(input)).pipe(
      tap(() => this.refreshPending()),
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
  void(sale: Sale): Observable<Sale> {
    const voidedBy = this.auth.user()?.uid ?? '';
    const voidedByLabel = this.auth.user()?.email ?? undefined;
    if (!sale.remoteId) {
      return defer(() => this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel)).pipe(
        switchMap((voided) =>
          voided ? of(voided) : throwError(() => new Error('Venta no encontrada.')),
        ),
        tap(() => this.refreshPending()),
      );
    }
    const remoteId = sale.remoteId;
    return this.http.post<unknown>(`${this.apiUrl}/sales/${remoteId}/void`, {}).pipe(
      switchMap(() =>
        from(this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel)).pipe(
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
        return from(this.api().sales.voidLocal(sale.id, voidedBy, voidedByLabel)).pipe(
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
  /**
   * Disparar y olvidar. Si ya hay un empuje en vuelo **no** encola otro: se
   * apoya en el que corre, que va a leer la cola igual. Encolar aquí duplicaba
   * la pasada sin ganar nada. Un empuje **esperado** (`flushQueueAsync`) sí se
   * encola siempre: quien lo espera necesita que de verdad ocurra.
   */
  flushQueue(): void {
    if (this.cola) {
      return;
    }
    void this.flushQueueAsync();
  }

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
          // de 200 (`bulkCreateSalesSchema`), así que un fin de semana sin red con
          // 210 ventas en cola devolvía 400 y las condenaba todas — y reintentar
          // volvía a mandar las mismas 210. En serie, además, el orden de folios
          // sigue el de cobro.
          const trozos = chunk(pending, BULK_MAX_ITEMS);
          return from(trozos).pipe(
            concatMap((trozo) => this.pushBatch$(trozo)),
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
   * (inventario remoto, turno ya cerrado allá), se registra en
   * `unreconciledSales`: el movimiento y el importe quedan en el servidor, el
   * inventario no se descuadra, y alguien concilia a mano.
   *
   * El resto de rechazos (llave reciclada, etc.) sí se marcan como bloqueados:
   * el cajero puede corregir y reintentar.
   */
  private handleRejected(item: PendingSale, error: string): Observable<unknown> {
    if (!this.isUnreconcileableRejection(error)) {
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

  /** Rechazos que no se arreglan reintentando el mismo push → unreconciled. */
  private isUnreconcileableRejection(error: string): boolean {
    return this.isInventoryRejection(error) || this.isClosedShiftRejection(error);
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

  /** El turno remoto ya cerró: reintentar el POST /sales no la va a registrar. */
  private isClosedShiftRejection(error: string): boolean {
    const normalized = error.toLowerCase();
    return normalized.includes('turno') && normalized.includes('cerrado');
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
            return result.ok
              ? from(this.api().sales.markSynced(item.id, result.sale.id, result.sale.folio))
              : this.handleRejected(item, result.error);
          });
          return forkJoin(marks).pipe(defaultIfEmpty([] as unknown[]));
        }),
        catchError((error: unknown) => {
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

  /** 4xx estable: reintentar el mismo cuerpo no lo va a arreglar. */
  private isBulkRejection(error: unknown): boolean {
    const status = getApiErrorStatus(error);
    return (
      status !== null &&
      status >= 400 &&
      status < 500 &&
      status !== 401 &&
      status !== 408 &&
      status !== 429
    );
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
    const message = getApiErrorMessage(error);
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
    return from(api.sales.getPendingVoided())
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
    return from(api.sales.getNeedingRemoteVoid())
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
                catchError((error: unknown) => {
                  const message = getApiErrorMessage(error).toLowerCase();
                  // Ya estaba anulada allá: el objetivo se cumplió.
                  if (message.includes('anulad') || message.includes('already void')) {
                    return from(api.sales.markRemoteVoided(item.id));
                  }
                  // Red / 5xx: se reintenta en el próximo sync.
                  return of(undefined);
                }),
              ),
          );
          return forkJoin(voids);
        }),
        catchError(() => of(null)),
      );
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
