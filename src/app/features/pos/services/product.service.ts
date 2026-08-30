import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, finalize, map, of, shareReplay } from 'rxjs';

import { unwrapList } from '../../../core/api/api.utils';
import { Product } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

/**
 * Cuántos resultados pide la caja. La lista del mostrador se recorre con la
 * vista, no con scroll infinito: pedir 100 solo engorda la respuesta.
 */
const SEARCH_LIMIT = 25;

/**
 * Vida de la caché de búsquedas. Corta a propósito: el stock cambia con cada
 * venta y un resultado viejo pintaría existencias que ya no están.
 */
const CACHE_TTL_MS = 30_000;

/** Tope de términos cacheados; el mostrador repite pocos en una jornada. */
const CACHE_MAX_ENTRIES = 40;

@Injectable({ providedIn: 'root' })
export class ProductService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /** Resultados recientes por término normalizado. */
  private readonly cache = new Map<string, { at: number; products: Product[] }>();
  /** Peticiones en vuelo, para que dos disparos del mismo término compartan una. */
  private readonly inFlight = new Map<string, Observable<Product[]>>();

  /**
   * Busca en el catálogo del servidor. **El POS nunca guarda el catálogo
   * completo**: cada búsqueda es una consulta acotada y lo único que se conserva
   * es el resultado reciente, en memoria y por 30 s.
   *
   * Un término vacío se resuelve sin red: `GET /products` sin `search` hace que
   * el backend lea la colección entera de Firestore, y eso ocurría cada vez que
   * el cajero limpiaba el buscador.
   */
  search(term: string): Observable<Product[]> {
    const normalized = term.trim().toLowerCase();
    if (!normalized) {
      return of([]);
    }

    const cached = this.cache.get(normalized);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return of(cached.products);
    }

    const pending = this.inFlight.get(normalized);
    if (pending) {
      return pending;
    }

    const params = new HttpParams().set('search', term.trim()).set('limit', String(SEARCH_LIMIT));
    const request = this.http.get<unknown>(`${this.apiUrl}/products`, { params }).pipe(
      map((response) =>
        unwrapList<Product>(response, 'products').map((product) => ({
          ...product,
          stock: Math.max(0, product.stock ?? 0),
        })),
      ),
      map((products) => {
        this.remember(normalized, products);
        return products;
      }),
      finalize(() => this.inFlight.delete(normalized)),
      shareReplay(1),
    );

    this.inFlight.set(normalized, request);
    return request;
  }

  /**
   * Descarta lo cacheado. Se llama tras registrar una venta: el stock que se
   * acaba de descontar no debe seguir pintándose como disponible.
   */
  invalidate(): void {
    this.cache.clear();
  }

  private remember(term: string, products: Product[]): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Map conserva el orden de inserción: el más viejo es el primero.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(term, { at: Date.now(), products });
  }
}
