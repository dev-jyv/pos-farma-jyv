import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { EMPTY, Observable, catchError, concatMap, defaultIfEmpty, finalize, lastValueFrom, from, map, of, switchMap, tap, throwError } from 'rxjs';

import { getApiErrorMessage, unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { AutoPushService } from '../../../core/sync/auto-push.service';
import {
  CatalogPushFields,
  CatalogConflictChoice,
  CatalogConflictCurrent,
  CatalogSyncedSnapshot,
  PendingCatalogProduct,
} from '../../../core/electron/window.d';
import { Product, ProductFieldsPayload } from '../../../shared/models';
import {
  PRODUCT_DUPLICATE,
  duplicateProductMessage,
  isSameProduct,
} from '../../../shared/utils/product-match';
import { environment } from '../../../../environments/environment';

interface ProductSummaryDto {
  id: string;
  sku: string;
  name?: string;
  concentration?: string | null;
  barcode?: string | null;
  updatedAt?: unknown;
}

/** Códigos de `details.code` con que el backend rechaza un alta duplicada (SPEC 60). */
export const PRODUCT_DUPLICATE_CODES = ['PRODUCT_DUPLICATE', 'PRODUCT_SKU_TAKEN', 'PRODUCT_NAME_TAKEN'] as const;
export type ProductDuplicateCode = (typeof PRODUCT_DUPLICATE_CODES)[number];

/** 409 de producto duplicado: código y datos del existente, si el backend los manda. */
export interface ProductDuplicateError {
  code: ProductDuplicateCode;
  existing: { id: string; name: string; sku: string; barcode: string | null } | null;
}

/**
 * 409 con `details.code` de duplicado (SPEC 60). `null` si es otro error o un
 * backend viejo que solo manda el texto.
 */
export function productDuplicateOf(error: unknown): ProductDuplicateError | null {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
    return null;
  }
  const body = error.error as {
    error?: { details?: { code?: unknown; existing?: Record<string, unknown> | null } };
  } | null;
  const details = body?.error?.details;
  const code = details?.code;
  if (typeof code !== 'string' || !(PRODUCT_DUPLICATE_CODES as readonly string[]).includes(code)) {
    return null;
  }
  const raw = details?.existing;
  const existing =
    raw && typeof raw['id'] === 'string'
      ? {
          id: raw['id'],
          name: typeof raw['name'] === 'string' ? raw['name'] : '',
          sku: typeof raw['sku'] === 'string' ? raw['sku'] : '',
          barcode: typeof raw['barcode'] === 'string' ? raw['barcode'] : null,
        }
      : null;
  return { code: code as ProductDuplicateCode, existing };
}

/** Motivo visible de un alta que choca con **otro** producto, con su código al final. */
export function duplicateConflictReason(existingName: string | null | undefined, code: string): string {
  const message = duplicateProductMessage(existingName, code === 'PRODUCT_NAME_TAKEN' ? 'name' : 'sku');
  return `${message} [${code}]`;
}

/**
 * 409 `CATALOG_CONFLICT` del `PATCH /products/:id` (SPEC 56): el precio o el
 * estado cambiaron en el panel después de la foto que mandó la caja. Devuelve el
 * valor actual del servidor (`details.current`), o `null` si es otro error.
 */
