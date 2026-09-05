import { Route } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { NAV_ITEMS } from '../../core/layout/nav.config';
import { POS_ROUTES } from './pos.routes';

/**
 * Seguridad de navegación: el nav decide qué se **ofrece**, el guard decide
 * qué se **abre**. Si divergen, la caja o esconde algo que el rol sí puede
 * usar, o —lo grave— ofrece un camino que termina en 403 con dinero de por
 * medio. Estas pruebas atan las dos listas.
 */
function routeFor(path: string): Route {
  const route = POS_ROUTES.find((item) => item.path === path);
  expect(route, `no existe la ruta "${path}"`).toBeDefined();
  return route!;
}

function guardCount(route: Route): number {
  return route.canActivate?.length ?? 0;
}

describe('POS_ROUTES — resguardo de las pantallas', () => {
  it('toda ruta declarada, salvo la venta, lleva guard de permiso', () => {
    const sinGuard = POS_ROUTES.filter((route) => route.path !== '' && guardCount(route) === 0).map(
      (route) => route.path,
    );
    // `''` (venta) queda sin guard a propósito: es el destino de rebote del
    // propio guard y cerrarla crearía un ciclo de redirección.
    expect(sinGuard).toEqual([]);
  });

  it('toda ruta del nav existe realmente en el enrutador', () => {
    const rutasNav = NAV_ITEMS.map((item) => item.path.replace(/^\/pos\/?/, ''));
    const rutasDeclaradas = POS_ROUTES.map((route) => route.path);
    rutasNav.forEach((path) => expect(rutasDeclaradas).toContain(path));
  });

  it('toda ruta con guard aparece en el nav con un permiso declarado', () => {
    // Una pantalla resguardada que no declara permiso en el nav se le
    // ofrecería a cualquier sesión y rebotaría en el guard.
    const conGuard = POS_ROUTES.filter((route) => guardCount(route) > 0).map((route) => `/pos/${route.path}`);
    const navConPermiso = NAV_ITEMS.filter((item) => item.permission).map((item) => item.path);

    conGuard
      .filter((path) => NAV_ITEMS.some((item) => item.path === path))
      .forEach((path) => expect(navConPermiso).toContain(path));
  });

  describe('pantallas de caja y gastos', () => {
    it('capturar un gasto exige operar la caja', () => {
      expect(guardCount(routeFor('gastos'))).toBe(1);
      expect(NAV_ITEMS.find((item) => item.path === '/pos/gastos')?.permission).toEqual({
        area: 'pos',
        level: 'write',
      });
    });

    it('la auditoría de cortes exige el área propia `cashSessions`', () => {
      expect(guardCount(routeFor('cortes'))).toBe(1);
      expect(NAV_ITEMS.find((item) => item.path === '/pos/cortes')?.permission).toEqual({
        area: 'cashSessions',
        level: 'read',
      });
    });

    it('la auditoría de gastos exige el área propia `expenses`', () => {
      expect(guardCount(routeFor('gastos-auditoria'))).toBe(1);
      expect(NAV_ITEMS.find((item) => item.path === '/pos/gastos-auditoria')?.permission).toEqual({
        area: 'expenses',
        level: 'read',
      });
    });

    it('capturar y auditar gastos son rutas distintas con permisos distintos', () => {
      const captura = NAV_ITEMS.find((item) => item.path === '/pos/gastos')?.permission;
      const auditoria = NAV_ITEMS.find((item) => item.path === '/pos/gastos-auditoria')?.permission;
      expect(captura).not.toEqual(auditoria);
    });

    it('las tres pantallas se cargan lazy, como el resto del POS', () => {
      ['gastos', 'cortes', 'gastos-auditoria'].forEach((path) => {
        expect(typeof routeFor(path).loadComponent).toBe('function');
      });
    });
  });
});
