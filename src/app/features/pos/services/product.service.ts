import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { unwrapList } from '../../../core/api/api.utils';
import { Product } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ProductService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  search(term: string): Observable<Product[]> {
    return this.http
      .get<unknown>(`${this.apiUrl}/products`, { params: { search: term } })
      .pipe(map((response) => unwrapList<Product>(response, 'products')));
  }
}
