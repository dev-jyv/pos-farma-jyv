import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { toDate, unwrapList } from '../../../core/api/api.utils';
import { ControlledGroup, SalePrescription } from '../../../shared/models';
import { isControlledGroup } from '../../../shared/utils/controlled';
import { environment } from '../../../../environments/environment';

/**
 * Libro de control de medicamentos controlados (`GET /inventory/controlled-ledger`).
 *
 * Es el registro que se muestra en una visita de COFEPRIS: cada movimiento de un
 * producto de los grupos I a IV, con receta, lote y cantidad **con signo** (negativa
 * cuando el producto regresa por anulación o devolución).
 */

export type ControlledLedgerType = 'sale' | 'void' | 'return';

export interface ControlledLedgerEntry {
  id: string;
  type: ControlledLedgerType;
  saleId: string;
  saleFolio: string;
  /** Folio de la devolución cuando `type` es `return`. */
  referenceFolio: string | null;
  productId: string;
  productName: string;
  controlledGroup: ControlledGroup;
  quantity: number;
  lotNumbers: string[];
  prescription: SalePrescription | null;
  prescriptionRetained: boolean;
  customerName: string | null;
  userId: string;
  createdAt: Date;
}

export interface ControlledLedgerFilters {
  from?: string;
  to?: string;
  group?: ControlledGroup;
  productId?: string;
  saleId?: string;
  page?: number;
  limit?: number;
}

interface ControlledLedgerEntryDto extends Omit<ControlledLedgerEntry, 'createdAt' | 'controlledGroup'> {
  controlledGroup: unknown;
  createdAt: unknown;
}

@Injectable({ providedIn: 'root' })
export class ControlledLedgerService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  list(filters: ControlledLedgerFilters = {}): Observable<ControlledLedgerEntry[]> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    }
    return this.http
      .get<unknown>(`${this.apiUrl}/inventory/controlled-ledger`, { params })
      .pipe(
        map((response) =>
          unwrapList<ControlledLedgerEntryDto>(response).map((dto) => ({
            ...dto,
            controlledGroup: isControlledGroup(dto.controlledGroup) ? dto.controlledGroup : 'VI',
            lotNumbers: Array.isArray(dto.lotNumbers) ? dto.lotNumbers : [],
            prescriptionRetained: dto.prescriptionRetained === true,
            createdAt: toDate(dto.createdAt),
          })),
        ),
      );
  }
}
