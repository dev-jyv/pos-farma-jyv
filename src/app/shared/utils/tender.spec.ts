import { describe, expect, it } from 'vitest';

import { resolveTender } from './tender';

describe('resolveTender', () => {
  it('efectivo: el cambio sale contra el total', () => {
    const tender = resolveTender({
      paymentMethod: 'cash',
      total: 187.5,
      amountReceived: 200,
      cardAmount: null,
    });

    expect(tender.cashDue).toBe(187.5);
    expect(tender.change).toBe(12.5);
    expect(tender.cashAmount).toBe(187.5);
    expect(tender.cardAmount).toBeNull();
    expect(tender.error).toBeNull();
  });

  it('efectivo: marca el faltante sin dar cambio', () => {
    const tender = resolveTender({
      paymentMethod: 'cash',
      total: 100,
      amountReceived: 80,
      cardAmount: null,
    });

    expect(tender.cashSatisfied).toBe(false);
    expect(tender.shortfall).toBe(20);
    expect(tender.change).toBe(0);
  });

  it('tarjeta: no pide efectivo y la tarjeta cubre el total', () => {
    const tender = resolveTender({
      paymentMethod: 'card',
      total: 249.9,
      amountReceived: null,
      cardAmount: null,
    });

    expect(tender.cashDue).toBe(0);
    expect(tender.cashAmount).toBeNull();
    expect(tender.cardAmount).toBe(249.9);
    expect(tender.cashSatisfied).toBe(true);
    expect(tender.error).toBeNull();
  });

  it('mixto: el efectivo solo cubre lo que no pagó la tarjeta', () => {
    const tender = resolveTender({
      paymentMethod: 'mixed',
      total: 300,
      amountReceived: 150,
      cardAmount: 200,
    });

    expect(tender.cashDue).toBe(100);
    expect(tender.cashAmount).toBe(100);
    expect(tender.cardAmount).toBe(200);
    expect(tender.change).toBe(50);
    expect(tender.cashSatisfied).toBe(true);
    expect(tender.error).toBeNull();
  });

  it('mixto: exigir el total en efectivo era el bug histórico', () => {
    const tender = resolveTender({
      paymentMethod: 'mixed',
      total: 300,
      amountReceived: 100,
      cardAmount: 200,
    });

    // El efectivo iguala exactamente la parte en efectivo: venta válida, cambio 0.
    expect(tender.cashSatisfied).toBe(true);
    expect(tender.shortfall).toBe(0);
    expect(tender.change).toBe(0);
  });

  it('mixto: rechaza tarjeta en cero o cubriendo el total', () => {
    expect(
      resolveTender({ paymentMethod: 'mixed', total: 100, amountReceived: 100, cardAmount: 0 })
        .error,
    ).toMatch(/mayor a cero/);
    expect(
      resolveTender({ paymentMethod: 'mixed', total: 100, amountReceived: 0, cardAmount: 100 })
        .error,
    ).toMatch(/pago con tarjeta/);
  });

  it('mixto: pide el monto con tarjeta antes de poder cobrar', () => {
    const tender = resolveTender({
      paymentMethod: 'mixed',
      total: 100,
      amountReceived: 100,
      cardAmount: null,
    });

    expect(tender.error).toMatch(/monto cobrado con tarjeta/);
  });

  it('opera en centavos: sin residuos de punto flotante', () => {
    const tender = resolveTender({
      paymentMethod: 'mixed',
      total: 0.3,
      amountReceived: 0.2,
      cardAmount: 0.1,
    });

    expect(tender.cashDue).toBe(0.2);
    expect(tender.change).toBe(0);
    expect(tender.cashSatisfied).toBe(true);
  });
});
