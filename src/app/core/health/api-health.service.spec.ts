import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../environments/environment';
import { ApiHealthService } from './api-health.service';

const HEALTH_URL = `${environment.apiUrl}/health`;

describe('ApiHealthService', () => {
  let service: ApiHealthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ApiHealthService);
    http = TestBed.inject(HttpTestingController);
    // Sondeo del constructor.
    http.expectOne(HEALTH_URL).flush({ status: 'ok' });
  });

  afterEach(() => http.verify());

  it('arranca sin banda de degradado cuando hay red y la API responde', () => {
    expect(service.apiOk()).toBe(true);
    expect(service.degraded()).toBe(false);
  });

  it('marca degradado cuando la API no responde, aunque el navegador tenga red', () => {
    service.checkNow();
    http.expectOne(HEALTH_URL).error(new ProgressEvent('error'), { status: 0, statusText: '' });

    expect(service.apiOk()).toBe(false);
    expect(service.degraded()).toBe(true);
  });

  it('perder la red marca degradado sin necesidad de sondear', () => {
    service.browserOnline.set(false);
    expect(service.degraded()).toBe(true);
  });

  it('recuperar la API quita el degradado', () => {
    service.checkNow();
    http.expectOne(HEALTH_URL).flush({}, { status: 503, statusText: 'Unavailable' });
    expect(service.degraded()).toBe(true);

    service.checkNow();
    http.expectOne(HEALTH_URL).flush({ status: 'ok' });
    expect(service.degraded()).toBe(false);
  });
});
