import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import {
  ApiListMeta,
  toDate,
  toHttpParams,
  unwrapEntity,
  unwrapListWithMeta,
} from '../../../core/api/api.utils';
import { Supplier } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

export interface ListSuppliersQuery {
  search?: string;
  activeOnly?: boolean;
  page?: number;
  limit?: number;
}

export interface SupplierFields {
  name?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  isActive?: boolean;
}

interface SupplierDto {
  id: string;
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  isActive: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

function mapSupplier(dto: SupplierDto): Supplier {
  return {
    id: dto.id,
    name: dto.name,
    contactName: dto.contactName,
    email: dto.email,
    phone: dto.phone,
    address: dto.address,
    notes: dto.notes,
    isActive: dto.isActive,
    createdAt: toDate(dto.createdAt),
    updatedAt: toDate(dto.updatedAt),
  };
}

/** CRUD de proveedores (`suppliers:write`), mismos endpoints/validaciones que el admin. */
@Injectable({ providedIn: 'root' })
export class SupplierService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  list(query: ListSuppliersQuery): Observable<{ items: Supplier[]; meta: ApiListMeta }> {
    return this.http
      .get<unknown>(`${this.apiUrl}/suppliers`, { params: toHttpParams({ ...query }) })
      .pipe(
        map((response) => {
          const { items, meta } = unwrapListWithMeta<SupplierDto>(response);
          const suppliers = items.map(mapSupplier);
          return {
            items: suppliers,
            meta: meta ?? {
              page: query.page ?? 1,
              limit: query.limit ?? suppliers.length,
              total: suppliers.length,
              totalPages: 1,
            },
          };
        }),
      );
  }

  /**
   * Todos los activos, para el `Select` de proveedor en facturas. `limit` no
   * puede pasar de 100 (`MAX_PAGE_LIMIT` en el backend) o el request truena
   * con 400; con más proveedores que eso haría falta paginar el `Select`, pero
   * un catálogo de farmacia no llega a ese tamaño.
   */
  listActive(): Observable<Supplier[]> {
    const params = toHttpParams({ activeOnly: true, limit: 100 });
    return this.http
      .get<unknown>(`${this.apiUrl}/suppliers`, { params })
      .pipe(map((response) => unwrapListWithMeta<SupplierDto>(response).items.map(mapSupplier)));
  }

  getById(id: string): Observable<Supplier> {
    return this.http
      .get<unknown>(`${this.apiUrl}/suppliers/${id}`)
      .pipe(map((response) => mapSupplier(unwrapEntity<SupplierDto>(response))));
  }

  create(data: SupplierFields): Observable<Supplier> {
    return this.http
      .post<unknown>(`${this.apiUrl}/suppliers`, data)
      .pipe(map((response) => mapSupplier(unwrapEntity<SupplierDto>(response))));
  }

  update(id: string, data: SupplierFields): Observable<Supplier> {
    return this.http
      .patch<unknown>(`${this.apiUrl}/suppliers/${id}`, data)
      .pipe(map((response) => mapSupplier(unwrapEntity<SupplierDto>(response))));
  }

  deactivate(id: string): Observable<Supplier> {
    return this.update(id, { isActive: false });
  }
}
