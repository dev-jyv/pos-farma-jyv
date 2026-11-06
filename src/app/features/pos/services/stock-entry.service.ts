import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, Injector, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  defer,
  finalize,
  lastValueFrom,
  from,
  map,
  tap,
} from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { getApiErrorMessage, toDate, unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { NotificationService } from '../../../core/notifications/notification.service';
import { AutoPushService } from '../../../core/sync/auto-push.service';
import {
  syncActionFor,
  syncFailureFromError,
  withSyncCode,
} from '../../../core/sync/sync-error-codes';
import { Product, ProductFieldsPayload, PurchaseInvoice } from '../../../shared/models';
import { duplicateConflictReason, productDuplicateOf } from './product-catalog.service';
import { environment } from '../../../../environments/environment';

export type { ProductFieldsPayload };

/**
 * Espera antes de reenviar una entrada que el servidor todavía está registrando
 * (`ENTRY_IN_PROGRESS`, SPEC 55): 30 s, 1, 2, 5 y 10 min. Reenviarla en cada
 * empuje no la apura —el intento anterior tiene la reserva— y solo gasta
 * peticiones. Un `Retry-After` del servidor manda sobre la tabla.
 */
export const ENTRY_IN_PROGRESS_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

export interface CreateStockEntryPayload {
  invoiceId: string;
  /**
   * Momento de la captura en la caja (ISO), SPEC 59: el servidor valida la
   * caducidad contra ese día y no contra el del sync. Lo estampa
   * `recordStockEntry` al guardar en SQLite si no viene.
   */
  capturedAt?: string;
  /**
   * "Sí, es otra partida" (SPEC 58): el cajero confirmó que la partida no es la
   * misma que ya tiene la factura. Lo pone `confirmDuplicateStockEntry`.
   */
  confirmDuplicate?: boolean;
  lotNumber: string;
  /** `YYYY-MM-DD`; el backend rechaza fechas pasadas. */
  expiryDate: string;
  quantity: number;
  costPrice?: number;
  /** Producto existente al que se le suma el stock. */
  productId?: string;
  /** Correcciones al producto existente; solo los campos que el cajero tocó. */
  productUpdate?: Partial<ProductFieldsPayload>;
  /** Alta de un producto que no está en el catálogo. */
  product?: ProductFieldsPayload;
}

export interface StockEntryResult {
  product: Product;
  /** Existencias del producto **después** de la entrada. */
  stock: number;
  /** Advertencias que no rechazan la entrada (SPEC 59), p. ej. `LOT_EXPIRY_MISMATCH`. */
  warnings?: string[];
}

/** Advertencia del servidor: el mismo lote ya existe con otra caducidad (SPEC 59). */
export const LOT_EXPIRY_MISMATCH = 'LOT_EXPIRY_MISMATCH';

/**
 * Advertencias de una respuesta de `POST /stock-entries`. El contrato las pone
 * en `warnings` y la regla funcional en `details.warnings`: se aceptan las dos,
 * dentro o fuera de `data`.
 */
export function stockEntryWarnings(response: unknown): string[] {
  const found = new Set<string>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.filter((item): item is string => typeof item === 'string').forEach((item) => found.add(item));
    }
  };
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    const record = node as { warnings?: unknown; details?: { warnings?: unknown } };
    collect(record.warnings);
    collect(record.details?.warnings);
  };
  visit(response);
  visit((response as { data?: unknown } | null)?.data);
  return [...found];
}

/** Texto para el cajero de una advertencia de entrada. */
function warningMessage(code: string, lotNumber: string, productName: string): string {
  if (code === LOT_EXPIRY_MISMATCH) {
    return `El lote ${lotNumber} de ${productName} ya existía con otra caducidad. Revisa la factura.`;
  }
  return `Entrada de ${productName} (lote ${lotNumber}): ${code}.`;
}

/**
 * 409 del servidor (SPEC 58): la factura ya tiene una entrada con el mismo
 * producto, lote y cantidad, registrada con otra llave. Casi siempre es la misma
 * factura capturada dos veces (foto y PDF, otra caja, IA más captura manual).
 */
