import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EMPTY, Observable, catchError, concatMap, defaultIfEmpty, finalize, firstValueFrom, from, map } from 'rxjs';
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
  flushQueue(): void {
    this.flush$().subscribe();
  }

  /**
   * Igual que `flushQueue()`, pero esperable: `SyncScheduler` encadena catálogo
   * → entradas → ventas, porque una venta que consumió mercancía recién
   * recibida necesita que su entrada haya subido antes.
   */
  flushQueueAsync(): Promise<void> {
    return firstValueFrom(this.flush$().pipe(defaultIfEmpty(null))).then(() => undefined);
  }

  private flush$(): Observable<unknown> {
    if (this.flushing) {
      return EMPTY;
    }
    this.flushing = true;
    return from(this.api().getPendingStockEntries())
      .pipe(
        concatMap((pending) => from(pending)),
        concatMap((item) =>
          this.http.post<unknown>(`${this.apiUrl}/stock-entries`, item.payload).pipe(
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
