import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../core/notifications/notification.service';
import { DirectCharge } from '../../../shared/models';
import { DirectChargeService } from '../services/direct-charge.service';
import { MercadoPagoService } from '../services/mercado-pago.service';
import { DirectChargeScreen } from './direct-charge';

function charge(overrides: Partial<DirectCharge> = {}): DirectCharge {
  return {
    id: 'dc1',
    folio: 'CD-000001',
    amount: 120,
    concept: 'Aplicación de inyección',
    channel: 'point',
    status: 'pending',
    statusDetail: null,
    point: {
      orderId: 'o1',
      paymentId: null,
      status: 'created',
      amount: '120.00',
      terminalId: 'D1',
      externalReference: 'dc-key',
    },
    online: null,
    cashierId: 'u1',
    canceledBy: null,
    canceledAt: null,
    approvedAt: null,
    createdAt: new Date('2026-08-08T10:00:00.000Z'),
    ...overrides,
  };
}

function onlineCharge(overrides: Partial<DirectCharge> = {}): DirectCharge {
  return charge({
    id: 'dc2',
    channel: 'online',
    point: null,
    online: {
      preferenceId: 'pref-1',
      initPoint: 'https://mercadopago.com/checkout/pref-1',
      sandboxInitPoint: null,
      paymentId: null,
      paymentStatus: null,
      externalReference: 'dco-key',
      expiresAt: '2026-08-08T10:30:00.000Z',
    },
    ...overrides,
  });
}

