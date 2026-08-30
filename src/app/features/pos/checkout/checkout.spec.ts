import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../core/notifications/notification.service';
import { CartLine, Product } from '../../../shared/models';
import { CashDrawerService } from '../services/cash-drawer.service';
import { CustomerService } from '../services/customer.service';
import { MercadoPagoService, PointOrder } from '../services/mercado-pago.service';
import { Checkout } from './checkout';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    sku: 'SKU1',
    name: 'Paracetamol',
    salePrice: 50,
    stock: 10,
    controlledGroup: null,
    ...overrides,
  } as Product;
}

function cart(overrides: Partial<Product> = {}): CartLine[] {
  return [{ product: product(overrides), quantity: 2, discountAmount: 0 }];
}

function order(status: PointOrder['status'], amount = '100.00'): PointOrder {
  return {
    id: 'o1',
    status,
    statusDetail: null,
    terminalId: 'D1',
    amount,
    externalReference: 'ref',
    paymentId: null,
  };
}

describe('Checkout', () => {
  let fixture: ComponentFixture<Checkout>;
  let component: Checkout;
  let notifyError: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    notifyError = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
        { provide: CashDrawerService, useValue: { open: vi.fn() } },
        { provide: CustomerService, useValue: { search: () => of([]), create: () => of({}) } },
        {
          provide: MercadoPagoService,
          useValue: {
            listDevices: () => of([{ id: 'D1', operatingMode: 'PDV' }]),
            preferredDevice: (devices: Array<{ id: string }>) => devices[0] ?? null,
            setDeviceOperatingMode: () => of({ id: 'D1', operatingMode: 'PDV' }),
            createOrder: () => of(order('created')),
            getOrder: () => of(order('created')),
            cancelOrder: () => of(undefined),
          },
        },
      ],
    });

    fixture = TestBed.createComponent(Checkout);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('cart', cart());
    fixture.componentRef.setInput('subtotal', 100);
    fixture.componentRef.setInput('total', 100);
    fixture.componentRef.setInput('cashSessionId', 's1');
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
  });

  describe('efectivo', () => {
    it('al abrir arranca en efectivo con el total ya capturado', () => {
      expect(component.paymentMethod()).toBe('cash');
      expect(component.amountReceived()).toBe(100);
      expect(component.canConfirm()).toBe(true);
      expect(component.change()).toBe(0);
    });

    it('calcula el cambio del efectivo recibido', () => {
      component.amountReceived.set(200);
      expect(component.change()).toBe(100);
      expect(component.canConfirm()).toBe(true);
    });

    it('con efectivo de menos bloquea el cobro y dice cuánto falta', () => {
      component.amountReceived.set(80);
      expect(component.cashSatisfied()).toBe(false);
      expect(component.shortfall()).toBe(20);
      expect(component.canConfirm()).toBe(false);
      expect(component.blockers().some((blocker) => blocker.id === 'cash')).toBe(true);
    });

    it('los montos rápidos acumulan y el 0 completa lo que falta', () => {
      component.amountReceived.set(0);
      component.setQuickAmount(50);
      component.setQuickAmount(20);
      expect(component.amountReceived()).toBe(70);

      component.setQuickAmount(0);
      expect(component.amountReceived()).toBe(100);
    });
  });

  describe('tarjeta', () => {
    it('sin aprobación de la terminal no se puede cobrar', () => {
      component.selectPaymentMethod('card');
      expect(component.canConfirm()).toBe(false);
      expect(component.blockers().some((blocker) => blocker.id === 'card')).toBe(true);
    });

    it('con la order aprobada se habilita el cobro', () => {
      component.selectPaymentMethod('card');
      component.cardOrder.set(order('processed'));
      expect(component.cardOrderApproved()).toBe(true);
      expect(component.canConfirm()).toBe(true);
    });

    it('tras processed auto-confirma si no hay bloqueos', () => {
      const confirmSpy = vi.spyOn(component, 'confirm').mockImplementation(() => undefined);
      component.selectPaymentMethod('card');
      component.cardOrder.set(order('processed'));

      (component as unknown as { tryAutoConfirmAfterCard: () => void }).tryAutoConfirmAfterCard();

      expect(confirmSpy).toHaveBeenCalledOnce();
    });

    it('no auto-confirma si aún falta la aprobación o hay bloqueo', () => {
      const confirmSpy = vi.spyOn(component, 'confirm').mockImplementation(() => undefined);
      component.selectPaymentMethod('card');
      // Sin order procesada: canConfirm es false.
      (component as unknown as { tryAutoConfirmAfterCard: () => void }).tryAutoConfirmAfterCard();

      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('el monto a la terminal es el total del ticket', () => {
      component.selectPaymentMethod('card');
      expect(component.cardChargeAmount()).toBe(100);
    });

    it('muestra la cuenta atrás de la orden mientras la terminal no cobra', () => {
      component.selectPaymentMethod('card');
      component.startCardPayment();

      expect(component.cardCountdown()).toBe('15:00');
    });

    it('sin orden o con el cobro aprobado no hay cuenta atrás que mostrar', () => {
      expect(component.cardCountdown()).toBeNull();

      component.selectPaymentMethod('card');
      component.startCardPayment();
      component.cardOrder.set(order('processed'));

      expect(component.cardCountdown()).toBeNull();
    });
  });

  describe('mixto', () => {
    it('arranca a mitades y el efectivo se recalcula solo', () => {
      component.selectPaymentMethod('mixed');
      expect(component.cardAmountInput()).toBe(50);
      expect(component.cashDue()).toBe(50);
      expect(component.amountReceived()).toBe(50);
    });

    it('exige tarjeta aprobada **y** efectivo suficiente', () => {
      component.selectPaymentMethod('mixed');
      expect(component.canConfirm()).toBe(false);

      component.cardOrder.set(order('processed', '50.00'));
      expect(component.canConfirm()).toBe(true);

      component.amountReceived.set(10);
      expect(component.canConfirm()).toBe(false);
    });

    it('mientras la order vive, el monto con tarjeta queda fijo', () => {
      component.selectPaymentMethod('mixed');
      component.cardOrder.set(order('at_terminal', '50.00'));
      expect(component.cardAmountLocked()).toBe(true);

      component.setCardAmount(80);
      expect(component.cardAmountInput()).toBe(50);
    });

    it('una order fallida libera el monto para repartir distinto', () => {
      component.selectPaymentMethod('mixed');
      component.cardOrder.set(order('failed', '50.00'));
      expect(component.cardAmountLocked()).toBe(false);

      component.setCardAmount(30);
      expect(component.cardAmountInput()).toBe(30);
      expect(component.cashDue()).toBe(70);
    });
  });

  describe('cambio de método', () => {
    it('con un cobro ya aprobado no deja cambiar de método', () => {
      component.selectPaymentMethod('card');
      component.cardOrder.set(order('processed'));

      component.selectPaymentMethod('cash');

      expect(component.paymentMethod()).toBe('card');
      expect(notifyError).toHaveBeenCalled();
    });

    it('con una order viva sin aprobar, cambiar de método la cancela', () => {
      const cancelOrder = vi.fn(() => of(undefined));
      TestBed.inject(MercadoPagoService).cancelOrder = cancelOrder as never;

      component.selectPaymentMethod('card');
      component.cardOrder.set(order('at_terminal'));
      component.selectPaymentMethod('cash');

      expect(cancelOrder).toHaveBeenCalledWith('o1');
      expect(component.cardOrder()).toBeNull();
      expect(component.paymentMethod()).toBe('cash');
    });

    it('si la terminal rechaza la cancelación, el método NO cambia y la order sigue a la vista', () => {
      TestBed.inject(MercadoPagoService).cancelOrder = (() =>
        throwError(() => new Error('Cancélalo desde la terminal.'))) as never;

      component.selectPaymentMethod('card');
      component.cardOrder.set(order('at_terminal'));
      component.selectPaymentMethod('cash');

      // Olvidar la order aquí dejaría un cobro vivo que el cajero ya no ve.
      expect(component.cardOrder()?.id).toBe('o1');
      expect(component.paymentMethod()).toBe('card');
      expect(notifyError).toHaveBeenCalled();
    });

    it('una cancelación fallida deja el botón libre para reintentar', () => {
      TestBed.inject(MercadoPagoService).cancelOrder = (() =>
        throwError(() => new Error('500'))) as never;

      component.selectPaymentMethod('card');
      component.cardOrder.set(order('at_terminal'));
      component.cancelCardPayment();

      expect(component.cancelingCard()).toBe(false);
      expect(component.cardOrder()?.id).toBe('o1');
    });
  });

  describe('receta controlada', () => {
    beforeEach(async () => {
      fixture.componentRef.setInput('cart', cart({ controlledGroup: 'II' }));
      await fixture.whenStable();
    });

    it('un grupo II exige receta, folio y retención antes de cobrar', () => {
      expect(component.needsPrescription()).toBe(true);
      expect(component.needsFolio()).toBe(true);
      expect(component.needsRetention()).toBe(true);
      expect(component.canConfirm()).toBe(false);
      expect(component.blockers().some((blocker) => blocker.id === 'prescription')).toBe(true);
    });

    it('con receta completa se libera el cobro', () => {
      component.doctorName.set('Dra. Ana Ruiz');
      component.doctorLicense.set('1234567');
      component.prescriptionFolio.set('F-001');
      component.prescriptionRetained.set(true);

      expect(component.prescriptionError()).toBeNull();
      expect(component.canConfirm()).toBe(true);
    });
  });

  describe('facturación', () => {
    it('exige RFC de 12–13 y razón social cuando se factura', () => {
      component.requiresInvoice.set(true);
      expect(component.billingOk()).toBe(false);
      expect(component.canConfirm()).toBe(false);

      component.billingRfc.set('XAXX010101000');
      component.billingName.set('Público en general');
      expect(component.billingOk()).toBe(true);
      expect(component.canConfirm()).toBe(true);
    });
  });

  it('isBlocked y blockerDescribedBy señalan el campo a corregir', () => {
    component.amountReceived.set(0);
    expect(component.isBlocked('cash')).toBe(true);
    expect(component.blockerDescribedBy('cash')).toBe('checkout-blocker-cash');
    expect(component.blockerDescribedBy('billing')).toBeNull();
  });
});
