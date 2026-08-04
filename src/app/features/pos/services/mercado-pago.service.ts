import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import { environment } from '../../../../environments/environment';

export type PointOrderStatus =
  | 'created'
  | 'at_terminal'
  | 'processed'
  | 'action_required'
  | 'failed'
  | 'refunded'
  | 'expired'
  | 'canceled';

export const POINT_ORDER_PENDING_STATUSES: PointOrderStatus[] = ['created', 'at_terminal', 'action_required'];

export interface PointDevice {
  id: string;
  posId: string | null;
  storeId: string | null;
  externalPosId: string | null;
  operatingMode: string;
}

export interface PointOrder {
  id: string;
  status: PointOrderStatus;
  statusDetail: string | null;
  terminalId: string;
  amount: string;
  externalReference: string;
  paymentId: string | null;
}

@Injectable({ providedIn: 'root' })
export class MercadoPagoService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  listDevices(): Observable<PointDevice[]> {
    const { storeId, posId } = environment.mercadoPago;
    const params: Record<string, string> = {};
    if (storeId) {
      params['storeId'] = storeId;
    }
    if (posId) {
      params['posId'] = posId;
    }
    return this.http
      .get<unknown>(`${this.apiUrl}/payments/mercadopago/devices`, { params })
      .pipe(map((response) => unwrapList<PointDevice>(response)));
  }

  setDeviceOperatingMode(deviceId: string, operatingMode: 'PDV' | 'STANDALONE'): Observable<PointDevice> {
    return this.http
      .patch<unknown>(`${this.apiUrl}/payments/mercadopago/devices/operating-mode`, {
        deviceId,
        operatingMode,
      })
      .pipe(map((response) => unwrapEntity<PointDevice>(response)));
  }

  createOrder(deviceId: string, amount: number, externalReference: string): Observable<PointOrder> {
    return this.http
      .post<unknown>(`${this.apiUrl}/payments/mercadopago/orders`, {
        deviceId,
        amount,
        externalReference,
      })
      .pipe(map((response) => unwrapEntity<PointOrder>(response)));
  }

  getOrder(orderId: string): Observable<PointOrder> {
    return this.http
      .get<unknown>(`${this.apiUrl}/payments/mercadopago/orders/${orderId}`)
      .pipe(map((response) => unwrapEntity<PointOrder>(response)));
  }

  cancelOrder(orderId: string): Observable<void> {
    return this.http
      .delete<unknown>(`${this.apiUrl}/payments/mercadopago/orders/${orderId}`)
      .pipe(map(() => undefined));
  }
}
