import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

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

  /**
   * Terminal de **esta** caja. Con varias terminales en la misma cuenta, tomar la
   * primera de la lista puede mandar el cobro a otra sucursal; `terminalId` del
   * entorno fija la que está en este mostrador. Si no está configurada o no
   * aparece en la lista, se cae a la primera disponible.
   */
  preferredDevice(devices: PointDevice[]): PointDevice | null {
    const preferred = environment.mercadoPago.terminalId?.trim();
    if (preferred) {
      const match = devices.find((device) => device.id === preferred);
      if (match) {
        return match;
      }
    }
    return devices[0] ?? null;
  }

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
      .pipe(map((response) => unwrapList<PointDevice>(response)), catchError((error) => {
        console.error(error);
        return of([]);
      }));
  }

  setDeviceOperatingMode(deviceId: string, operatingMode: 'PDV' | 'STANDALONE'): Observable<PointDevice> {
    return this.http
      .patch<unknown>(`${this.apiUrl}/payments/mercadopago/devices/operating-mode`, {
        deviceId,
        operatingMode,
      })
      .pipe(map((response) => unwrapEntity<PointDevice>(response)));
  }

  /**
   * Manda el cobro a la terminal. La referencia externa se reusa como llave de
   * idempotencia: ya es única por intento de cobro, y sin ella un reintento de
   * red del mismo POST crea una **segunda** orden en la misma terminal.
   */
  createOrder(deviceId: string, amount: number, externalReference: string): Observable<PointOrder> {
    return this.http
      .post<unknown>(
        `${this.apiUrl}/payments/mercadopago/orders`,
        {
          deviceId,
          amount,
          externalReference,
          idempotencyKey: externalReference,
        },
        { headers: { 'Idempotency-Key': externalReference } },
      )
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
