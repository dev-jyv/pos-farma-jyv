import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { toDate, unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { DirectCharge, DirectChargeChannel, DirectChargeStatus } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

export interface CreateDirectChargePayload {
  /**
   * Llave de idempotencia del cobro: se genera una vez por cobro y se reenvía
   * **sin cambios** en cada reintento. Sin ella un timeout deja al cajero
   * reenviando el mismo cobro a la terminal y cobrando dos veces.
   */
  idempotencyKey: string;
  deviceId: string;
  amount: number;
  concept: string;
}

/** Cobro en línea: no hay terminal, solo monto y concepto. */
export interface CreateOnlineDirectChargePayload {
  idempotencyKey: string;
  amount: number;
  concept: string;
}

export interface ListDirectChargesParams {
  from?: string;
  to?: string;
  channel?: DirectChargeChannel;
  status?: DirectChargeStatus;
  search?: string;
  page?: number;
  limit?: number;
}

function mapDirectCharge(raw: unknown): DirectCharge {
  const data = raw as Record<string, unknown>;
  return {
    ...(data as unknown as DirectCharge),
    canceledAt: data['canceledAt'] ? toDate(data['canceledAt']) : null,
    approvedAt: data['approvedAt'] ? toDate(data['approvedAt']) : null,
    createdAt: toDate(data['createdAt']),
  };
}

/**
 * Cobros con terminal fuera de una venta (servicios, abonos, cobros a terceros).
 * Pega contra `/direct-charges`, colección aparte de `sales`: nada de lo que se
 * cobra aquí toca el inventario, el turno de caja ni los reportes de ventas.
 */
@Injectable({ providedIn: 'root' })
export class DirectChargeService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /** Manda el cobro a la terminal; regresa el cobro en estado `pending`. */
  create(payload: CreateDirectChargePayload): Observable<DirectCharge> {
    return this.http
      .post<unknown>(`${this.apiUrl}/direct-charges`, payload, {
        // También en el header estándar: el backend acepta cualquiera de los dos.
        headers: { 'Idempotency-Key': payload.idempotencyKey },
      })
      .pipe(map((response) => mapDirectCharge(unwrapEntity(response))));
  }

  /**
   * Crea el link de pago de Mercado Pago (Checkout Pro). El cobro nace
   * `pending` y trae el link en `online.initPoint`.
   */
  createOnline(payload: CreateOnlineDirectChargePayload): Observable<DirectCharge> {
    return this.http
      .post<unknown>(`${this.apiUrl}/direct-charges/online`, payload, {
        headers: { 'Idempotency-Key': payload.idempotencyKey },
      })
      .pipe(map((response) => mapDirectCharge(unwrapEntity(response))));
  }

  /** Estado actual del cobro; el backend consulta a Mercado Pago si sigue pendiente. */
  get(id: string): Observable<DirectCharge> {
    return this.http
      .get<unknown>(`${this.apiUrl}/direct-charges/${id}`)
      .pipe(map((response) => mapDirectCharge(unwrapEntity(response))));
  }

  cancel(id: string): Observable<DirectCharge> {
    return this.http
      .post<unknown>(`${this.apiUrl}/direct-charges/${id}/cancel`, {})
      .pipe(map((response) => mapDirectCharge(unwrapEntity(response))));
  }

  list(params: ListDirectChargesParams = {}): Observable<DirectCharge[]> {
    let httpParams = new HttpParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        httpParams = httpParams.set(key, String(value));
      }
    });
    return this.http
      .get<unknown>(`${this.apiUrl}/direct-charges`, { params: httpParams })
      .pipe(map((response) => unwrapList<unknown>(response).map(mapDirectCharge)));
  }
}
