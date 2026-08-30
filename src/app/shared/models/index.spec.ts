import { describe, expect, it } from 'vitest';

import {
  StaffProfile,
  hasPermission,
  parsePaymentMethod,
  parseStaffProfile,
  parseStaffRole,
} from './index';

function profile(overrides: Partial<StaffProfile> = {}): StaffProfile {
  return {
    uid: 'u1',
    email: 'cajero@farmajyv.mx',
    displayName: 'Cajero',
    role: { id: 'r1', name: 'Cajero', slug: 'cashier' },
    permissions: [{ area: 'sales', level: 'write' }],
    ...overrides,
  };
}

describe('parseStaffRole', () => {
  it('acepta el slug como cadena', () => {
    expect(parseStaffRole('cashier')).toBe('cashier');
  });

  it('acepta el rol como documento con slug', () => {
    expect(parseStaffRole({ id: 'r1', slug: 'admin' })).toBe('admin');
  });

  it('rechaza vacíos y formas desconocidas', () => {
    expect(parseStaffRole('')).toBeNull();
    expect(parseStaffRole({ slug: '' })).toBeNull();
    expect(parseStaffRole(null)).toBeNull();
    expect(parseStaffRole(42)).toBeNull();
  });
});

describe('hasPermission', () => {
  it('sin perfil no hay permiso', () => {
    expect(hasPermission(null, 'sales')).toBe(false);
  });

  it('admin puede todo, igual que en el backend', () => {
    const admin = profile({ role: { id: 'r0', name: 'Admin', slug: 'admin' }, permissions: [] });
    expect(hasPermission(admin, 'inventory', 'write')).toBe(true);
  });

  it('escritura exige nivel write; lectura basta con tener el área', () => {
    const soloLectura = profile({ permissions: [{ area: 'inventory', level: 'read' }] });
    expect(hasPermission(soloLectura, 'inventory', 'read')).toBe(true);
    expect(hasPermission(soloLectura, 'inventory', 'write')).toBe(false);
  });

  it('un área ausente no se concede', () => {
    expect(hasPermission(profile(), 'users', 'read')).toBe(false);
  });

  it('el nivel por defecto es write', () => {
    const soloLectura = profile({ permissions: [{ area: 'sales', level: 'read' }] });
    expect(hasPermission(soloLectura, 'sales')).toBe(false);
  });
});

describe('parseStaffProfile', () => {
  it('arma el perfil con el rol y sus permisos', () => {
    const parsed = parseStaffProfile({
      uid: 'u1',
      email: 'a@b.mx',
      displayName: 'Ana',
      role: { id: 'r1', name: 'Cajero', slug: 'cashier' },
      permissions: [{ area: 'sales', level: 'write' }],
    });

    expect(parsed).toEqual({
      uid: 'u1',
      email: 'a@b.mx',
      displayName: 'Ana',
      role: { id: 'r1', name: 'Cajero', slug: 'cashier' },
      permissions: [{ area: 'sales', level: 'write' }],
    });
  });

  it('sin rol utilizable no hay perfil: la sesión no sirve', () => {
    expect(parseStaffProfile({ uid: 'u1' })).toBeNull();
    expect(parseStaffProfile(null)).toBeNull();
    expect(parseStaffProfile('x')).toBeNull();
  });

  it('descarta permisos con forma inválida en vez de confiar en ellos', () => {
    const parsed = parseStaffProfile({
      role: 'cashier',
      permissions: [{ area: 'sales', level: 'write' }, { area: 'sales' }, 'nope', { level: 'write' }],
    });

    expect(parsed?.permissions).toEqual([{ area: 'sales', level: 'write' }]);
  });

  it('cae al slug como nombre del rol cuando el backend no lo manda', () => {
    expect(parseStaffProfile({ role: 'manager' })?.role.name).toBe('manager');
  });
});

describe('parsePaymentMethod', () => {
  it('acepta los métodos que el backend conoce', () => {
    expect(parsePaymentMethod('cash')).toBe('cash');
    expect(parsePaymentMethod('card')).toBe('card');
    expect(parsePaymentMethod('transfer')).toBe('transfer');
    expect(parsePaymentMethod('mixed')).toBe('mixed');
  });

  it('rechaza cualquier otro valor', () => {
    expect(parsePaymentMethod('crypto')).toBeNull();
    expect(parsePaymentMethod(null)).toBeNull();
  });
});
