import { beforeEach, describe, expect, it } from 'vitest';

import { CartLine, CartProductLine, CouponDto, Product } from '../../../shared/models';
import { CouponService } from './coupon.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-03T18:00:00Z');

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'local-1',
    remoteId: 'p1',
    sku: 'AMOX',
    name: 'Amoxicilina',
    salePrice: 12,
    stock: 50,
    boxQuantity: 10,
    boxPrice: 100,
    ...overrides,
  } as Product;
}

function line(quantity: number, overrides: Partial<CartProductLine> = {}): CartProductLine {
  return { kind: 'product', product: product(), quantity, discountAmount: 0, ...overrides };
}

function coupon(overrides: Partial<CouponDto> = {}): CouponDto {
  return {
    id: 'AMOX10',
    code: 'AMOX10',
    name: 'Amoxicilina 10 %',
    scope: 'product',
    productIds: ['p1'],
    discount: { type: 'percent', percent: 10 },
    minPurchase: null,
    startsAt: new Date(NOW.getTime() - DAY).toISOString(),
    endsAt: null,
    maxUses: null,
    usedCount: 0,
    isActive: true,
    ...overrides,
  };
}

describe('CouponService.apply', () => {
  let service: CouponService;

  beforeEach(() => {
    service = new CouponService();
  });

  it('cupón de producto: entra en el discountAmount de la línea y reemplaza al manual', () => {
    // 3 piezas de $12 con $3 de manual: el cupón se calcula sobre los $36 de lista.
    const pricing = service.apply([line(3, { discountAmount: 3 })], coupon(), NOW);
    const [result] = pricing.lines as CartProductLine[];

    expect(result.discountAmount).toBe(3.6);
    expect(result.coupon).toEqual({ code: 'AMOX10', discountAmount: 3.6 });
    expect(pricing).toMatchObject({ saleDiscount: 0, total: 3.6, issue: null });
  });

  it('cupón de producto: la línea en promoción no lo recibe y la caja del mismo producto sí', () => {
    const promo = line(2, { discountAmount: 4, promotion: { id: 'pr', name: '2x$20', discountAmount: 4 } });
    const caja = line(1, { saleUnit: 'box' });

    const pricing = service.apply([promo, caja], coupon(), NOW);
    const [conPromo, conCaja] = pricing.lines as CartProductLine[];

    expect(conPromo.discountAmount).toBe(4);
    expect(conPromo.coupon ?? null).toBeNull();
    expect(conCaja.coupon).toEqual({ code: 'AMOX10', discountAmount: 10 });
    expect(service.skippedForPromotion(promo, coupon())).toBe(true);
  });

  it('monto por pieza: una caja de 10 descuenta 10 veces el monto', () => {
    const pricing = service.apply(
      [line(1, { saleUnit: 'box' })],
      coupon({ discount: { type: 'amount', amount: 2 } }),
      NOW,
    );

    expect(pricing.total).toBe(20);
  });

  it('cupón de venta: va como saleDiscount y no toca las líneas', () => {
    const lines: CartLine[] = [line(5, { discountAmount: 6 })];
    const pricing = service.apply(
      lines,
      coupon({ id: 'VENTA50', code: 'VENTA50', scope: 'sale', productIds: [], discount: { type: 'amount', amount: 50 } }),
      NOW,
    );

    expect(pricing.saleDiscount).toBe(50);
    expect((pricing.lines[0] as CartProductLine).discountAmount).toBe(6);
  });

  it('cupón de venta sin alcanzar el mínimo explica el monto que falta', () => {
    const pricing = service.apply(
      [line(1)],
      coupon({ code: 'VENTA50', scope: 'sale', productIds: [], minPurchase: 200 }),
      NOW,
    );

    expect(pricing.total).toBe(0);
    expect(pricing.issue?.code).toBe('below_minimum');
    expect(pricing.issue?.message).toContain('$200.00');
  });

  it('vencido, inactivo o aún no vigente con el reloj local no descuenta', () => {
    const lines = [line(2)];
    expect(service.apply(lines, coupon({ endsAt: new Date(NOW.getTime() - 1000).toISOString() }), NOW).issue?.code).toBe('expired');
    expect(service.apply(lines, coupon({ isActive: false }), NOW).issue?.code).toBe('inactive');
    expect(service.apply(lines, coupon({ startsAt: new Date(NOW.getTime() + DAY).toISOString() }), NOW).issue?.code).toBe('not_started');
  });

  it('sin productos del cupón en el ticket lo dice así; con todos en promoción, también', () => {
    expect(service.apply([line(1, { product: product({ remoteId: 'otro' }) })], coupon(), NOW).issue?.code).toBe('no_products');
    const promo = line(2, { discountAmount: 4, promotion: { id: 'pr', name: '2x$20', discountAmount: 4 } });
    expect(service.apply([promo], coupon(), NOW).issue?.code).toBe('all_promoted');
  });

  it('quitar el cupón devuelve las líneas sin su parte', () => {
    const [conCupon] = service.apply([line(3)], coupon(), NOW).lines;
    const [sinCupon] = service.apply([conCupon], null, NOW).lines as CartProductLine[];

    expect(sinCupon.coupon).toBeNull();
  });

  it('usados ≥ máximo solo avisa: decide el servidor', () => {
    expect(service.maybeExhausted(coupon({ maxUses: 5, usedCount: 5 }))).toBe(true);
    expect(service.maybeExhausted(coupon({ maxUses: 5, usedCount: 4 }))).toBe(false);
    expect(service.maybeExhausted(coupon({ maxUses: null, usedCount: 900 }))).toBe(false);
  });
});
