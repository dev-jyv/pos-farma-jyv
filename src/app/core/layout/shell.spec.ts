import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiHealthService } from '../health/api-health.service';
import { AuthService } from '../auth/auth.service';
import { NAV_ITEMS } from './nav.config';
import { Shell } from './shell';

describe('Shell', () => {
  let fixture: ComponentFixture<Shell>;
  let component: Shell;
  let navigate: ReturnType<typeof vi.fn>;
  let logout: ReturnType<typeof vi.fn>;
  let can: (area: string, level?: string) => boolean;

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        { provide: Router, useValue: { navigate, createUrlTree: () => ({}), serializeUrl: () => '', events: { subscribe: () => ({ unsubscribe: () => {} }) } } },
        {
          provide: AuthService,
          useValue: {
            user: signal({ email: 'caja@farmajyv.mx' }),
            role: signal('cashier'),
            roleName: signal('Cajero'),
            isAdmin: signal(false),
            can: (area: string, level?: string) => can(area, level),
            logout,
          },
        },
        {
          provide: ApiHealthService,
          useValue: { browserOnline: signal(true), degraded: signal(false) },
        },
      ],
    });

    fixture = TestBed.createComponent(Shell);
    component = fixture.componentInstance;
  }

  beforeEach(async () => {
    navigate = vi.fn(() => Promise.resolve(true));
    logout = vi.fn(() => Promise.resolve());
    can = () => true;
    await build();
  });

  it('con todos los permisos muestra el menú completo', () => {
    expect(component.navItems()).toHaveLength(NAV_ITEMS.length);
  });

  it('oculta los enlaces cuyo permiso no tiene el rol: un enlace que da 403 no es navegación', async () => {
    can = (area) => area !== 'inventory';
    await build();

    expect(component.navItems().some((item) => item.path === '/pos/libro-control')).toBe(false);
  });

  it('el nombre del rol viene del backend, no de una llave i18n', () => {
    expect(component.roleLabel()).toBe('Cajero');
  });

  it('F1 lleva a la venta y F3 al historial', () => {
    const event = new KeyboardEvent('keydown');
    component.goToSale(event);
    expect(navigate).toHaveBeenCalledWith(['/pos']);

    component.goToHistory(event);
    expect(navigate).toHaveBeenCalledWith(['/pos/historial']);
  });

  it('cerrar sesión termina la sesión y manda al login', async () => {
    await component.logout();

    expect(logout).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });
});
