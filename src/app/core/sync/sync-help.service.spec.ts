import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { BlockedSyncRecord } from '../electron/window.d';
import { environment } from '../../../environments/environment';
import { SyncHelpService } from './sync-help.service';

describe('SyncHelpService', () => {
  let service: SyncHelpService;
  let http: HttpTestingController;
  const url = `${environment.apiUrl}/assistant/sync-help`;

  const registro: BlockedSyncRecord = {
    kind: 'sale',
    id: 'v-1',
    label: 'PENDIENTE-1',
    detail: '$292.00',
    occurredAt: new Date(),
    reason: 'x'.repeat(800),
    diagnosis: { code: 'desconocido' },
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(SyncHelpService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('manda solo el resumen, con el motivo recortado al tope del backend', async () => {
    const respuesta = service.ask(registro);

    const req = http.expectOne(url);
    expect(req.request.method).toBe('POST');
    expect(Object.keys(req.request.body).sort()).toEqual(['appVersion', 'code', 'kind', 'reason']);
    expect(req.request.body.reason).toHaveLength(500);
    req.flush({ data: { explicacion: 'Reintenta.', pasos: ['reintentar'], avisarAdmin: false } });

    await expect(respuesta).resolves.toEqual({
      explicacion: 'Reintenta.',
      pasos: ['reintentar'],
      avisarAdmin: false,
    });
  });

  it('un 429 se traduce a un mensaje para el cajero', async () => {
    const respuesta = service.ask(registro);

    http.expectOne(url).flush({}, { status: 429, statusText: 'Too Many Requests' });

    await expect(respuesta).rejects.toThrow('Espera un minuto');
  });

  it('un 503 (IA sin configurar) manda con el administrador', async () => {
    const respuesta = service.ask(registro);

    http.expectOne(url).flush({}, { status: 503, statusText: 'Unavailable' });

    await expect(respuesta).rejects.toThrow('Avisa al administrador');
  });
});
