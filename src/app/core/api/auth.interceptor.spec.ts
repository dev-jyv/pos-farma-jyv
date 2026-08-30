import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments/environment';
import { FIREBASE_AUTH } from '../firebase/firebase.providers';
import { NotificationService } from '../notifications/notification.service';
import { authInterceptor } from './auth.interceptor';

const signOutMock = vi.fn(() => Promise.resolve());

/**
 * `signOut` se importa del módulo, no se inyecta, así que la única forma de
 * observarlo es sustituir el módulo. Requiere `isolate: true` en `angular.json`:
 * sin aislamiento este mock se filtraba a las pruebas de `AuthService`, que sí
 * usan el `firebase/auth` real.
 */
vi.mock('firebase/auth', () => ({
  signOut: (...args: unknown[]) => signOutMock(...(args as [])),
}));

describe('authInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;
  let sessionExpired: ReturnType<typeof vi.fn>;
  let currentUser: { getIdToken: () => Promise<string> } | null;

  beforeEach(() => {
    signOutMock.mockClear();
    navigate = vi.fn(() => Promise.resolve(true));
    sessionExpired = vi.fn();
    currentUser = { getIdToken: () => Promise.resolve('token-123') };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        {
          provide: FIREBASE_AUTH,
          useValue: {
            authStateReady: () => Promise.resolve(),
            get currentUser() {
              return currentUser;
            },
          },
        },
        { provide: Router, useValue: { navigate } },
        { provide: NotificationService, useValue: { sessionExpired, error: vi.fn(), success: vi.fn() } },
      ],
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('no toca las peticiones fuera de la API', async () => {
    http.get('https://otro-dominio.mx/data').subscribe();
    await Promise.resolve();

    const request = httpMock.expectOne('https://otro-dominio.mx/data');
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({});
  });

  it('deja pasar /health sin token: es el sondeo que corre sin sesión', async () => {
    http.get(`${environment.apiUrl}/health`).subscribe();
    await Promise.resolve();

    const request = httpMock.expectOne(`${environment.apiUrl}/health`);
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({});
  });

  it('adjunta el id token a las peticiones a la API', async () => {
    http.get(`${environment.apiUrl}/sales`).subscribe();
    await flushMicrotasks();

    const request = httpMock.expectOne(`${environment.apiUrl}/sales`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer token-123');
    request.flush({ data: [] });
  });

  it('sin usuario la petición viaja sin token', async () => {
    currentUser = null;
    http.get(`${environment.apiUrl}/sales`).subscribe();
    await flushMicrotasks();

    const request = httpMock.expectOne(`${environment.apiUrl}/sales`);
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({ data: [] });
  });

  it('un 401 cierra sesión, avisa el motivo del backend y manda a /login', async () => {
    let failed: unknown;
    http.get(`${environment.apiUrl}/sales`).subscribe({ error: (error) => (failed = error) });
    await flushMicrotasks();

    httpMock.expectOne(`${environment.apiUrl}/sales`).flush(
      { error: { message: 'La sesión terminó a las 24:00' } },
      { status: 401, statusText: 'Unauthorized' },
    );
    await flushMicrotasks();

    expect(sessionExpired).toHaveBeenCalledWith('La sesión terminó a las 24:00');
    expect(signOutMock).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login']);
    expect(failed).toBeTruthy();
  });

  it('un 401 en /auth/me no cierra sesión: es la llamada que resuelve el rol', async () => {
    http.get(`${environment.apiUrl}/auth/me`).subscribe({ error: () => undefined });
    await flushMicrotasks();

    httpMock.expectOne(`${environment.apiUrl}/auth/me`).flush({}, { status: 401, statusText: 'Unauthorized' });
    await flushMicrotasks();

    expect(signOutMock).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('otros errores se propagan sin cerrar sesión', async () => {
    let failed: unknown;
    http.get(`${environment.apiUrl}/sales`).subscribe({ error: (error) => (failed = error) });
    await flushMicrotasks();

    httpMock.expectOne(`${environment.apiUrl}/sales`).flush({}, { status: 500, statusText: 'Server Error' });
    await flushMicrotasks();

    expect(failed).toBeTruthy();
    expect(signOutMock).not.toHaveBeenCalled();
  });
});

/** El interceptor encadena varias promesas (`authStateReady`, `getIdToken`). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}