export const ENTRY_POSSIBLE_DUPLICATE = 'ENTRY_POSSIBLE_DUPLICATE';

/** Fecha corta de México (dd/mm/aaaa) para el aviso; `null` si no se puede leer. */
function shortDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const date = toDate(value);
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/**
 * Si el error es el 409 `ENTRY_POSSIBLE_DUPLICATE`, devuelve con qué se reconoce
 * la entrada que ya existe (folio o fecha, si el servidor los manda); si no,
 * `null`. Se aceptan en `details` o en `details.existing`, porque el contrato
 * solo fija "el folio o fecha de la existente".
 */
export function entryPossibleDuplicateOf(error: unknown): { reference: string | null } | null {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
    return null;
  }
  const details = (error.error as { error?: { details?: Record<string, unknown> } } | null)?.error
    ?.details;
  if (!details || details['code'] !== ENTRY_POSSIBLE_DUPLICATE) {
    return null;
  }
  const existing =
    details['existing'] && typeof details['existing'] === 'object'
      ? (details['existing'] as Record<string, unknown>)
      : {};
  const pick = (key: string): unknown => existing[key] ?? details[key];
  const folio = pick('folio');
  if (typeof folio === 'string' && folio.trim()) {
    return { reference: `folio ${folio.trim()}` };
  }
  const date = shortDate(pick('createdAt') ?? pick('date') ?? pick('capturedAt'));
  return { reference: date ? `del ${date}` : null };
}

/** Motivo que queda en el lote: visible en "Rechazados" con su código al final. */
export function possibleDuplicateReason(reference: string | null): string {
  return (
    'La factura ya tiene una entrada con el mismo producto, lote y cantidad' +
    `${reference ? ` (${reference})` : ''}. ¿Es otra partida? [${ENTRY_POSSIBLE_DUPLICATE}]`
  );
}

interface InvoiceDto {
  id: string;
  invoiceNumber: string;
  invoiceDate: unknown;
  supplierId: string;
  supplier?: { id?: string; name?: string };
  totalAmount: number;
  hasInvoice?: boolean;
}

function mapInvoice(dto: InvoiceDto): PurchaseInvoice {
  return {
    id: dto.id,
    invoiceNumber: dto.invoiceNumber,
    invoiceDate: toDate(dto.invoiceDate),
    supplierId: dto.supplierId ?? dto.supplier?.id ?? '',
    supplierName: dto.supplier?.name ?? '',
    totalAmount: dto.totalAmount,
    hasInvoice: dto.hasInvoice !== false,
  };
}

/**
 * Entrada de stock desde la caja: local-first. `create()` escribe producto y
 * lote en el SQLite de Electron de inmediato (`electron/db/products.js`,
 * `recordStockEntry`) y el resultado se ve al instante; el `POST
 * /stock-entries` real (con `invoiceId`, que sigue viniendo de
 * `listRecentInvoices` en línea) se manda en el próximo sync (`flushQueue`).
 */
