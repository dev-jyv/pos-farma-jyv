import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { unwrapEntity } from '../../../core/api/api.utils';
import {
  ProductStockRefreshResult,
  ProductStockSnapshot,
} from '../../../core/electron/window.d';
import { Product } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

/** Tope de la consulta: hay un cliente enfrente y la caja no puede quedarse esperando. */
export const STOCK_REFRESH_TIMEOUT_MS = 3_000;

/** Antirrebote: a lo más una consulta por producto en esta ventana. */
export const STOCK_REFRESH_DEBOUNCE_MS = 30_000;

/**
 * Stock fresco antes de negar una venta (SPEC 57).
 *
 * La copia local solo se pone al día con el pull de horario (10:30, 14:00,
 * 20:00) o con "Sincronizar": la mercancía que recibió otra caja se quedaba
 * horas sin poder venderse aquí. Cuando la venta se va a negar por stock local
 * insuficiente, la caja pregunta **solo ese producto** (`GET /products/:id/stock`,
 * 1 lectura + 1 consulta de lotes) y guarda la respuesta en SQLite respetando lo
 * pendiente de subir (`products:refreshOne`).
 *
 * No consulta (y la venta se niega con el mensaje de siempre):
 * - sin red (`navigator.onLine`): sin llamada HTTP;
 * - producto creado en la caja sin `remoteId`: el servidor no lo conoce;
 * - si ya se consultó ese producto en los últimos 30 s;
 * - fuera de Electron.
 */
@Injectable({ providedIn: 'root' })
export class ProductStockService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /** Último intento por `remoteId` (éxito o no): el antirrebote cuenta intentos. */
  private readonly lastAttempt = new Map<string, number>();

  /**
   * Consulta el stock de un producto al servidor y lo guarda en SQLite.
   *
   * Devuelve `null` **en el acto** (sin promesa) cuando no va a consultar: así
   * la negativa sale en el mismo instante que siempre. Si consulta, la promesa
   * resuelve con producto y lotes frescos, o con `null` si falló (sin respuesta
   * en 3 s, 404, SQLite ocupada): quien llama mantiene la negativa.
   */
  refresh(
    product: Pick<Product, 'remoteId'>,
    now = Date.now(),
  ): Promise<ProductStockRefreshResult | null> | null {
    const remoteId = product.remoteId?.trim();
    const api = window.electronAPI?.products;
    if (!remoteId || !api || !this.online()) {
      return null;
    }
    const last = this.lastAttempt.get(remoteId);
    if (last !== undefined && now - last < STOCK_REFRESH_DEBOUNCE_MS) {
      return null;
    }
    this.lastAttempt.set(remoteId, now);
    return this.fetchAndStore(remoteId, (id, snapshot) => api.refreshOne(id, snapshot));
  }

  private async fetchAndStore(
    remoteId: string,
    store: (remoteId: string, snapshot: ProductStockSnapshot) => Promise<ProductStockRefreshResult | null>,
  ): Promise<ProductStockRefreshResult | null> {
    try {
      const response = await firstValueFrom(
        this.http
          .get<unknown>(`${this.apiUrl}/products/${encodeURIComponent(remoteId)}/stock`)
          .pipe(timeout(STOCK_REFRESH_TIMEOUT_MS)),
      );
      const snapshot = unwrapEntity<ProductStockSnapshot>(response);
      if (!snapshot || typeof snapshot.totalStock !== 'number') {
        return null;
      }
      return await store(remoteId, snapshot);
    } catch {
      return null;
    }
  }

  private online(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }
}
