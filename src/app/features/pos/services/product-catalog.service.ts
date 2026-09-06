import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { EMPTY, Observable, catchError, concatMap, defaultIfEmpty, finalize, lastValueFrom, from, map, of, switchMap, tap } from 'rxjs';

import { getApiErrorMessage, unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { PendingCatalogProduct } from '../../../core/electron/window.d';
import { Product, ProductFieldsPayload } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

interface ProductSummaryDto {
  id: string;
  sku: string;
}

/**
 * Edición de catálogo local-first (`/pos/productos`): buscar (`ProductService`,
 * ya local), dar de alta y editar producto escriben directo en SQLite vía IPC,
 * sin red en el instante de la acción — igual que ventas y entrada de stock.
 * El push real (`POST /products` / `PATCH /products/:id`) solo ocurre en
 * `flushQueue()`, llamada por `SyncScheduler` en los mismos 3 horarios fijos,
 * al login, o al pulsar "sincronizar ahora".
 *
 * Aparte de `Product.pendingPush` (reservado para el alta embebida de
 * `POST /stock-entries`): un producto dado de alta o editado aquí usa
 * `pendingCatalogPush`, para que ambas colas nunca compitan por el mismo
 * producto.
 */
@Injectable({ providedIn: 'root' })
export class ProductCatalogService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  private flushing = false;

  /** Altas/ediciones locales sin subir, para el indicador de pendientes del header. */
  readonly pendingCount = signal(0);

  constructor() {
    this.refreshPending();
  }

  getById(id: string): Observable<Product | null> {
    return from(this.api().getProductById(id));
  }

  create(fields: ProductFieldsPayload): Observable<Product> {
    return from(this.api().createCatalogProduct(fields)).pipe(tap(() => this.refreshPending()));
  }

  update(id: string, fields: Partial<ProductFieldsPayload>): Observable<Product> {
    return from(this.api().updateCatalogProduct(id, fields)).pipe(tap(() => this.refreshPending()));
  }

  /** Reintenta un producto que el servidor rechazó, tras corregir la causa. */
  retryBlocked(localId: string): void {
    from(this.api().clearCatalogPushError(localId)).subscribe(() => {
      this.refreshPending();
      this.flushQueue();
    });
  }

  /**
   * Sube en serie (`concatMap`, uno a la vez — el catálogo no tiene el volumen
   * de las ventas para justificar un endpoint bulk propio) cada alta/edición
   * pendiente. Las altas nuevas (`remoteId` null) primero comprueban por SKU si
   * el producto ya existe en el backend: `POST /products` no tiene llave de
   * idempotencia propia, así que un reintento tras una respuesta perdida por
   * red crearía un duplicado sin esta defensa. Las ediciones van directo a
   * `PATCH`, que ya es idempotente por sí solo.
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
   * → entradas → ventas, porque una venta de un producto recién dado de alta
   * necesita que ese producto ya exista en el servidor.
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
    return from(this.api().getPendingCatalogPush())
      .pipe(
        catchError(() => of([] as PendingCatalogProduct[])),
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

  private pushOne(item: PendingCatalogProduct): Observable<unknown> {
    if (item.remoteId) {
      return this.http.patch<unknown>(`${this.apiUrl}/products/${item.remoteId}`, item.fields).pipe(
        switchMap(() => from(this.api().markCatalogSynced(item.id, item.remoteId))),
        catchError((error: unknown) => this.handleFailure(item.id, error)),
      );
    }
    return this.findExistingBySku(item.fields.sku).pipe(
      switchMap((existingId) => {
        if (existingId) {
          return from(this.api().markCatalogSynced(item.id, existingId));
        }
        return this.http.post<unknown>(`${this.apiUrl}/products`, item.fields).pipe(
          switchMap((response) => {
            const created = unwrapEntity<ProductSummaryDto>(response);
            return from(this.api().markCatalogSynced(item.id, created.id));
          }),
        );
      }),
      catchError((error: unknown) => this.handleFailure(item.id, error)),
    );
  }

  /** Defensa contra duplicados: busca por SKU exacto antes de crear. */
  private findExistingBySku(sku: string): Observable<string | null> {
    const params = new HttpParams().set('search', sku).set('activeOnly', 'false').set('limit', '5');
    return this.http.get<unknown>(`${this.apiUrl}/products`, { params }).pipe(
      map((response) => {
        const items = unwrapList<ProductSummaryDto>(response);
        const normalized = sku.trim().toLowerCase();
        const match = items.find((product) => product.sku.trim().toLowerCase() === normalized);
        return match?.id ?? null;
      }),
      catchError(() => of(null)),
    );
  }

  private handleFailure(localId: string, error: unknown): Observable<never> {
    if (this.isPermanentFailure(error)) {
      return from(this.api().markCatalogPushFailed(localId, getApiErrorMessage(error))).pipe(
        switchMap(() => EMPTY),
      );
    }
    return EMPTY;
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
    from(api.catalog.getPendingCatalogPush()).subscribe((pending) => this.pendingCount.set(pending.length));
  }

  private api() {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI no disponible: el catálogo requiere correr dentro de Electron.');
    }
    return api.catalog;
  }
}
