import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { Sale } from '../../../shared/models';
import { SaleTicket } from './sale-ticket';

function sale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: 'v1',
    folio: 'V-000001',
    items: [
      {
        productId: 'p1',
        productName: 'Paracetamol',
        unitPrice: 50,
        discountAmount: 0,
        quantity: 2,
        subtotal: 100,
      },
    ],
    subtotal: 100,
    discountTotal: 0,
    total: 100,
    taxSummary: null,
    paymentMethod: 'cash',
    amountReceived: 100,
    change: 0,
    cashAmount: 100,
    cardAmount: null,
    cardPaymentReference: null,
    cashierId: 'u1',
    cashSessionId: 's1',
    customerId: null,
    customerName: null,
    prescription: null,
    prescriptionRetained: false,
    controlledGroups: [],
    billing: null,
    invoiceStatus: null,
    voidedAt: null,
    createdAt: new Date('2026-08-08T15:00:00'),
    ...overrides,
  } as Sale;
}

describe('SaleTicket', () => {
  let fixture: ComponentFixture<SaleTicket>;
  let component: SaleTicket;

  async function build(current: Sale): Promise<void> {
    fixture = TestBed.createComponent(SaleTicket);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('sale', current);
    await fixture.whenStable();
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('traduce el método de pago al texto del ticket', async () => {
    await build(sale({ paymentMethod: 'mixed' }));
    expect(component.methodLabel()).toBe('Mixto');
  });

  it('en pago mixto imprime el reparto efectivo/tarjeta', async () => {
    await build(sale({ paymentMethod: 'mixed', cashAmount: 40, cardAmount: 60 }));
    expect(component.showTenderSplit()).toBe(true);
  });

  it('en efectivo puro no hay reparto que imprimir', async () => {
    await build(sale());
    expect(component.showTenderSplit()).toBe(false);
  });

  it('lista los grupos COFEPRIS de la venta', async () => {
    await build(sale({ controlledGroups: ['I', 'IV'] }));
    expect(component.controlledLabel()).toContain(',');
  });

  it('sin controlados la etiqueta queda vacía', async () => {
    await build(sale());
    expect(component.controlledLabel()).toBe('');
  });

  it('pinta el ticket completo con partidas y totales', async () => {
    await build(sale());
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('V-000001');
    expect(text).toContain('Paracetamol');
  });
});
