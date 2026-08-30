import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { CustomerService } from './customer.service';

describe('CustomerService', () => {
  let service: CustomerService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CustomerService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('manda el término recortado y limita a 20 resultados', () => {
    service.search('  ana  ').subscribe();

    const request = http.expectOne((req) => req.url === `${environment.apiUrl}/customers`);
    expect(request.request.params.get('search')).toBe('ana');
    expect(request.request.params.get('limit')).toBe('20');
    request.flush({ data: [] });
  });

  it('con el término vacío no sale a la red: listar sin filtro lee toda la colección', () => {
    let result: unknown;
    service.search('   ').subscribe((customers) => (result = customers));

    http.expectNone((req) => req.url === `${environment.apiUrl}/customers`);
    expect(result).toEqual([]);
  });

  it('desenvuelve la lista de clientes', () => {
    let result: Array<{ id: string }> = [];
    service.search('ana').subscribe((customers) => (result = customers));

    http.expectOne((req) => req.url.endsWith('/customers')).flush({ data: [{ id: 'c1' }] });

    expect(result).toEqual([{ id: 'c1' }]);
  });

  it('crea el cliente y devuelve la entidad desenvuelta', () => {
    let created: { id: string } | undefined;
    service.create({ name: 'Ana', rfc: 'XAXX010101000' }).subscribe((customer) => (created = customer));

    const request = http.expectOne(`${environment.apiUrl}/customers`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Ana', rfc: 'XAXX010101000' });
    request.flush({ data: { id: 'c9', name: 'Ana' } });

    expect(created?.id).toBe('c9');
  });
});
