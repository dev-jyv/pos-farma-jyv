import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EMPTY, Observable, catchError, concatMap, defaultIfEmpty, finalize, lastValueFrom, from, map } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { getApiErrorMessage, toDate, unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { Product, ProductFieldsPayload, PurchaseInvoice } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

export type { ProductFieldsPayload };

export interface CreateStockEntryPayload {
  invoiceId: string;
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

  private flushing = false;

  /** Últimas facturas registradas, de la más reciente a la más vieja. */
  listRecentInvoices(limit = 10): Observable<PurchaseInvoice[]> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http
      .get<unknown>(`${this.apiUrl}/stock-entries/invoices`, { params })
      .pipe(map((response) => unwrapList<InvoiceDto>(response).map(mapInvoice)));
  }

  create(payload: CreateStockEntryPayload): Observable<StockEntryResult> {
    return from(this.api().recordStockEntry(payload));
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

  private flush$(): Observable<unknown> {
    this.flushing = true;
    return from(this.api().getPendingStockEntries())
      .pipe(
        concatMap((pending) => from(pending)),
        concatMap((item) =>
          this.http
            .post<unknown>(`${this.apiUrl}/stock-entries`, {
              ...(item.payload as Record<string, unknown>),
              /**
               * Llave estable por entrada: el id local, que no cambia entre
               * reintentos. Sin ella, un alta que sí se aplicó pero cuya
               * respuesta se perdió volvía a mandarse en el flush siguiente y
               * creaba un segundo lote con el mismo número y la misma factura
               * —existencias que no existen—. El backend la usa igual que en las
               * ventas y en el reintento devuelve la entrada ya registrada.
               */
              idempotencyKey: item.id,
            })
            .pipe(
            concatMap((response) => {
              const result = unwrapEntity<StockEntryResult>(response);
              return from(this.api().markStockEntrySynced(item.id, result.product?.id ?? null));
            }),
            catchError((error: unknown) => {
              if (this.isPermanentFailure(error)) {
                return from(this.api().markStockEntryPushFailed(item.id, getApiErrorMessage(error)));
              }
              return EMPTY;
            }),
          ),
        ),
        finalize(() => {
          this.flushing = false;
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

  private api() {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI no disponible: el alta de stock requiere correr dentro de Electron.');
    }
    return api.catalog;
  }
}
