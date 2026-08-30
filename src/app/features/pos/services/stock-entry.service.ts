import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { toDate, unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { ControlledGroup, Product, PurchaseInvoice } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

/** Campos del producto tal como los acepta el catálogo del backend. */
export interface ProductFieldsPayload {
  name: string;
  sku: string;
  categoryId: string;
  unit: string;
  salePrice: number;
  minStock: number;
  hasIva: boolean;
  hasIvaZero: boolean;
  hasIeps: boolean;
  barcode?: string;
  activeIngredient?: string;
  concentration?: string;
  /** Fracción, no porcentaje: 0.08 es 8 %. La pantalla captura el porcentaje. */
  iepsRate?: number;
  controlledGroup?: ControlledGroup;
  requiresPrescription?: boolean;
}

export interface CreateStockEntryPayload {
  invoiceId: string;
  lotNumber: string;
  /** `YYYY-MM-DD`; el backend rechaza fechas pasadas. */
  expiryDate: string;
  quantity: number;
  costPrice?: number;
  /** Producto existente al que se le suma el stock. */
  productId?: string;
  /** Correcciones al producto existente; solo los campos que el cajero tocó. */
  productUpdate?: Partial<ProductFieldsPayload>;
  /** Alta de un producto que no está en el catálogo. */
  product?: ProductFieldsPayload;
}

export interface StockEntryResult {
  product: Product;
  /** Existencias del producto **después** de la entrada. */
  stock: number;
}

interface InvoiceDto {
  id: string;
  invoiceNumber: string;
  invoiceDate: unknown;
  supplierId: string;
  supplier?: { id?: string; name?: string };
  totalAmount: number;
  hasInvoice?: boolean;
}

function mapInvoice(dto: InvoiceDto): PurchaseInvoice {
  return {
    id: dto.id,
    invoiceNumber: dto.invoiceNumber,
    invoiceDate: toDate(dto.invoiceDate),
    supplierId: dto.supplierId ?? dto.supplier?.id ?? '',
    supplierName: dto.supplier?.name ?? '',
    totalAmount: dto.totalAmount,
    hasInvoice: dto.hasInvoice !== false,
  };
}

/**
 * Entrada de stock desde la caja (`/stock-entries`). Pega contra el módulo
 * propio del backend y no contra `/inventory/*`: recibir mercancía es una
 * atribución del mostrador, mientras que conteos, salidas y libro de control
 * siguen siendo del panel.
 */
@Injectable({ providedIn: 'root' })
export class StockEntryService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /** Últimas facturas registradas, de la más reciente a la más vieja. */
  listRecentInvoices(limit = 10): Observable<PurchaseInvoice[]> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http
      .get<unknown>(`${this.apiUrl}/stock-entries/invoices`, { params })
      .pipe(map((response) => unwrapList<InvoiceDto>(response).map(mapInvoice)));
  }

  create(payload: CreateStockEntryPayload): Observable<StockEntryResult> {
    return this.http
      .post<unknown>(`${this.apiUrl}/stock-entries`, payload)
      .pipe(map((response) => unwrapEntity<StockEntryResult>(response)));
  }
}
