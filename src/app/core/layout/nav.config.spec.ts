import { describe, expect, it } from 'vitest';

import { RolePermission, StaffProfile, hasPermission } from '../../shared/models';
import { NAV_ITEMS } from './nav.config';

/**
 * Matriz de qué ve cada rol en la barra. Los permisos replican
 * `SYSTEM_ROLE_DEFINITIONS` del backend (`constants/permissions.ts`): si allá
 * cambian, esta prueba es la que avisa que la caja empezó a ofrecer —o a
 * esconder— pantallas que no corresponden.
 */
function profileFor(slug: string, permissions: RolePermission[]): StaffProfile {
  return {
    uid: 'u1',
    email: `${slug}@farmajyv.mx`,
    displayName: slug,
    role: { id: `r-${slug}`, name: slug, slug },
    permissions,
  };
}

/** Mismo filtro que aplica `Shell.navItems`. */
function visibleFor(profile: StaffProfile): string[] {
  return NAV_ITEMS.filter(
    (item) => !item.permission || hasPermission(profile, item.permission.area, item.permission.level),
  ).map((item) => item.labelKey);
}

const cashier = profileFor('cashier', [
  { area: 'pos', level: 'write' },
  { area: 'sales', level: 'read' },
  { area: 'products', level: 'read' },
  { area: 'categories', level: 'read' },
  { area: 'inventory', level: 'read' },
  { area: 'stockEntry', level: 'write' },
]);

const admin = profileFor('admin', []);

const manager = profileFor('manager', [
  { area: 'stockEntry', level: 'write' },
  { area: 'sales', level: 'write' },
  { area: 'products', level: 'write' },
  { area: 'inventory', level: 'write' },
  { area: 'invoices', level: 'write' },
  { area: 'directCharges', level: 'write' },
]);

const doctor = profileFor('doctor', [
  { area: 'doctor', level: 'write' },
  { area: 'patients', level: 'write' },
  { area: 'products', level: 'read' },
]);

describe('NAV_ITEMS', () => {
  it('el cajero ve venta, historial y la entrada de stock', () => {
    expect(visibleFor(cashier)).toEqual(['nav.sale', 'nav.history', 'nav.stockEntry']);
  });

  it('recibir mercancía no le abre el libro de control ni los reportes', () => {
    const visible = visibleFor(cashier);
    expect(visible).not.toContain('nav.controlledLedger');
    expect(visible).not.toContain('nav.reports');
    expect(visible).not.toContain('nav.directCharge');
  });

  it('el cajero no ve el libro de control aunque tenga `inventory:read` para vender', () => {
    // `read` es el permiso con el que consulta lotes y caducidades; el libro pide `write`.
    expect(visibleFor(cashier)).not.toContain('nav.controlledLedger');
  });

  it('el cobro directo no se concede con el permiso de caja: tiene área propia', () => {
    // Cobrar fuera del ticket es supervisión, no mostrador.
    expect(visibleFor(cashier)).not.toContain('nav.directCharge');
  });

  it('un rol de solo lectura de ventas conserva venta e historial', () => {
    const soloLectura = profileFor('consulta', [{ area: 'sales', level: 'read' }]);
    expect(visibleFor(soloLectura)).toEqual(['nav.sale', 'nav.history']);
  });

  it('la entrada de stock no se concede con `inventory:read`', () => {
    // `inventory:read` es lo que el cajero usa para lotes y caducidad al vender.
    const soloInventarioLectura = profileFor('consulta', [{ area: 'inventory', level: 'read' }]);
    expect(visibleFor(soloInventarioLectura)).not.toContain('nav.stockEntry');
  });

  it('el administrador ve todo, sin permisos declarados', () => {
    expect(visibleFor(admin)).toEqual(NAV_ITEMS.map((item) => item.labelKey));
  });

  it('el gerente ve libro de control, cobro directo y entrada de stock, pero no los reportes (`dashboard`)', () => {
    const visible = visibleFor(manager);
    expect(visible).toContain('nav.controlledLedger');
    expect(visible).toContain('nav.directCharge');
    expect(visible).toContain('nav.stockEntry');
    expect(visible).not.toContain('nav.reports');
  });

  it('un rol de consultorio solo llega a la pantalla de venta', () => {
    expect(visibleFor(doctor)).toEqual(['nav.sale']);
  });

  it('sin perfil resuelto no se ofrece nada más que la venta', () => {
    expect(
      NAV_ITEMS.filter(
        (item) => !item.permission || hasPermission(null, item.permission.area, item.permission.level),
      ).map((item) => item.labelKey),
    ).toEqual(['nav.sale']);
  });
});
