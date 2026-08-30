import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, of } from 'rxjs';

import { unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { Customer } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class CustomerService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /**
   * Busca clientes por término. Sin término no se consulta: `GET /customers` sin
   * `search` hace que el backend lea la colección completa para devolver 20, y
   * eso ocurría cada vez que el cajero limpiaba el campo del cobro.
   */
  search(term: string): Observable<Customer[]> {
    const search = term.trim();
    if (!search) {
      return of([]);
    }
    const params = new HttpParams().set('limit', '20').set('search', search);
    return this.http
      .get<unknown>(`${this.apiUrl}/customers`, { params })
      .pipe(map((response) => unwrapList<Customer>(response)));
  }

  create(input: { name: string; rfc?: string; phone?: string; email?: string }): Observable<Customer> {
    return this.http
      .post<unknown>(`${this.apiUrl}/customers`, input)
      .pipe(map((response) => unwrapEntity<Customer>(response)));
  }
}
