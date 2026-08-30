import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import {
  MercadoPagoService,
  POINT_ORDER_PENDING_STATUSES,
  PointDevice,
  PointOrder,
} from './mercado-pago.service';

const BASE = `${environment.apiUrl}/payments/mercadopago`;

describe('MercadoPagoService', () => {
  let service: MercadoPagoService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(MercadoPagoService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('POINT_ORDER_PENDING_STATUSES cubre solo los estados que aún pueden cambiar', () => {
    expect(POINT_ORDER_PENDING_STATUSES).toEqual(['created', 'at_terminal', 'action_required']);
    expect(POINT_ORDER_PENDING_STATUSES).not.toContain('processed');
  });

  describe('preferredDevice', () => {
    const original = environment.mercadoPago.terminalId;
    const devices = [
      { id: 'OTRA_SUCURSAL' },
      { id: 'ESTA_CAJA' },
    ] as PointDevice[];

    afterEach(() => {
      environment.mercadoPago.terminalId = original;
    });

    it('elige la terminal de esta caja aunque no sea la primera de la lista', () => {
      environment.mercadoPago.terminalId = 'ESTA_CAJA';
      expect(service.preferredDevice(devices)?.id).toBe('ESTA_CAJA');
    });

    it('sin terminal configurada usa la primera disponible', () => {
      environment.mercadoPago.terminalId = '';
      expect(service.preferredDevice(devices)?.id).toBe('OTRA_SUCURSAL');
    });

    it('si la terminal configurada no está en la lista cae a la primera', () => {
      environment.mercadoPago.terminalId = 'APAGADA';
      expect(service.preferredDevice(devices)?.id).toBe('OTRA_SUCURSAL');
    });

    it('sin terminales no hay ninguna que elegir', () => {
      expect(service.preferredDevice([])).toBeNull();
    });
  });

  it('lista terminales filtrando por la sucursal y caja del entorno', () => {
    service.listDevices().subscribe();

    const request = http.expectOne((req) => req.url === `${BASE}/devices`);
    const { storeId, posId } = environment.mercadoPago;
    if (storeId) {
      expect(request.request.params.get('storeId')).toBe(storeId);
    }
    if (posId) {
      expect(request.request.params.get('posId')).toBe(posId);
    }
    request.flush({ data: [] });
  });

  it('devuelve lista vacía si el listado de terminales falla: la caja no debe romperse', () => {
    let devices: PointDevice[] | undefined;
    service.listDevices().subscribe((result) => (devices = result));

    http.expectOne((req) => req.url === `${BASE}/devices`).flush(
      { error: { message: 'boom' } },
      { status: 500, statusText: 'Server Error' },
    );

    expect(devices).toEqual([]);
  });

  it('activa el modo PDV de una terminal', () => {
    service.setDeviceOperatingMode('D1', 'PDV').subscribe();

    const request = http.expectOne(`${BASE}/devices/operating-mode`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ deviceId: 'D1', operatingMode: 'PDV' });
    request.flush({ data: { id: 'D1', operatingMode: 'PDV' } });
  });

  it('crea la order con monto y referencia externa', () => {
    let order: PointOrder | undefined;
    service.createOrder('D1', 150.5, 'sale-key-1').subscribe((result) => (order = result));

    const request = http.expectOne(`${BASE}/orders`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      deviceId: 'D1',
      amount: 150.5,
      externalReference: 'sale-key-1',
      idempotencyKey: 'sale-key-1',
    });
    request.flush({ data: { id: 'o1', status: 'created', amount: '150.50' } });

    expect(order?.id).toBe('o1');
  });

  it('reusa la referencia como llave de idempotencia: un retry de red no crea otra orden', () => {
    service.createOrder('D1', 100, 'sale-key-2').subscribe();

    const request = http.expectOne(`${BASE}/orders`);
    expect(request.request.headers.get('Idempotency-Key')).toBe('sale-key-2');
    request.flush({ data: { id: 'o2', status: 'created' } });
  });

  it('consulta y cancela una order por id', () => {
    service.getOrder('o1').subscribe();
    http.expectOne(`${BASE}/orders/o1`).flush({ data: { id: 'o1', status: 'processed' } });

    service.cancelOrder('o1').subscribe();
    const cancel = http.expectOne(`${BASE}/orders/o1`);
    expect(cancel.request.method).toBe('DELETE');
    cancel.flush({ data: { id: 'o1', canceled: true } });
  });
});
