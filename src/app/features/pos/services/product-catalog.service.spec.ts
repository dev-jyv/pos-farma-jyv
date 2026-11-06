import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import {
  ProductCatalogService,
  catalogConflictOf,
  productDuplicateOf,
} from './product-catalog.service';

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
    lookup.flush({ data: [{ id: 'remote-9', sku: 'QA-NEW-1', name: 'QA nuevo' }] });
    await done;
    // Ya existía y es el mismo (mismo nombre, sin código): se adopta sin crear un duplicado.
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
    fallback.flush({ data: [{ id: 'remote-7', sku: 'qa-new-1', name: 'QA  Nuevo' }] });
    await done;
    expect(markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-7');
    expect(markCatalogPushFailed).not.toHaveBeenCalled();
  });
});

describe('ProductCatalogService: adoptar solo si es el mismo producto (SPEC 60)', () => {
  let http: HttpTestingController;
  let service: ProductCatalogService;
  let catalog: {
    getPendingCatalogPush: ReturnType<typeof vi.fn>;
    markCatalogSynced: ReturnType<typeof vi.fn>;
    markCatalogPushFailed: ReturnType<typeof vi.fn>;
  };

  const LOCAL = {
    sku: 'PARA-500',
    name: 'Paracetamol',
    concentration: '500 mg',
    barcode: '7501000000011',
    salePrice: 25,
  };

  beforeEach(() => {
    catalog = {
      getPendingCatalogPush: vi.fn().mockResolvedValue([
        { id: 'local-1', remoteId: null, fields: LOCAL, catalogPushError: null },
      ]),
      markCatalogSynced: vi.fn().mockResolvedValue(undefined),
      markCatalogPushFailed: vi.fn().mockResolvedValue(undefined),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = { catalog };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ProductCatalogService);
  });

  afterEach(() => {
    http.verify();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('no adopta un producto con SKU igual y barcode distinto: conflicto visible', async () => {
    const done = service.flushQueueAsync();
    await tick();
    http.expectOne((req) => req.method === 'GET').flush({
      data: [{ id: 'remote-9', sku: 'PARA-500', name: 'Paracetamol infantil', barcode: '7501000000099' }],
    });
    await done;

    http.expectNone((req) => req.method === 'POST');
    expect(catalog.markCatalogSynced).not.toHaveBeenCalled();
    expect(catalog.markCatalogPushFailed).toHaveBeenCalledWith(
      'local-1',
      'Ya existe otro producto con ese SKU: Paracetamol infantil [PRODUCT_DUPLICATE]',
    );
  });

  it('SKU igual y mismo barcode: lo adopta', async () => {
    const done = service.flushQueueAsync();
    await tick();
    http.expectOne((req) => req.method === 'GET').flush({
      data: [{ id: 'remote-9', sku: 'PARA-500', name: 'Paracetamol 500', barcode: '7501000000011' }],
    });
    await done;

    expect(catalog.markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-9');
    expect(catalog.markCatalogPushFailed).not.toHaveBeenCalled();
  });

  it('409 PRODUCT_NAME_TAKEN con existing: lee el producto y adopta si coincide el nameKey', async () => {
    catalog.getPendingCatalogPush.mockResolvedValue([
      { id: 'local-1', remoteId: null, fields: { ...LOCAL, barcode: undefined }, catalogPushError: null },
    ]);
    const done = service.flushQueueAsync();
    await tick();
    http.expectOne((req) => req.method === 'GET').flush({ data: [] });
    await tick();
    http.expectOne((req) => req.method === 'POST').flush(
      {
        error: {
          code: 'CONFLICT',
          message: 'Ya existe un producto con ese nombre',
          details: {
            code: 'PRODUCT_NAME_TAKEN',
            existing: { id: 'remote-3', name: 'paracetamol 500MG', sku: 'OTRO-SKU', barcode: null },
          },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await tick();
    http
      .expectOne(`${environment.apiUrl}/products/remote-3`)
      .flush({ data: { id: 'remote-3', sku: 'OTRO-SKU', name: 'paracetamol 500MG', concentration: null } });
    await done;

    expect(catalog.markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-3');
  });

  it('409 PRODUCT_SKU_TAKEN de otro producto: queda en conflicto con su nombre', async () => {
    const done = service.flushQueueAsync();
    await tick();
    http.expectOne((req) => req.method === 'GET').flush({ data: [] });
    await tick();
    http.expectOne((req) => req.method === 'POST').flush(
      {
        error: {
          code: 'CONFLICT',
          message: 'Ya existe un producto con ese SKU',
          details: {
            code: 'PRODUCT_SKU_TAKEN',
            existing: { id: 'remote-4', name: 'Ibuprofeno 400', sku: 'PARA-500', barcode: '7501000000044' },
          },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await tick();
    http.expectOne(`${environment.apiUrl}/products/remote-4`).flush({
      data: { id: 'remote-4', sku: 'PARA-500', name: 'Ibuprofeno 400', barcode: '7501000000044' },
    });
    await done;

    expect(catalog.markCatalogSynced).not.toHaveBeenCalled();
    expect(catalog.markCatalogPushFailed).toHaveBeenCalledWith(
      'local-1',
      'Ya existe otro producto con ese SKU: Ibuprofeno 400 [PRODUCT_SKU_TAKEN]',
    );
  });

  it('backend viejo, 409 por nombre sin SKU coincidente: se marca con el mensaje del servidor', async () => {
    const done = service.flushQueueAsync();
    await tick();
    http.expectOne((req) => req.method === 'GET').flush({ data: [] });
    await tick();
    http
      .expectOne((req) => req.method === 'POST')
      .flush({ error: { message: 'Ya existe un producto con ese nombre' } }, { status: 409, statusText: 'Conflict' });
    await tick();
    http.expectOne((req) => req.method === 'GET' && req.params.get('search') === 'PARA-500').flush({ data: [] });
    await done;

    expect(catalog.markCatalogSynced).not.toHaveBeenCalled();
    expect(catalog.markCatalogPushFailed).toHaveBeenCalledWith('local-1', 'Ya existe un producto con ese nombre');
  });
});

describe('productDuplicateOf', () => {
  it('reconoce los 409 de duplicado con sus datos del existente', () => {
    const error = new HttpErrorResponse({
      status: 409,
      error: {
        error: {
          details: { code: 'PRODUCT_DUPLICATE', existing: { id: 'r1', name: 'X', sku: 'S', barcode: '1' } },
        },
      },
    });
    expect(productDuplicateOf(error)).toEqual({
      code: 'PRODUCT_DUPLICATE',
      existing: { id: 'r1', name: 'X', sku: 'S', barcode: '1' },
    });
    expect(productDuplicateOf(new HttpErrorResponse({ status: 409, error: {} }))).toBeNull();
    expect(
      productDuplicateOf(new HttpErrorResponse({ status: 400, error: error.error })),
    ).toBeNull();
  });
});

describe('ProductCatalogService.flushQueueAsync (edición por diferencias, SPEC 56)', () => {
  let http: HttpTestingController;
  let service: ProductCatalogService;
  let catalog: {
    getPendingCatalogPush: ReturnType<typeof vi.fn>;
    markCatalogSynced: ReturnType<typeof vi.fn>;
    markCatalogPushFailed: ReturnType<typeof vi.fn>;
    markCatalogConflict: ReturnType<typeof vi.fn>;
    resolveCatalogConflict: ReturnType<typeof vi.fn>;
  };

  const SNAPSHOT = { ...FIELDS, concentration: '650 mg', isActive: true };
  const PRODUCT_URL = `${environment.apiUrl}/products/remote-1`;

  function pendiente(overrides: Record<string, unknown> = {}) {
    return {
      id: 'local-1',
      remoteId: 'remote-1',
      fields: SNAPSHOT,
      changes: { concentration: '650 mg' },
      baseUpdatedAt: '2026-11-06T10:00:00.000Z',
      snapshot: SNAPSHOT,
      catalogPushError: null,
      version: '2026-11-06T11:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    catalog = {
      getPendingCatalogPush: vi.fn().mockResolvedValue([pendiente()]),
      markCatalogSynced: vi.fn().mockResolvedValue(undefined),
      markCatalogPushFailed: vi.fn().mockResolvedValue(undefined),
      markCatalogConflict: vi.fn().mockResolvedValue(undefined),
      resolveCatalogConflict: vi.fn().mockResolvedValue(true),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = { catalog };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ProductCatalogService);
  });

  afterEach(() => {
    http.verify();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('el PATCH lleva solo los campos editados y baseUpdatedAt', async () => {
    const done = service.flushQueueAsync();
    await tick();
    const patch = http.expectOne((req) => req.url === PRODUCT_URL && req.method === 'PATCH');
    expect(patch.request.body).toEqual({
      concentration: '650 mg',
      baseUpdatedAt: '2026-11-06T10:00:00.000Z',
    });
    patch.flush({ data: { id: 'remote-1', sku: 'QA-NEW-1', updatedAt: '2026-11-06T12:00:00.000Z' } });
    await done;

    // La foto nueva: lo subido y el updatedAt que respondió el servidor.
    expect(catalog.markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-1', '2026-11-06T11:00:00.000Z', {
      fields: SNAPSHOT,
      remoteUpdatedAt: '2026-11-06T12:00:00.000Z',
    });
  });

  it('sin cambios respecto a la foto no pide nada al servidor', async () => {
    catalog.getPendingCatalogPush.mockResolvedValue([pendiente({ changes: {} })]);
    await service.flushQueueAsync();

    http.expectNone((req) => req.method === 'PATCH');
    expect(catalog.markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-1', '2026-11-06T11:00:00.000Z', {
      fields: SNAPSHOT,
      remoteUpdatedAt: null,
    });
  });

  it('"Forzar el mío" (sin baseUpdatedAt): sube lo cambiado sin precondición', async () => {
    catalog.getPendingCatalogPush.mockResolvedValue([
      pendiente({ changes: { salePrice: 65 }, baseUpdatedAt: null }),
    ]);
    const done = service.flushQueueAsync();
    await tick();
    const patch = http.expectOne((req) => req.method === 'PATCH');
    expect(patch.request.body).toEqual({ salePrice: 65 });
    patch.flush({ data: { id: 'remote-1' } });
    await done;
  });

  it('producto sin foto (de antes de la migración): sube completo, como siempre', async () => {
    catalog.getPendingCatalogPush.mockResolvedValue([
      pendiente({ changes: null, baseUpdatedAt: null, snapshot: undefined }),
    ]);
    const done = service.flushQueueAsync();
    await tick();
    const patch = http.expectOne((req) => req.method === 'PATCH');
    expect(patch.request.body).toEqual(SNAPSHOT);
    patch.flush({ data: { id: 'remote-1' } });
    await done;
    expect(catalog.markCatalogSynced).toHaveBeenCalledWith('local-1', 'remote-1', '2026-11-06T11:00:00.000Z');
  });

  it('409 CATALOG_CONFLICT: queda en conflicto visible con el valor del panel', async () => {
    const done = service.flushQueueAsync();
    await tick();
    http.expectOne((req) => req.method === 'PATCH').flush(
      {
        error: {
          code: 'CONFLICT',
          message: 'El precio cambió en el panel',
          details: { code: 'CATALOG_CONFLICT', current: { salePrice: 58, isActive: true } },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await done;

    expect(catalog.markCatalogConflict).toHaveBeenCalledWith('local-1', { salePrice: 58, isActive: true });
    expect(catalog.markCatalogPushFailed).not.toHaveBeenCalled();
    expect(catalog.markCatalogSynced).not.toHaveBeenCalled();
  });

  it('otro 409 sigue siendo un rechazo normal', async () => {
    const done = service.flushQueueAsync();
    await tick();
    http
      .expectOne((req) => req.method === 'PATCH')
      .flush({ error: { code: 'CONFLICT', message: 'Ya existe un producto con ese SKU' } }, { status: 409, statusText: 'Conflict' });
    await done;

    expect(catalog.markCatalogConflict).not.toHaveBeenCalled();
    expect(catalog.markCatalogPushFailed).toHaveBeenCalled();
  });

  it('resolver el conflicto pasa la elección al proceso main', async () => {
    await expect(service.resolveConflict('local-1', 'panel')).resolves.toBe(true);
    expect(catalog.resolveCatalogConflict).toHaveBeenCalledWith('local-1', 'panel');
  });
});

describe('catalogConflictOf', () => {
  it('solo reconoce el 409 con details.code CATALOG_CONFLICT', () => {
    const conflicto = new HttpErrorResponse({
      status: 409,
      error: { error: { details: { code: 'CATALOG_CONFLICT', current: { salePrice: 10, isActive: false } } } },
    });
    expect(catalogConflictOf(conflicto)).toEqual({ salePrice: 10, isActive: false });
    expect(catalogConflictOf(new HttpErrorResponse({ status: 409, error: {} }))).toBeNull();
    expect(catalogConflictOf(new HttpErrorResponse({ status: 400, error: conflicto.error }))).toBeNull();
  });
});
