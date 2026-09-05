import { Injectable } from '@angular/core';
import { Observable, from } from 'rxjs';

import { ProductBatch } from '../../../shared/models';

/**
 * Lotes local-first: viven en el SQLite del proceso main (`electron/db/products.js`,
 * sincronizados junto con el catálogo). Sin esto, agregar al carrito tenía que
 * pegarle a `GET /inventory/batches` con el id del producto — que además ya no
 * era válido offline (el id local no existe en el backend).
 */
@Injectable({ providedIn: 'root' })
export class BatchService {
  listByProduct(productId: string): Observable<ProductBatch[]> {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI no disponible: los lotes requieren correr dentro de Electron.');
    }
    return from(api.catalog.getBatchesByProduct(productId));
  }
}
