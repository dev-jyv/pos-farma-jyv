import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { toDate, unwrapList } from '../../../core/api/api.utils';
import { ProductBatch } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

interface BatchDto {
  id: string;
  productId: string;
  lotNumber: string;
  expiryDate: unknown;
  quantity: number;
}

@Injectable({ providedIn: 'root' })
export class BatchService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  listByProduct(productId: string): Observable<ProductBatch[]> {
    return this.http
      .get<unknown>(`${this.apiUrl}/inventory/batches`, { params: { productId } })
      .pipe(
        map((response) =>
          unwrapList<BatchDto>(response).map((dto) => ({
            id: dto.id,
            productId: dto.productId,
            lotNumber: dto.lotNumber,
            expiryDate: toDate(dto.expiryDate),
            quantity: dto.quantity,
          })),
        ),
      );
  }
}
