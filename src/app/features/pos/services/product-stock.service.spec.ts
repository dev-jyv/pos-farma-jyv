import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import {
  ProductStockService,
  STOCK_REFRESH_DEBOUNCE_MS,
  STOCK_REFRESH_TIMEOUT_MS,
} from './product-stock.service';

const STOCK_URL = `${environment.apiUrl}/products/RmtP1/stock`;

const SNAPSHOT = {
  id: 'RmtP1',
  totalStock: 5,
  updatedAt: '2026-11-06T18:00:00.000Z',
  batches: [{ id: 'b-1', lotNumber: 'L1', expiryDate: '2027-01-31T00:00:00.000Z', quantity: 5 }],
};

describe('ProductStockService (SPEC 57)', () => {
  let http: HttpTestingController;
  let service: ProductStockService;
  let refreshOne: ReturnType<typeof vi.fn>;
  let onLine: boolean;

  beforeEach(() => {
    onLine = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
    refreshOne = vi.fn().mockResolvedValue({
      product: { id: 'p1', remoteId: 'RmtP1', stock: 5 },
      batches: [],
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = { products: { refreshOne } };
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ProductStockService);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('con red consulta solo ese producto y guarda la respuesta en SQLite', async () => {
    const pending = service.refresh({ remoteId: 'RmtP1' });
    expect(pending).not.toBeNull();
    http.expectOne(STOCK_URL).flush({ data: SNAPSHOT });

    const result = await pending;
    expect(refreshOne).toHaveBeenCalledWith('RmtP1', SNAPSHOT);
    expect(result?.product.stock).toBe(5);
  });

  it('sin red no hace llamada HTTP: niega en el acto', () => {
    onLine = false;

    expect(service.refresh({ remoteId: 'RmtP1' })).toBeNull();
    http.expectNone(STOCK_URL);
    expect(refreshOne).not.toHaveBeenCalled();
  });

  it('un producto creado en la caja (sin remoteId) no se consulta', () => {
    expect(service.refresh({ remoteId: null })).toBeNull();
    http.expectNone(() => true);
  });

  it('antirrebote: una consulta por producto cada 30 s', async () => {
    const t0 = 1_000_000;
    const first = service.refresh({ remoteId: 'RmtP1' }, t0);
    http.expectOne(STOCK_URL).flush({ data: SNAPSHOT });
    await first;

    expect(service.refresh({ remoteId: 'RmtP1' }, t0 + STOCK_REFRESH_DEBOUNCE_MS - 1)).toBeNull();
    http.expectNone(STOCK_URL);
    // Otro producto no espera al primero.
    const other = service.refresh({ remoteId: 'RmtP2' }, t0 + 1);
    http.expectOne(`${environment.apiUrl}/products/RmtP2/stock`).flush({ data: { ...SNAPSHOT, id: 'RmtP2' } });
    await other;

    const again = service.refresh({ remoteId: 'RmtP1' }, t0 + STOCK_REFRESH_DEBOUNCE_MS);
    expect(again).not.toBeNull();
    http.expectOne(STOCK_URL).flush({ data: SNAPSHOT });
    await again;
  });

  it('un error del servidor deja la negativa (resuelve null) sin tocar SQLite', async () => {
    const pending = service.refresh({ remoteId: 'RmtP1' });
    http.expectOne(STOCK_URL).flush({ error: { message: 'Producto no encontrado' } }, { status: 404, statusText: 'Not Found' });

    expect(await pending).toBeNull();
    expect(refreshOne).not.toHaveBeenCalled();
  });

  it('sin respuesta en 3 s se rinde', async () => {
    vi.useFakeTimers();
    const pending = service.refresh({ remoteId: 'RmtP1' });
    const request = http.expectOne(STOCK_URL);

    await vi.advanceTimersByTimeAsync(STOCK_REFRESH_TIMEOUT_MS + 1);

    expect(await pending).toBeNull();
    expect(request.cancelled).toBe(true);
    expect(refreshOne).not.toHaveBeenCalled();
  });
});
