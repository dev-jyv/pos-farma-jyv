import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { Customer } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class CustomerService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  search(term: string): Observable<Customer[]> {
    let params = new HttpParams().set('limit', '20');
    if (term.trim()) {
      params = params.set('search', term.trim());
    }
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
