import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FIREBASE_AUTH } from '../firebase/firebase.providers';
import { NotificationService } from '../notifications/notification.service';
import { StaffProfile } from '../../shared/models';
import { AuthService } from './auth.service';
import { authGuard, guestGuard, permissionGuard } from './auth.guard';

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

/** El doble de `Router.createUrlTree`: compara el destino, no la instancia. */
const urlTreeFor = (path: string) => ({ path }) as unknown as UrlTree;

/** Perfil de cajero de mostrador: vende, lee catálogo e inventario. */
function profile(overrides: Partial<StaffProfile> = {}): StaffProfile {
  return {
    uid: 'u1',
    email: 'caja@farmajyv.mx',
    displayName: 'Cajero',
    role: { id: 'r1', name: 'Cajero', slug: 'cashier' },
    permissions: [
      { area: 'pos', level: 'write' },
      { area: 'sales', level: 'read' },
      { area: 'products', level: 'read' },
      { area: 'inventory', level: 'read' },
    ],
    ...overrides,
  };
}

/** Ejecuta el guard en contexto de inyección y resuelve su Observable. */
function runGuard(guard: typeof authGuard): Promise<boolean | UrlTree> {
  const result = TestBed.runInInjectionContext(
    () => guard({} as never, {} as never) as Observable<boolean | UrlTree>,
  );
  return new Promise((resolve) => result.subscribe(resolve));
}

describe('auth guards', () => {
  let currentUser: object | null;
  let fetchRole: () => Observable<string | null>;
  let fetchProfile: () => Observable<StaffProfile | null>;
  let notifyError: ReturnType<typeof vi.fn>;
  const urlTree = urlTreeFor;

  beforeEach(() => {
    signOutMock.mockClear();
    currentUser = null;
    fetchRole = () => of('cashier');
    fetchProfile = () => of(profile());
    notifyError = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        {
          provide: FIREBASE_AUTH,
          useValue: {
            authStateReady: () => Promise.resolve(),
            get currentUser() {
              return currentUser;
            },
          },
        },
        { provide: Router, useValue: { createUrlTree: (commands: string[]) => urlTree(commands[0]) } },
        {
          provide: AuthService,
          useValue: { fetchRole: () => fetchRole(), fetchProfile: () => fetchProfile() },
        },
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
      ],
    });
  });

  describe('authGuard', () => {
    it('deja pasar con sesión iniciada', async () => {
      currentUser = { uid: 'u1' };
      await expect(runGuard(authGuard)).resolves.toBe(true);
    });

    it('sin sesión redirige a /login', async () => {
      await expect(runGuard(authGuard)).resolves.toEqual(urlTree('/login'));
    });
  });

  describe('guestGuard', () => {
    it('sin sesión deja ver el login', async () => {
      await expect(runGuard(guestGuard)).resolves.toBe(true);
    });

    it('con sesión y rol válido manda al POS', async () => {
      currentUser = { uid: 'u1' };
      await expect(runGuard(guestGuard)).resolves.toEqual(urlTree('/pos'));
    });

    it('con sesión pero sin rol cierra sesión y deja el login: esa sesión no sirve', async () => {
      currentUser = { uid: 'u1' };
      fetchRole = () => of(null);

      await expect(runGuard(guestGuard)).resolves.toBe(true);
      expect(signOutMock).toHaveBeenCalled();
    });

    it('si /auth/me falla también cierra sesión en vez de dejar al usuario atorado', async () => {
      currentUser = { uid: 'u1' };
      fetchRole = () => throwError(() => new Error('500'));

      await expect(runGuard(guestGuard)).resolves.toBe(true);
      expect(signOutMock).toHaveBeenCalled();
    });
  });

  describe('permissionGuard', () => {
  it('deja pasar cuando el rol tiene el permiso exacto', async () => {
    await expect(runGuard(permissionGuard('sales', 'read'))).resolves.toBe(true);
  });

  it('la escritura no se concede con solo lectura', async () => {
    // El cajero lee ventas (historial) pero no las administra: anular es `sales:write`.
    await expect(runGuard(permissionGuard('sales', 'write'))).resolves.toEqual(urlTreeFor('/pos'));
  });

  it('el cajero no entra al libro de control ni escribiendo la URL', async () => {
    // `inventory:read` lo necesita para lotes y caducidad al vender; el libro pide `write`.
    await expect(runGuard(permissionGuard('inventory', 'write'))).resolves.toEqual(
      urlTreeFor('/pos'),
    );
    expect(notifyError).toHaveBeenCalled();
  });

  it('el cajero tampoco entra a reportes', async () => {
    await expect(runGuard(permissionGuard('dashboard', 'read'))).resolves.toEqual(
      urlTreeFor('/pos'),
    );
  });

  it('admin pasa por el atajo de rol, sin permisos declarados', async () => {
    fetchProfile = () =>
      of(profile({ role: { id: 'r0', name: 'Admin', slug: 'admin' }, permissions: [] }));

    await expect(runGuard(permissionGuard('inventory', 'write'))).resolves.toBe(true);
  });

  it('sin perfil resuelto manda a la pantalla de venta en vez de dejar la ruta abierta', async () => {
    fetchProfile = () => of(null);
    await expect(runGuard(permissionGuard('sales', 'read'))).resolves.toEqual(urlTreeFor('/pos'));
  });

  it('si el perfil falla no abre la pantalla', async () => {
    fetchProfile = () => throwError(() => new Error('500'));
    await expect(runGuard(permissionGuard('sales', 'read'))).resolves.toEqual(urlTreeFor('/pos'));
  });
});
});