export function catalogConflictOf(error: unknown): CatalogConflictCurrent | null {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
    return null;
  }
  const body = error.error as {
    error?: { details?: { code?: unknown; current?: { salePrice?: unknown; isActive?: unknown } } };
  } | null;
  const details = body?.error?.details;
  if (!details || details.code !== 'CATALOG_CONFLICT') {
    return null;
  }
  const current = details.current ?? {};
  return {
    salePrice: typeof current.salePrice === 'number' ? current.salePrice : null,
    isActive: typeof current.isActive === 'boolean' ? current.isActive : null,
  };
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

  private readonly autoPush = inject(AutoPushService);

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
    return from(this.api().createCatalogProduct(fields)).pipe(tap(() => this.afterLocalWrite()));
  }

  update(id: string, fields: CatalogPushFields): Observable<Product> {
    return from(this.api().updateCatalogProduct(id, fields)).pipe(tap(() => this.afterLocalWrite()));
  }

  /**
   * Resuelve un 409 `CATALOG_CONFLICT` (SPEC 56): "Usar el del panel" (`panel`)
   * o "Forzar el mío" (`mine`). Lo resuelto vuelve a la cola; quien llama empuja.
   */
  async resolveConflict(localId: string, choice: CatalogConflictChoice): Promise<boolean> {
    const resolved = await this.api().resolveCatalogConflict(localId, choice);
    this.refreshPending();
    return resolved;
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

  /**
   * Confirma la subida con la versión leída de la cola, para no dar por subida una
   * edición posterior. Con `remoteUpdatedAt` (lo que respondió el servidor) se
   * renueva la foto `baseFields` contra la que compara el siguiente PATCH.
   */
  private markSynced(
    item: PendingCatalogProduct,
    remoteId: string | null,
    remoteUpdatedAt?: unknown,
  ): Promise<void> {
    const synced: CatalogSyncedSnapshot | null =
      item.snapshot && remoteUpdatedAt !== undefined
        ? { fields: item.snapshot, remoteUpdatedAt }
        : null;
    if (synced) {
      return this.api().markCatalogSynced(item.id, remoteId, item.version ?? null, synced);
    }
    return item.version
      ? this.api().markCatalogSynced(item.id, remoteId, item.version)
      : this.api().markCatalogSynced(item.id, remoteId);
  }

  private pushOne(item: PendingCatalogProduct): Observable<unknown> {
    if (item.remoteId) {
      return this.patchOne(item, item.remoteId);
    }
    return this.findExistingBySku(item.fields.sku).pipe(
      switchMap((existing) => {
        if (existing) {
          // SPEC 60: el mismo SKU no basta; solo se adopta si es el mismo producto.
          return this.adoptOrConflict(item, existing, PRODUCT_DUPLICATE);
        }
        return this.http.post<unknown>(`${this.apiUrl}/products`, item.fields).pipe(
          switchMap((response) => {
            const created = unwrapEntity<ProductSummaryDto>(response);
            return from(this.markSynced(item, created.id, created.updatedAt));
          }),
          // 409 = ya existe por SKU o por nombre: se consulta el remoto y se
          // adopta solo si es el mismo producto (SPEC 60).
          catchError((error: unknown) =>
            error instanceof HttpErrorResponse && error.status === 409
              ? this.adoptAfterConflict(item, error)
              : throwError(() => error),
          ),
        );
      }),
      catchError((error: unknown) => this.handleFailure(item.id, error)),
    );
  }

  /**
   * Regla única de adopción (SPEC 60, `shared/utils/product-match.ts`): mismo
   * código de barras, o mismo `nameKey` si alguno no tiene. Si es otro producto,
   * el alta queda bloqueada visible y **no** se pierden su nombre ni su precio.
   */
  private adoptOrConflict(
    item: PendingCatalogProduct,
    remote: ProductSummaryDto,
    code: string,
  ): Observable<unknown> {
    if (isSameProduct(item.fields, { ...remote, name: remote.name ?? '' })) {
      return from(this.markSynced(item, remote.id));
    }
    return from(
      this.api().markCatalogPushFailed(item.id, duplicateConflictReason(remote.name, code)),
    ).pipe(switchMap(() => EMPTY));
  }

  /**
   * 409 del `POST /products`. Con `details.existing` (SPEC 60) se lee ese
   * producto completo (1 lectura: la regla necesita concentración y código); un
   * backend viejo solo manda el texto y se busca por SKU como antes.
   */
  private adoptAfterConflict(item: PendingCatalogProduct, error: HttpErrorResponse): Observable<unknown> {
    const duplicate = productDuplicateOf(error);
    if (!duplicate?.existing) {
      return this.adoptBySearch(item, error);
    }
    return this.http.get<unknown>(`${this.apiUrl}/products/${duplicate.existing.id}`).pipe(
      switchMap((response) =>
        this.adoptOrConflict(item, unwrapEntity<ProductSummaryDto>(response), duplicate.code),
      ),
    );
  }

  /**
   * Edición de un producto que ya existe arriba (SPEC 56). Con foto sube **solo
   * lo cambiado** más `baseUpdatedAt`; el servidor responde 409
   * `CATALOG_CONFLICT` si el precio o el estado cambiaron en el panel después, y
   * la edición queda bloqueada visible con el valor del panel. Sin cambios
   * respecto a la foto no hay nada que subir: se da por subida sin red.
   */
  private patchOne(item: PendingCatalogProduct, remoteId: string): Observable<unknown> {
    const changes = item.changes ?? null;
    if (changes && !Object.keys(changes).length) {
      return from(this.markSynced(item, remoteId, null));
    }
    const body: Record<string, unknown> = { ...(changes ?? item.fields) };
    if (changes && item.baseUpdatedAt) {
      body['baseUpdatedAt'] = item.baseUpdatedAt;
    }
    return this.http.patch<unknown>(`${this.apiUrl}/products/${remoteId}`, body).pipe(
      switchMap((response) => {
        const updated = response ? unwrapEntity<Partial<ProductSummaryDto>>(response) : null;
        return from(this.markSynced(item, remoteId, updated?.updatedAt ?? null));
      }),
      catchError((error: unknown) => {
        const current = catalogConflictOf(error);
        if (current) {
          return from(this.api().markCatalogConflict(item.id, current)).pipe(switchMap(() => EMPTY));
        }
        return this.handleFailure(item.id, error);
      }),
    );
  }

  /**
   * Backend sin `details.existing`: busca el SKU con la búsqueda amplia (camino
   * raro) y aplica la misma regla. Sin coincidencia de SKU (p. ej. chocó por
   * nombre) queda el 409 original, que se marca con su mensaje.
   */
  private adoptBySearch(item: PendingCatalogProduct, original: HttpErrorResponse): Observable<unknown> {
    const params = new HttpParams()
      .set('search', item.fields.sku)
      .set('activeOnly', 'false')
      .set('limit', '5');
    return this.http.get<unknown>(`${this.apiUrl}/products`, { params }).pipe(
      switchMap((response) => {
        const normalized = item.fields.sku.trim().toLowerCase();
        const match = unwrapList<ProductSummaryDto>(response).find(
          (product) => product.sku.trim().toLowerCase() === normalized,
        );
        return match
          ? this.adoptOrConflict(item, match, PRODUCT_DUPLICATE)
          : throwError(() => original);
      }),
    );
  }

  /** Defensa contra duplicados: busca por SKU exacto antes de crear. */
  private findExistingBySku(sku: string): Observable<ProductSummaryDto | null> {
    // `sku` exacto = 1 lectura en Firestore. `search` con un SKU que no existe
    // (el caso normal de un alta) recorre hasta 500 productos.
    const params = new HttpParams().set('sku', sku.trim()).set('activeOnly', 'false').set('limit', '1');
    return this.http.get<unknown>(`${this.apiUrl}/products`, { params }).pipe(
      map((response) => {
        const items = unwrapList<ProductSummaryDto>(response);
        const normalized = sku.trim().toLowerCase();
        return items.find((product) => product.sku.trim().toLowerCase() === normalized) ?? null;
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

  private afterLocalWrite(): void {
    this.refreshPending();
    this.autoPush.notifyChange();
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
