import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { BatchService } from './batch.service';

describe('BatchService', () => {
  let service: BatchService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(BatchService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('consulta los lotes del producto', () => {
    service.listByProduct('p1').subscribe();

    const request = http.expectOne(
      (req) => req.url === `${environment.apiUrl}/inventory/batches` && req.params.get('productId') === 'p1',
    );
    expect(request.request.method).toBe('GET');
    request.flush({ data: [] });
  });

  it('normaliza la caducidad a Date sin importar la forma que mande el backend', () => {
    let batches: Array<{ expiryDate: Date; lotNumber: string }> = [];
    service.listByProduct('p1').subscribe((result) => (batches = result));

    http.expectOne((req) => req.url.endsWith('/inventory/batches')).flush({
      data: [
        { id: 'b1', productId: 'p1', lotNumber: 'L1', expiryDate: '2027-01-31T00:00:00.000Z', quantity: 4 },
        { id: 'b2', productId: 'p1', lotNumber: 'L2', expiryDate: { _seconds: 1_800_000_000 }, quantity: 2 },
      ],
    });

    expect(batches).toHaveLength(2);
    expect(batches[0].expiryDate.toISOString()).toBe('2027-01-31T00:00:00.000Z');
    expect(batches[1].expiryDate.getTime()).toBe(1_800_000_000_000);
  });
});
