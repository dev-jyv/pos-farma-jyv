import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { Category } from '../../../shared/models';
import { CategoryService } from './category.service';

const URL = `${environment.apiUrl}/categories`;

const dto = (overrides: Record<string, unknown> = {}) => ({
  id: 'cat-1',
  name: 'Analgésicos',
  description: 'Dolor y fiebre',
  isActive: true,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
  ...overrides,
});

describe('CategoryService', () => {
  let service: CategoryService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CategoryService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('listado de administración', () => {
    it('omite los filtros vacíos y conserva el meta del servidor', () => {
      let page: { items: Category[]; meta: { total: number } } | undefined;
      service
        .list({ search: '', activeOnly: false, page: 2, limit: 10 })
        .subscribe((result) => (page = result));

      const request = http.expectOne((req) => req.url === URL);
      expect(request.request.params.has('search')).toBe(false);
      // `false` sí viaja: filtrar por inactivas es un filtro legítimo.
      expect(request.request.params.get('activeOnly')).toBe('false');
      expect(request.request.params.get('page')).toBe('2');
      request.flush({ data: [dto()], meta: { page: 2, limit: 10, total: 34, totalPages: 4 } });

      expect(page?.items[0].createdAt).toBeInstanceOf(Date);
      expect(page?.meta.total).toBe(34);
    });

    it('sin meta asume una sola página en vez de dejar la tabla sin paginar', () => {
      let page: { meta: { total: number; totalPages: number } } | undefined;
      service.list().subscribe((result) => (page = result));

      http.expectOne((req) => req.url === URL).flush({ data: [dto(), dto({ id: 'cat-2' })] });

      expect(page?.meta.total).toBe(2);
      expect(page?.meta.totalPages).toBe(1);
    });
  });

  describe('opciones para selectores', () => {
    it('pide solo las activas y las cachea', () => {
      let first: Category[] = [];
      service.options().subscribe((categories) => (first = categories));

      const request = http.expectOne((req) => req.url === URL);
      expect(request.request.params.get('activeOnly')).toBe('true');
      request.flush({ data: [dto()] });

      let second: Category[] = [];
      service.options().subscribe((categories) => (second = categories));

      http.expectNone((req) => req.url === URL);
      expect(second).toEqual(first);
    });

    it('dos llamadas simultáneas comparten una sola petición', () => {
      service.options().subscribe();
      service.options().subscribe();

      http.expectOne((req) => req.url === URL).flush({ data: [dto()] });
    });
  });

  describe('escrituras', () => {
    /** Deja la caché de opciones cargada para comprobar que se invalida. */
    function warmCache(): void {
      service.options().subscribe();
      http.expectOne((req) => req.url === URL).flush({ data: [dto()] });
    }

    it('crear invalida las opciones: la categoría nueva debe verse en la entrada de stock', () => {
      warmCache();

      service.create({ name: 'Antibióticos' }).subscribe();
      http.expectOne((req) => req.method === 'POST').flush({ data: dto({ id: 'cat-2' }) });

      service.options().subscribe();
      // Sin invalidar, el selector seguía mostrando la lista vieja hasta recargar la app.
      http.expectOne((req) => req.method === 'GET' && req.url === URL).flush({ data: [] });
    });

    it('editar también invalida', () => {
      warmCache();

      service.update('cat-1', { name: 'Analgesia' }).subscribe();
      http.expectOne((req) => req.method === 'PATCH').flush({ data: dto({ name: 'Analgesia' }) });

      service.options().subscribe();
      http.expectOne((req) => req.method === 'GET' && req.url === URL).flush({ data: [] });
    });

    it('desactivar es un update con `isActive: false`', () => {
      service.deactivate('cat-1').subscribe();

      const request = http.expectOne(`${URL}/cat-1`);
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ isActive: false });
      request.flush({ data: dto({ isActive: false }) });
    });
  });
});
