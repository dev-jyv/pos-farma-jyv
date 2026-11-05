import { Injectable } from '@angular/core';
import { Observable, from, of } from 'rxjs';

import { Product } from '../../../shared/models';

/**
 * Catálogo local-first: vive en SQLite dentro del proceso main de Electron
 * (ver `electron/db/products.js`) y se sincroniza contra Firestore en los
 * horarios fijos de `SyncScheduler`. No hay red ni caché aquí — leer SQLite
 * ya es instantáneo, y el stock que se ve es el de la última sincronización.
 */
@Injectable({ providedIn: 'root' })
export class ProductService {
  search(term: string): Observable<Product[]> {
    const normalized = term.trim();
    if (!normalized) {
      return of([]);
    }
    return from(this.api().search(normalized));
  }

  /**
   * Productos (activos o no) con ese mismo nombre en el catálogo local.
   * `excludeId` deja fuera al producto que se está editando.
   */
  findByName(name: string, excludeId?: string | null): Observable<Product[]> {
    if (!name.trim()) {
      return of([]);
    }
    return from(this.api().findByName(name, excludeId ?? null));
  }

  getByBarcode(code: string): Observable<Product | null> {
    return from(this.api().getByBarcode(code));
  }

  /** Productos actuales por id: refresca precio, stock y banderas de un ticket guardado. */
  getByIds(ids: string[]): Observable<Product[]> {
    return from(this.api().getByIds(ids));
  }

  private api() {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI no disponible: el catálogo requiere correr dentro de Electron.');
    }
    return api.catalog;
  }
}