@Injectable({ providedIn: 'root' })
export class StockEntryService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  private readonly autoPush = inject(AutoPushService);
  private readonly injector = inject(Injector);

  private flushing = false;

  /** Avisos del empuje en curso; se muestran juntos al terminar. */
  private pendingWarnings: string[] = [];

  /**
   * Entradas locales sin subir, contando las que esperan a su producto
   * (`includeWaiting`), para el aviso "N sin subir" de Productos y Entrada de
   * stock. Las rechazadas no cuentan: viven en "Rechazados".
   */
  readonly pendingCount = signal(0);

  constructor() {
    this.refreshPending();
  }

  /** Relee el conteo de la cola local. Barato (SQLite por IPC) y sin red. */
  refreshPending(): void {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    // `defer`: si la llamada revienta (o el preload es viejo y no la expone) el
    // error cae en `catchError` y no tumba al servicio.
    defer(() => api.catalog.getPendingStockEntries({ includeWaiting: true }))
      .pipe(catchError(() => EMPTY))
      .subscribe((pending) => this.pendingCount.set(pending.length));
  }

  /** Últimas facturas registradas, de la más reciente a la más vieja. */
  listRecentInvoices(limit = 10): Observable<PurchaseInvoice[]> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http
      .get<unknown>(`${this.apiUrl}/stock-entries/invoices`, { params })
      .pipe(map((response) => unwrapList<InvoiceDto>(response).map(mapInvoice)));
  }

  create(payload: CreateStockEntryPayload): Observable<StockEntryResult> {
    return from(this.api().recordStockEntry(payload)).pipe(
      tap(() => {
        this.refreshPending();
        this.autoPush.notifyChange();
      }),
    );
  }

  /**
   * Envía a `POST /stock-entries` los altas/lotes locales pendientes, en orden
   * de captura. Igual que `SaleService.flushQueue`: un 4xx se marca y deja de
   * reintentarse solo; lo demás (red) se reintenta en el próximo sync.
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
   * Igual que `flushQueue()`, pero esperable: `SyncScheduler` encadena catálogo
   * → entradas → ventas, porque una venta que consumió mercancía recién
   * recibida necesita que su entrada haya subido antes.
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

  /**
   * Id de este equipo (`get-device-info`, el mismo que usa el diagnóstico
   * remoto). Se manda en cada entrada (SPEC 54): el backend arma la llave de
   * idempotencia con él (`<deviceId>:<key>`) y no con quien sincroniza, así que
   * una entrada que un cajero empezó y otro reintenta no se aplica dos veces.
   * Se pide una vez; si falla (preload viejo) la entrada va sin él, como antes.
   */
  private deviceIdPromise: Promise<string | null> | null = null;

  private deviceId(): Promise<string | null> {
    if (!this.deviceIdPromise) {
      this.deviceIdPromise = Promise.resolve()
        .then(() => window.electronAPI?.getDeviceInfo?.())
        .then((info) => {
          const id = (info as { id?: unknown } | null | undefined)?.id;
          return typeof id === 'string' && id.trim() ? id.trim() : null;
        })
        .catch(() => null)
        .then((id) => {
          // Sin id no se guarda la respuesta: el siguiente envío lo vuelve a pedir.
          if (!id) {
            this.deviceIdPromise = null;
          }
          return id;
        });
    }
    return this.deviceIdPromise;
  }

  /**
   * Entradas en espera por `ENTRY_IN_PROGRESS`: id del lote → intentos y hasta
   * cuándo no se reenvía. En memoria a propósito: siguen pendientes (cuentan en
   * el aviso y en el auto-push) y un reinicio de la app solo adelanta un intento.
   */
  private readonly inProgressBackoff = new Map<string, { attempts: number; until: number }>();

  private enEspera(id: string): boolean {
    const espera = this.inProgressBackoff.get(id);
    return Boolean(espera) && espera!.until > Date.now();
  }

  private esperarReintento(id: string, error: unknown): void {
    const attempts = (this.inProgressBackoff.get(id)?.attempts ?? 0) + 1;
    const tabla = ENTRY_IN_PROGRESS_BACKOFF_MS[Math.min(attempts, ENTRY_IN_PROGRESS_BACKOFF_MS.length) - 1];
    const retryAfter =
      error instanceof HttpErrorResponse ? Number(error.headers?.get('Retry-After')) : Number.NaN;
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : tabla;
    this.inProgressBackoff.set(id, { attempts, until: Date.now() + delay });
  }

  private flush$(): Observable<unknown> {
    this.flushing = true;
    return from(Promise.all([this.api().getPendingStockEntries(), this.deviceId()]))
      .pipe(
        concatMap(([pending, deviceId]) =>
          from(pending.filter((item) => !this.enEspera(item.id)).map((item) => ({ item, deviceId }))),
        ),
        concatMap(({ item, deviceId }) =>
          this.http
            .post<unknown>(`${this.apiUrl}/stock-entries`, {
              ...(item.payload as Record<string, unknown>),
              ...(deviceId ? { deviceId } : {}),
              /**
               * Llave estable por entrada: el id local, que no cambia entre
               * reintentos. Sin ella, un alta que sí se aplicó pero cuya
               * respuesta se perdió volvía a mandarse en el flush siguiente y
               * creaba un segundo lote con el mismo número y la misma factura
               * —existencias que no existen—. El backend la usa igual que en las
               * ventas y en el reintento devuelve la entrada ya registrada.
               */
              idempotencyKey: (item.payload as { idempotencyKey?: string }).idempotencyKey ?? item.id,
            })
            .pipe(
            concatMap((response) => {
              this.inProgressBackoff.delete(item.id);
              const result = unwrapEntity<StockEntryResult>(response);
              const payload = item.payload as { lotNumber?: string; product?: { name?: string } };
              for (const code of stockEntryWarnings(response)) {
                this.pendingWarnings.push(
                  warningMessage(
                    code,
                    payload.lotNumber ?? '',
                    result.product?.name ?? payload.product?.name ?? 'producto',
                  ),
                );
              }
              return from(this.api().markStockEntrySynced(item.id, result.product?.id ?? null));
            }),
            catchError((error: unknown) => {
              // SPEC 58: posible factura recapturada. No se decide sola: queda
              // bloqueada visible hasta que alguien elija "Sí, es otra partida"
              // (reenvía con `confirmDuplicate`) o "Descartar".
              const possibleDuplicate = entryPossibleDuplicateOf(error);
              if (possibleDuplicate) {
                this.inProgressBackoff.delete(item.id);
                return from(
                  this.api().markStockEntryPushFailed(
                    item.id,
                    possibleDuplicateReason(possibleDuplicate.reference),
                  ),
                );
              }
              // SPEC 60: el alta embebida chocó con **otro** producto (el backend
              // ya adopta cuando es el mismo). Queda bloqueada visible con el
              // nombre del existente, para corregir SKU/nombre o avisar al admin.
              const duplicate = productDuplicateOf(error);
              if (duplicate) {
                this.inProgressBackoff.delete(item.id);
                const reason = duplicate.existing
                  ? duplicateConflictReason(duplicate.existing.name, duplicate.code)
                  : `${getApiErrorMessage(error)} [${duplicate.code}]`;
                return from(this.api().markStockEntryPushFailed(item.id, reason));
              }
              // SPEC 49: con código decide la tabla única. `ENTRY_IN_PROGRESS`
              // (reserva reciente de un intento que puede seguir en curso) y los
              // `retryable` se quedan pendientes, **sin** `pushError`: marcarlos
              // dejaba el stock solo en la caja y luego fallaban sus ventas.
              const failure = syncFailureFromError(error);
              const action = syncActionFor(failure);
              if (failure.code === 'ENTRY_IN_PROGRESS') {
                // SPEC 55: pendiente, sin `pushError`, y con espera creciente.
                this.esperarReintento(item.id, error);
                return EMPTY;
              }
              this.inProgressBackoff.delete(item.id);
              if (action !== null) {
                if (action === 'retry') {
                  return EMPTY;
                }
                // Una entrada no tiene conciliación: lo demás se bloquea visible.
                return from(
                  this.api().markStockEntryPushFailed(item.id, withSyncCode(failure.message, failure)),
                );
              }
              // Backend sin código: el criterio por status de siempre.
              if (this.isPermanentFailure(error)) {
                return from(this.api().markStockEntryPushFailed(item.id, getApiErrorMessage(error)));
              }
              return EMPTY;
            }),
          ),
        ),
        finalize(() => {
          this.flushing = false;
          this.refreshPending();
          this.showWarnings();
        }),
      );
  }

  /**
   * Las advertencias no rechazan la entrada (ya se aplicó): se avisan al terminar
   * el empuje. Sin `MessageService` (pruebas, arranque) no hay a quién avisar.
   */
  private showWarnings(): void {
    const messages = this.pendingWarnings;
    this.pendingWarnings = [];
    if (!messages.length) {
      return;
    }
    try {
      this.injector.get(NotificationService).warn(messages.join(' '), 'Revisa la entrada');
    } catch {
      // Sin notificaciones disponibles; la entrada ya quedó registrada.
    }
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

  private api() {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI no disponible: el alta de stock requiere correr dentro de Electron.');
    }
    return api.catalog;
  }
}
