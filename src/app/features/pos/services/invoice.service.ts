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
import { PurchaseInvoice } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

export interface ListInvoicesQuery {
  search?: string;
  supplierId?: string;
  from?: string;
  to?: string;
  hasInvoice?: boolean;
  page?: number;
  limit?: number;
}

export interface CreateInvoicePayload {
  supplierId: string;
  invoiceNumber: string;
  /** `YYYY-MM-DD`. */
  invoiceDate: string;
  totalAmount: number;
  hasInvoice: boolean;
  fileUrl: string;
}

interface InvoiceDto {
  id: string;
  supplierId: string;
  supplier?: { id?: string; name?: string };
  invoiceNumber: string;
  invoiceDate: unknown;
  totalAmount?: number;
  hasInvoice: boolean;
  fileUrl?: string;
}

function mapInvoice(dto: InvoiceDto): PurchaseInvoice {
  return {
    id: dto.id,
    invoiceNumber: dto.invoiceNumber,
    invoiceDate: toDate(dto.invoiceDate),
    supplierId: dto.supplierId ?? dto.supplier?.id ?? '',
    supplierName: dto.supplier?.name ?? '',
    totalAmount: dto.totalAmount ?? 0,
    hasInvoice: dto.hasInvoice !== false,
    fileUrl: dto.fileUrl,
  };
}

/** CRUD de facturas de compra (`invoices:write`), mismos endpoints que el admin. */
@Injectable({ providedIn: 'root' })
export class InvoiceService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  list(query: ListInvoicesQuery): Observable<{ items: PurchaseInvoice[]; meta: ApiListMeta }> {
    return this.http
      .get<unknown>(`${this.apiUrl}/invoices`, { params: toHttpParams({ ...query }) })
      .pipe(
        map((response) => {
          const { items, meta } = unwrapListWithMeta<InvoiceDto>(response);
          const invoices = items.map(mapInvoice);
          return {
            items: invoices,
            meta: meta ?? {
              page: query.page ?? 1,
              limit: query.limit ?? invoices.length,
              total: invoices.length,
              totalPages: 1,
            },
          };
        }),
      );
  }

  getById(id: string): Observable<PurchaseInvoice> {
    return this.http
      .get<unknown>(`${this.apiUrl}/invoices/${id}`)
      .pipe(map((response) => mapInvoice(unwrapEntity<InvoiceDto>(response))));
  }

  create(payload: CreateInvoicePayload): Observable<PurchaseInvoice> {
    return this.http
      .post<unknown>(`${this.apiUrl}/invoices`, payload)
      .pipe(map((response) => mapInvoice(unwrapEntity<InvoiceDto>(response))));
  }
}