describe('DirectChargeScreen', () => {
  let fixture: ComponentFixture<DirectChargeScreen>;
  let component: DirectChargeScreen;
  let directCharges: {
    create: ReturnType<typeof vi.fn>;
    createOnline: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  let notifyError: ReturnType<typeof vi.fn>;
  let notifySuccess: ReturnType<typeof vi.fn>;
  let listDevices: () => Observable<Array<{ id: string; operatingMode: string }>>;

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: notifySuccess } },
        { provide: DirectChargeService, useValue: directCharges },
        {
          provide: MercadoPagoService,
          useValue: {
            listDevices: () => listDevices(),
            preferredDevice: (devices: Array<{ id: string }>) => devices[0] ?? null,
            setDeviceOperatingMode: () => of({ id: 'D1', operatingMode: 'PDV' }),
          },
        },
      ],
    });

    fixture = TestBed.createComponent(DirectChargeScreen);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    notifySuccess = vi.fn();
    listDevices = () => of([{ id: 'D1', operatingMode: 'PDV' }]);
    directCharges = {
      create: vi.fn(() => of(charge())),
      createOnline: vi.fn(() => of(onlineCharge())),
      get: vi.fn(() => of(charge({ status: 'approved' }))),
      cancel: vi.fn(() => of(charge({ status: 'canceled' }))),
      list: vi.fn(() => of([])),
    };
    await build();
  });

  describe('validación', () => {
    it('sin monto ni concepto no se puede cobrar', () => {
      expect(component.canSubmit()).toBe(false);
      expect(component.blockers()).toHaveLength(2);
    });

    it('con monto, concepto y terminal se habilita', () => {
      component.amount.set(120);
      component.concept.set('Servicio');
      expect(component.blockers()).toEqual([]);
      expect(component.canSubmit()).toBe(true);
    });

    it('un concepto de menos de 3 caracteres no pasa: el registro quedaría inútil', () => {
      component.amount.set(120);
      component.concept.set('ab');
      expect(component.canSubmit()).toBe(false);
    });

    it('en línea no se exige terminal', async () => {
      listDevices = () => of([]);
      await build();

      component.selectChannel('online');
      component.amount.set(50);
      component.concept.set('Consulta');

      expect(component.blockers()).toEqual([]);
      expect(component.canSubmit()).toBe(true);
    });

    it('sin terminales la pantalla explica por qué no puede cobrar con Point', async () => {
      listDevices = () => of([]);
      await build();

      expect(component.devicesError()).toContain('No hay terminales');
      expect(component.canSubmit()).toBe(false);
    });
  });

  describe('cobro con terminal', () => {
    beforeEach(() => {
      component.amount.set(120);
      component.concept.set('Aplicación de inyección');
    });

    it('manda monto, concepto y terminal, y arranca el sondeo', () => {
      directCharges.get = vi.fn(() => of(charge()));
      component.submit();

      expect(directCharges.create).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'D1', amount: 120, concept: 'Aplicación de inyección' }),
      );
      expect(component.charge()?.folio).toBe('CD-000001');
      expect(component.pending()).toBe(true);
    });

    it('el concepto viaja recortado', () => {
      component.concept.set('   Servicio   ');
      component.submit();
      expect(directCharges.create.mock.calls[0][0].concept).toBe('Servicio');
    });

    it('reusa la misma llave de idempotencia mientras no se abra un cobro nuevo', () => {
      component.submit();
      const primeraLlave = directCharges.create.mock.calls[0][0].idempotencyKey;

      component.newCharge();
      component.amount.set(120);
      component.concept.set('Otro servicio');
      component.submit();

      expect(directCharges.create.mock.calls[1][0].idempotencyKey).not.toBe(primeraLlave);
    });

    it('un error del backend se avisa y no deja cobro en curso', () => {
      directCharges.create = vi.fn(() => throwError(() => new Error('Terminal fuera de línea')));
      component.submit();

      expect(notifyError).toHaveBeenCalled();
      expect(component.charge()).toBeNull();
    });

    it('un cobro ya aprobado no se puede reenviar', () => {
      directCharges.create = vi.fn(() => of(charge({ status: 'approved' })));
      component.submit();

      expect(component.approved()).toBe(true);
      expect(component.canSubmit()).toBe(false);
    });
  });

  describe('cobro en línea', () => {
    beforeEach(() => {
      component.selectChannel('online');
      component.amount.set(80);
      component.concept.set('Consulta');
    });

    it('usa el endpoint en línea y expone el link de pago', () => {
      component.submit();

      expect(directCharges.createOnline).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 80, concept: 'Consulta' }),
      );
      expect(directCharges.create).not.toHaveBeenCalled();
      expect(component.paymentLink()).toBe('https://mercadopago.com/checkout/pref-1');
    });

    it('copiar el link lo manda al portapapeles y lo marca copiado', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      component.submit();
      await component.copyLink();

      expect(writeText).toHaveBeenCalledWith('https://mercadopago.com/checkout/pref-1');
      expect(component.linkCopied()).toBe(true);
    });

    it('si el portapapeles falla avisa en vez de fingir que copió', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('sin permiso')) },
        configurable: true,
      });

      component.submit();
      await component.copyLink();

      expect(component.linkCopied()).toBe(false);
      expect(notifyError).toHaveBeenCalled();
    });
  });

  describe('cambio de canal', () => {
    it('con un cobro en curso no deja cambiar de pestaña', () => {
      component.amount.set(120);
      component.concept.set('Servicio');
      component.submit();

      component.selectChannel('online');

      expect(component.channel()).toBe('point');
      expect(notifyError).toHaveBeenCalled();
    });

    it('cambiar de canal limpia el formulario del cobro anterior', () => {
      component.amount.set(120);
      component.concept.set('Servicio');

      component.selectChannel('online');

      expect(component.channel()).toBe('online');
      expect(component.amount()).toBeNull();
      expect(component.concept()).toBe('');
    });
  });

  describe('cancelación', () => {
    it('cancela el cobro pendiente y refleja el estado', () => {
      component.amount.set(120);
      component.concept.set('Servicio');
      component.submit();

      component.cancel();

      expect(directCharges.cancel).toHaveBeenCalledWith('dc1');
      expect(component.charge()?.status).toBe('canceled');
      expect(component.polling()).toBe(false);
    });

    it('un cobro aprobado no se cancela desde aquí: requiere reembolso', () => {
      directCharges.create = vi.fn(() => of(charge({ status: 'approved' })));
      component.amount.set(120);
      component.concept.set('Servicio');
      component.submit();

      component.cancel();

      expect(directCharges.cancel).not.toHaveBeenCalled();
    });
  });

  describe('lista de recientes', () => {
    it('un cobro nuevo encabeza la lista', () => {
      component.amount.set(120);
      component.concept.set('Servicio');
      component.submit();

      expect(component.recent()[0].id).toBe('dc1');
    });

    it('actualizar un cobro no lo duplica en la lista', () => {
      component.amount.set(120);
      component.concept.set('Servicio');
      component.submit();
      component.cancel();

      expect(component.recent()).toHaveLength(1);
      expect(component.recent()[0].status).toBe('canceled');
    });

    it('un fallo al listar se muestra como banda persistente', async () => {
      directCharges.list = vi.fn(() => throwError(() => new Error('API caída')));
      await build();

      expect(component.recentError()).toBe('API caída');
    });
  });

  it('statusSeverity pinta cada estado con su color', () => {
    expect(component.statusSeverity('approved')).toBe('success');
    expect(component.statusSeverity('pending')).toBe('warn');
    expect(component.statusSeverity('failed')).toBe('danger');
    expect(component.statusSeverity('canceled')).toBe('secondary');
  });
});
