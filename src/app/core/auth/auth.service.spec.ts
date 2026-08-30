import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments/environment';
import { FIREBASE_AUTH } from '../firebase/firebase.providers';
import { NotificationService } from '../notifications/notification.service';
import { AuthService } from './auth.service';

/**
 * Cubre lo que el POS decide por su cuenta: perfil, permisos y mensajes. Las
 * envolturas directas del SDK (`login`, `logout`) no se prueban aquí porque
 * llamarlas ejecutaría el SDK real de Firebase; su comportamiento observable se
 * ejercita en `auth.guard.spec.ts` y `auth.interceptor.spec.ts`, donde el módulo
 * sí está sustituido.
 */
describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigate = vi.fn(() => Promise.resolve(true));

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // `onAuthStateChanged` del SDK real necesita una instancia; sin sesión el
        // servicio nunca la usa más allá de suscribirse.
        { provide: FIREBASE_AUTH, useValue: { currentUser: null, onAuthStateChanged: () => () => undefined } },
        { provide: Router, useValue: { navigate } },
        { provide: NotificationService, useValue: { sessionExpired: vi.fn(), error: vi.fn(), success: vi.fn() } },
      ],
    });

    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('sin sesión no hay perfil, ni rol, ni permisos', () => {
    expect(service.isAuthenticated()).toBe(false);
    expect(service.role()).toBeNull();
    expect(service.roleName()).toBe('');
    expect(service.permissions()).toEqual([]);
    expect(service.can('sales')).toBe(false);
    expect(service.isAdmin()).toBe(false);
    expect(service.canSell()).toBe(false);
  });

  describe('perfil', () => {
    it('resuelve el perfil desde /auth/me', () => {
      let profile: { role: { slug: string } } | null | undefined;
      service.fetchProfile().subscribe((result) => (profile = result));

      const request = http.expectOne(`${environment.apiUrl}/auth/me`);
      expect(request.request.method).toBe('GET');
      request.flush({
        data: {
          uid: 'u1',
          email: 'caja@farmajyv.mx',
          role: { id: 'r1', name: 'Cajero', slug: 'cashier' },
          permissions: [{ area: 'sales', level: 'write' }],
        },
      });

      expect(profile?.role.slug).toBe('cashier');
    });

    it('un /auth/me caído devuelve perfil nulo en vez de romper la sesión', () => {
      let profile: unknown = 'sin resolver';
      service.fetchProfile().subscribe((result) => (profile = result));

      http.expectOne(`${environment.apiUrl}/auth/me`).flush({}, { status: 500, statusText: 'Server Error' });

      expect(profile).toBeNull();
    });

    it('fetchRole devuelve solo el slug', () => {
      let role: string | null | undefined;
      service.fetchRole().subscribe((result) => (role = result));

      http.expectOne(`${environment.apiUrl}/auth/me`).flush({
        data: { role: { id: 'r0', name: 'Admin', slug: 'admin' } },
      });

      expect(role).toBe('admin');
    });

    it('sin rol utilizable el perfil es nulo', () => {
      let role: string | null | undefined = 'sin resolver';
      service.fetchRole().subscribe((result) => (role = result));

      http.expectOne(`${environment.apiUrl}/auth/me`).flush({ data: { uid: 'u1' } });

      expect(role).toBeNull();
    });

    it('dos llamadas simultáneas comparten una sola petición', () => {
      service.fetchProfile().subscribe();
      service.fetchProfile().subscribe();

      http.expectOne(`${environment.apiUrl}/auth/me`).flush({ data: { role: 'cashier' } });
    });
  });

  it('el mensaje de error de login siempre es genérico: no revela si el correo existe', () => {
    expect(service.getLoginErrorMessage({ code: 'auth/user-not-found' })).toBe('auth.login.error');
    expect(service.getLoginErrorMessage({ code: 'auth/wrong-password' })).toBe('auth.login.error');
    expect(service.getLoginErrorMessage({ code: 'auth/too-many-requests' })).toBe('auth.login.error');
    expect(service.getLoginErrorMessage(new Error('otro'))).toBe('auth.login.error');
  });

  it('arranca sin hora de expiración hasta que haya sesión', () => {
    expect(service.sessionExpiresAt()).toBeNull();
  });

  describe('caché del perfil', () => {
    it('resuelve una sola vez y sirve el resto desde memoria', () => {
      let primero: unknown;
      let segundo: unknown;
      service.fetchProfile().subscribe((profile) => (primero = profile));

      http.expectOne(`${environment.apiUrl}/auth/me`).flush({
        data: { uid: 'u1', email: 'caja@farmajyv.mx', role: { slug: 'cashier' }, permissions: [] },
      });

      // Cada navegación llamaba a `permissionGuard`, y cada guard pedía el perfil.
      service.fetchProfile().subscribe((profile) => (segundo = profile));

      http.expectNone(`${environment.apiUrl}/auth/me`);
      expect(segundo).toEqual(primero);
    });

    it('un perfil que no se pudo resolver no se cachea', () => {
      service.fetchProfile().subscribe();
      http.expectOne(`${environment.apiUrl}/auth/me`).flush({}, { status: 500, statusText: 'Error' });

      service.fetchProfile().subscribe();

      http.expectOne(`${environment.apiUrl}/auth/me`).flush({ data: null });
    });

    it('refreshProfile obliga a volver a preguntar', () => {
      service.fetchProfile().subscribe();
      http.expectOne(`${environment.apiUrl}/auth/me`).flush({
        data: { uid: 'u1', role: { slug: 'cashier' }, permissions: [] },
      });

      service.refreshProfile();
      service.fetchProfile().subscribe();

      http.expectOne(`${environment.apiUrl}/auth/me`).flush({ data: null });
    });
  });
});
