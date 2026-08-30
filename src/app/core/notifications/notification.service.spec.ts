import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let add: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    add = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: MessageService, useValue: { add } }],
    });
    service = TestBed.inject(NotificationService);
  });

  it('publica el éxito como toast verde', () => {
    service.success('Venta registrada');
    expect(add).toHaveBeenCalledWith({ severity: 'success', summary: 'OK', detail: 'Venta registrada' });
  });

  it('publica el error como toast rojo', () => {
    service.error('Stock insuficiente');
    expect(add).toHaveBeenCalledWith({ severity: 'error', summary: 'Error', detail: 'Stock insuficiente' });
  });

  it('la sesión expirada explica el corte de las 24:00 y dura más en pantalla', () => {
    service.sessionExpired();

    const [message] = add.mock.calls[0];
    expect(message.severity).toBe('warn');
    expect(message.summary).toBe('Sesión expirada');
    expect(message.detail).toContain('24:00');
    expect(message.life).toBe(10_000);
  });

  it('prefiere el mensaje del backend cuando lo hay', () => {
    service.sessionExpired('Usuario deshabilitado');
    expect(add.mock.calls[0][0].detail).toBe('Usuario deshabilitado');
  });
});
