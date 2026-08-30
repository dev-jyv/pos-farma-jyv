import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiListMeta, toDate, unwrapListWithMeta } from '../../../core/api/api.utils';
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
  /**
   * `null` cuando el renglón llegó sin grupo válido. **No se sustituye por un
   * grupo por defecto**: antes se caía a `'VI'` (venta libre), y eso imprimía un
   * movimiento de controlado como si no lo fuera y además lo sumaba al resumen.
   * En una hoja que firma un verificador, inventar el grupo es peor que admitir
   * que falta.
   */
  controlledGroup: ControlledGroup | null;
  quantity: number;
  lotNumbers: string[];
  prescription: SalePrescription | null;
  prescriptionRetained: boolean;
  customerName: string | null;
  userId: string;
  createdAt: Date;
}

/** Renglones más el `meta` del servidor, para poder detectar truncamiento. */
export interface ControlledLedgerPage {
  entries: ControlledLedgerEntry[];
  meta: ApiListMeta | null;
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

  private buildParams(filters: ControlledLedgerFilters): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    }
    return params;
  }

  list(filters: ControlledLedgerFilters = {}): Observable<ControlledLedgerPage> {
    return this.http
      .get<unknown>(`${this.apiUrl}/inventory/controlled-ledger`, {
        params: this.buildParams(filters),
      })
      .pipe(
        map((response) => {
          const { items, meta } = unwrapListWithMeta<ControlledLedgerEntryDto>(response);
          return {
            entries: items.map((dto) => ({
              ...dto,
              controlledGroup: isControlledGroup(dto.controlledGroup) ? dto.controlledGroup : null,
              lotNumbers: Array.isArray(dto.lotNumbers) ? dto.lotNumbers : [],
              prescriptionRetained: dto.prescriptionRetained === true,
              createdAt: toDate(dto.createdAt),
            })),
            meta,
          };
        }),
      );
  }

  /**
   * Libro completo del periodo en CSV (`GET .../controlled-ledger/export`).
   *
   * El endpoint no pagina: es el archivo que se entrega y se firma en una visita
   * de COFEPRIS. La pantalla pagina para poder mostrarse, pero el entregable
   * legal nunca debe salir de una vista truncada.
   */
  exportCsv(filters: Omit<ControlledLedgerFilters, 'page' | 'limit'> = {}): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/inventory/controlled-ledger/export`, {
      params: this.buildParams(filters),
      responseType: 'blob',
    });
  }
}
