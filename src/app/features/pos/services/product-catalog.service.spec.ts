import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import { ProductCatalogService } from './product-catalog.service';

const FIELDS = { sku: 'QA-NEW-1', name: 'QA nuevo', salePrice: 10 };

describe('ProductCatalogService.flushQueueAsync (alta nueva)', () => {
  let http: HttpTestingController;
  let service: ProductCatalogService;
  let markCatalogSynced: ReturnType<typeof vi.fn>;
  let markCatalogPushFailed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    markCatalogSynced = vi.fn().mockResolvedValue(undefined);
    markCatalogPushFailed = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      catalog: {
        getPendingCatalogPush: vi.fn().mockResolvedValue([
          { id: 'local-1', remoteId: null, fields: FIELDS, catalogPushError: null },
        ]),
        markCatalogSynced,
        markCatalogPushFailed,
      },
    };
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ProductCatalogService);
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('comprueba el SKU con `sku` exacto (1 lectura), nunca con `search` (recorre la colección)', async () => {
    const done = service.flushQueueAsync();
    await tick();
    const lookup = http.expectOne((req) => req.url === `${environment.apiUrl}/products` && req.method === 'GET');
    expect(lookup.request.params.get('sku')).toBe('QA-NEW-1');
    expect(lookup.request.params.has('search')).toBe(false);
    expect(lookup.request.params.get('limit')).toBe('1');
    lookup.flush({ data: [{ id: 'remote-9', sku: 'QA-NEW-1' }] });
    await done;
    // Ya existía: se adopta sin crear un duplicado.
    http.expectNone(`${environment.apiUrl}/products`);
    expect(markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-9');
  });

  it('si no existe lo crea con POST', async () => {
    const done = service.flushQueueAsync();
    await tick();
    http.expectOne((req) => req.method === 'GET').flush({ data: [] });
    await tick();
    http.expectOne((req) => req.method === 'POST').flush({ data: { id: 'remote-1', sku: 'QA-NEW-1' } });
    await done;
    expect(markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-1');
  });

  it('ante 409 (backend viejo que ignora `sku`) adopta el existente con la búsqueda amplia', async () => {
    const done = service.flushQueueAsync();
    await tick();
    http.expectOne((req) => req.method === 'GET').flush({ data: [] });
    await tick();
    http
      .expectOne((req) => req.method === 'POST')
      .flush({ message: 'Ya existe un producto con ese SKU' }, { status: 409, statusText: 'Conflict' });
    await tick();
    const fallback = http.expectOne((req) => req.method === 'GET');
    expect(fallback.request.params.get('search')).toBe('QA-NEW-1');
    fallback.flush({ data: [{ id: 'remote-7', sku: 'qa-new-1' }] });
    await done;
    expect(markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-7');
    expect(markCatalogPushFailed).not.toHaveBeenCalled();
  });
});
