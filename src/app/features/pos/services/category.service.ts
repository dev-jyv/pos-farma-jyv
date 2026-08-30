import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, of, shareReplay } from 'rxjs';

import { unwrapList } from '../../../core/api/api.utils';
import { Category } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

/** Tope del backend por página; el catálogo de categorías de una farmacia cabe. */
const PAGE_LIMIT = 100;

/**
 * Categorías del catálogo, para el alta de productos desde la caja.
 *
 * Se cachean por sesión: la lista no cambia durante un turno y la pantalla de
 * entrada de stock la necesita cada vez que se abre.
 */
@Injectable({ providedIn: 'root' })
export class CategoryService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  private categories: Category[] | null = null;
  private request$: Observable<Category[]> | null = null;

  list(): Observable<Category[]> {
    if (this.categories) {
      return of(this.categories);
    }
    if (!this.request$) {
      const params = new HttpParams().set('limit', String(PAGE_LIMIT));
      this.request$ = this.http.get<unknown>(`${this.apiUrl}/categories`, { params }).pipe(
        map((response) =>
          unwrapList<Category>(response).map((category) => ({
            id: category.id,
            name: category.name,
          })),
        ),
        map((categories) => {
          this.categories = categories;
          this.request$ = null;
          return categories;
        }),
        shareReplay(1),
      );
    }
    return this.request$;
  }

  /** Descarta lo cacheado; la siguiente consulta vuelve al servidor. */
  invalidate(): void {
    this.categories = null;
    this.request$ = null;
  }
}
