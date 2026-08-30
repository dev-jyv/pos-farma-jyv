import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { ProductService } from './product.service';

describe('ProductService', () => {
  let service: ProductService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ProductService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('acota el tamaño de la respuesta con `limit`', () => {
    service.search('paracetamol').subscribe();

    const request = http.expectOne((req) => req.url === `${environment.apiUrl}/products`);
    expect(request.request.params.get('limit')).toBe('25');
    request.flush({ products: [] });
  });

  describe('término vacío', () => {
    it('no sale a la red: sin `search` el backend lee el catálogo completo', () => {
      let result: unknown;
      service.search('   ').subscribe((products) => (result = products));

      http.expectNone((req) => req.url === `${environment.apiUrl}/products`);
      expect(result).toEqual([]);
    });
  });

  describe('caché', () => {
    it('el mismo término no se vuelve a pedir', () => {
      service.search('paracetamol').subscribe();
      http.expectOne((req) => req.url === `${environment.apiUrl}/products`).flush({
        products: [{ id: 'p1', stock: 3 }],
      });

      let result: Array<{ id: string }> = [];
      service.search('Paracetamol').subscribe((products) => (result = products));

      // Se normaliza a minúsculas y sin espacios: es la misma búsqueda.
      http.expectNone((req) => req.url === `${environment.apiUrl}/products`);
      expect(result.map((product) => product.id)).toEqual(['p1']);
    });

    it('dos búsquedas simultáneas comparten una sola petición', () => {
      let primera: unknown;
      let segunda: unknown;
      service.search('ibuprofeno').subscribe((products) => (primera = products));
      service.search('ibuprofeno').subscribe((products) => (segunda = products));

      http.expectOne((req) => req.url === `${environment.apiUrl}/products`).flush({
        products: [{ id: 'p9', stock: 1 }],
      });

      expect(primera).toEqual(segunda);
    });

    it('invalidate obliga a volver al servidor: el stock cambió al cobrar', () => {
      service.search('paracetamol').subscribe();
      http.expectOne((req) => req.url === `${environment.apiUrl}/products`).flush({
        products: [{ id: 'p1', stock: 3 }],
      });

      service.invalidate();
      service.search('paracetamol').subscribe();

      http.expectOne((req) => req.url === `${environment.apiUrl}/products`).flush({ products: [] });
    });
  });

  it('busca por término contra /products', () => {
    let result: unknown;
    service.search('paracetamol').subscribe((products) => (result = products));

    const request = http.expectOne(
      (req) => req.url === `${environment.apiUrl}/products` && req.params.get('search') === 'paracetamol',
    );
    expect(request.request.method).toBe('GET');
    request.flush({ products: [{ id: 'p1', name: 'Paracetamol', stock: 3 }] });

    expect(result).toEqual([{ id: 'p1', name: 'Paracetamol', stock: 3 }]);
  });

  it('lee la lista bajo la llave `products` antes que `data`', () => {
    let result: Array<{ id: string }> = [];
    service.search('x').subscribe((products) => (result = products));

    http.expectOne((req) => req.url.endsWith('/products')).flush({
      products: [{ id: 'correcto', stock: 1 }],
      data: [{ id: 'incorrecto', stock: 1 }],
    });

    expect(result.map((product) => product.id)).toEqual(['correcto']);
  });

  it('recorta el stock negativo: un stock en rojo no puede venderse ni mostrarse', () => {
    let result: Array<{ stock: number }> = [];
    service.search('x').subscribe((products) => (result = products));

    http.expectOne((req) => req.url.endsWith('/products')).flush({
      products: [{ id: 'p1', stock: -5 }, { id: 'p2' }],
    });

    expect(result.map((product) => product.stock)).toEqual([0, 0]);
  });
});
