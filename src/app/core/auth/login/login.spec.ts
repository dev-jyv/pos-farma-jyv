import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../notifications/notification.service';
import { SyncScheduler } from '../../sync/sync-scheduler.service';
import { AuthService } from '../auth.service';
import { Login } from './login';

describe('Login', () => {
  let fixture: ComponentFixture<Login>;
  let component: Login;
  let login: (email: string, password: string) => Promise<void>;
  let logout: () => Promise<void>;
  let fetchRole: () => Observable<string | null>;
  let navigate: ReturnType<typeof vi.fn>;
  let notifyError: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    login = vi.fn(() => Promise.resolve());
    logout = vi.fn(() => Promise.resolve());
    fetchRole = () => of<string | null>('cashier');
    navigate = vi.fn(() => Promise.resolve(true));
    notifyError = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
        { provide: Router, useValue: { navigate } },
        {
          provide: AuthService,
          useValue: {
            login: (email: string, password: string) => login(email, password),
            logout: () => logout(),
            fetchRole: () => fetchRole(),
            getLoginErrorMessage: () => 'auth.login.error',
          },
        },
        {
          // Evita construir la cadena real SyncScheduler -> SaleService -> HttpClient;
          // estas pruebas no ejercitan el sync, solo el formulario de login.
          provide: SyncScheduler,
          useValue: { syncNow: vi.fn().mockResolvedValue({ ok: true, pulled: 0 }) },
        },
      ],
    });

    fixture = TestBed.createComponent(Login);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('con el formulario inválido no intenta entrar', async () => {
    await component.onSubmit();

    expect(login).not.toHaveBeenCalled();
    expect(component.form.touched).toBe(true);
  });

  it('exige un correo con formato válido', () => {
    component.form.setValue({ email: 'no-es-correo', password: '123456' });
    expect(component.form.invalid).toBe(true);
  });

  it('entra y navega al POS', async () => {
    component.form.setValue({ email: 'caja@farmajyv.mx', password: 'secreto' });

    await component.onSubmit();

    expect(login).toHaveBeenCalledWith('caja@farmajyv.mx', 'secreto');
    expect(navigate).toHaveBeenCalledWith(['/pos']);
    expect(component.submitting()).toBe(false);
  });

  it('sin rol utilizable cierra sesión y avisa: esa cuenta no puede operar la caja', async () => {
    fetchRole = () => of(null);
    component.form.setValue({ email: 'caja@farmajyv.mx', password: 'secreto' });

    await component.onSubmit();

    expect(logout).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalled();
  });

  it('un doble clic no dispara dos logins', async () => {
    let resolveLogin!: () => void;
    login = vi.fn(() => new Promise<void>((resolve) => (resolveLogin = resolve)));
    component.form.setValue({ email: 'caja@farmajyv.mx', password: 'secreto' });

    const first = component.onSubmit();
    const second = component.onSubmit();
    resolveLogin();
    await Promise.all([first, second]);

    expect(login).toHaveBeenCalledTimes(1);
  });

  it('credenciales inválidas se avisan y liberan el botón', async () => {
    login = vi.fn(() => Promise.reject({ code: 'auth/invalid-credential' }));
    component.form.setValue({ email: 'caja@farmajyv.mx', password: 'malo' });

    await component.onSubmit();

    expect(notifyError).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(component.submitting()).toBe(false);
  });
});
