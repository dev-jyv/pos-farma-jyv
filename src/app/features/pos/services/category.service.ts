import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, of, shareReplay, tap } from 'rxjs';

import {
  ApiListMeta,
  toDate,
  toHttpParams,
  unwrapEntity,
  unwrapListWithMeta,
} from '../../../core/api/api.utils';
import { Category } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

/** Tope del backend por página; el catálogo de categorías de una farmacia cabe. */
const OPTIONS_LIMIT = 100;

export interface ListCategoriesQuery {
  search?: string;
  activeOnly?: boolean;
  page?: number;
  limit?: number;
}

export interface CategoryFields {
  name?: string;
  description?: string;
  isActive?: boolean;
}

interface CategoryDto {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

function mapCategory(dto: CategoryDto): Category {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? '',
    isActive: dto.isActive,
    createdAt: toDate(dto.createdAt),
    updatedAt: toDate(dto.updatedAt),
  };
}

/**
 * Categorías del catálogo: listado paginado y CRUD para la pantalla de
 * administración, y `options()` —cacheado— para los selectores.
 *
 * Antes eran dos servicios (`CategoryService` de solo lectura y
 * `CategoryAdminService`), y eso escondía un fallo: crear una categoría desde
 * `/pos/categorias` no invalidaba la caché del otro, así que la entrada de stock
 * no la veía hasta recargar la app. Con un solo servicio, cada escritura tira la
 * caché.
 */
@Injectable({ providedIn: 'root' })
export class CategoryService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /** Categorías activas cacheadas para los selectores. */
  private options$: Observable<Category[]> | null = null;
  private cached: Category[] | null = null;

  /** Listado paginado de la pantalla de administración. */
  list(query: ListCategoriesQuery = {}): Observable<{ items: Category[]; meta: ApiListMeta }> {
    return this.http
      .get<unknown>(`${this.apiUrl}/categories`, { params: toHttpParams({ ...query }) })
      .pipe(
        map((response) => {
          const { items, meta } = unwrapListWithMeta<CategoryDto>(response);
          const categories = items.map(mapCategory);
          return {
            items: categories,
            // Sin `meta` la pantalla no puede paginar; se asume una sola página.
            meta: meta ?? {
              page: query.page ?? 1,
              limit: query.limit ?? categories.length,
              total: categories.length,
              totalPages: 1,
            },
          };
        }),
      );
  }

  /**
   * Categorías activas para un `Select`. Se cachea porque la lista no cambia
   * durante un turno y la pantalla de entrada de stock la pide cada vez que se
   * abre; cualquier escritura de este mismo servicio la invalida.
   */
  options(): Observable<Category[]> {
    if (this.cached) {
      return of(this.cached);
    }
    if (!this.options$) {
      this.options$ = this.http
        .get<unknown>(`${this.apiUrl}/categories`, {
          params: toHttpParams({ activeOnly: true, limit: OPTIONS_LIMIT }),
        })
        .pipe(
          map((response) => unwrapListWithMeta<CategoryDto>(response).items.map(mapCategory)),
          tap((categories) => {
            this.cached = categories;
            this.options$ = null;
          }),
          shareReplay(1),
        );
    }
    return this.options$;
  }

  getById(id: string): Observable<Category> {
    return this.http
      .get<unknown>(`${this.apiUrl}/categories/${id}`)
      .pipe(map((response) => mapCategory(unwrapEntity<CategoryDto>(response))));
  }

  create(data: CategoryFields): Observable<Category> {
    return this.http
      .post<unknown>(`${this.apiUrl}/categories`, data)
      .pipe(
        map((response) => mapCategory(unwrapEntity<CategoryDto>(response))),
        tap(() => this.invalidate()),
      );
  }

  update(id: string, data: CategoryFields): Observable<Category> {
    return this.http
      .patch<unknown>(`${this.apiUrl}/categories/${id}`, data)
      .pipe(
        map((response) => mapCategory(unwrapEntity<CategoryDto>(response))),
        tap(() => this.invalidate()),
      );
  }

  deactivate(id: string): Observable<Category> {
    return this.update(id, { isActive: false });
  }

  /** Descarta las opciones cacheadas; la siguiente consulta vuelve al servidor. */
  invalidate(): void {
    this.cached = null;
    this.options$ = null;
  }
}
