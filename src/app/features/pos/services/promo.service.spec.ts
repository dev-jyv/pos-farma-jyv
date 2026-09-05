import { beforeEach, describe, expect, it } from 'vitest';

import { environment } from '../../../../environments/environment';
import { CartLine, Product } from '../../../shared/models';
import { PromoRule, PromoService } from './promo.service';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    sku: 'SKU1',
    name: 'Producto',
    salePrice: 100,
    stock: 10,
  } as Product;
}

function line(quantity: number, overrides: Partial<Product> = {}): CartLine {
  return { kind: 'product', product: { ...product(), ...overrides }, quantity, discountAmount: 0 };
}

function withPromos<T>(rules: PromoRule[], run: () => T): T {
  const original = environment.promos;
  (environment as { promos: unknown }).promos = rules;
  try {
    return run();
  } finally {
    (environment as { promos: unknown }).promos = original;
  }
}

describe('PromoService', () => {
  let service: PromoService;

  beforeEach(() => {
    service = new PromoService();
  });

  it('sin promociones el descuento es solo el manual', () => {
    withPromos([], () => {
      const [result] = service.apply([line(2)], { 'product:p1': 30 });
      expect(result.discountAmount).toBe(30);
    });
  });

  it('3x2 descuenta las piezas gratis completas, no fracciones', () => {
    withPromos([{ type: 'nxm', buy: 3, pay: 2 }], () => {
      expect(service.apply([line(3)])[0].discountAmount).toBe(100);
      expect(service.apply([line(5)])[0].discountAmount).toBe(100);
      expect(service.apply([line(6)])[0].discountAmount).toBe(200);
      expect(service.apply([line(2)])[0].discountAmount).toBe(0);
    });
  });

  it('ignora reglas nxm imposibles (pagar igual o más de lo que se lleva)', () => {
    withPromos([{ type: 'nxm', buy: 3, pay: 3 }, { type: 'nxm', buy: 0, pay: 0 }], () => {
      expect(service.apply([line(9)])[0].discountAmount).toBe(0);
    });
  });

  it('el porcentaje aplica solo a partir de la cantidad mínima', () => {
    withPromos([{ type: 'percent', percent: 10, minQty: 3 }], () => {
      expect(service.apply([line(2)])[0].discountAmount).toBe(0);
      expect(service.apply([line(3)])[0].discountAmount).toBe(30);
    });
  });

  it('entre varias promos aplicables gana la de mayor descuento', () => {
    withPromos(
      [
        { type: 'percent', percent: 10, minQty: 1 },
        { type: 'nxm', buy: 3, pay: 2 },
      ],
      () => {
        // 3 piezas: 10% = 30, 3x2 = 100 → manda la mayor.
        expect(service.apply([line(3)])[0].discountAmount).toBe(100);
      },
    );
  });

  it('la promo se restringe por sku o productId cuando la regla los declara', () => {
    withPromos([{ type: 'percent', percent: 50, minQty: 1, skus: ['OTRO'] }], () => {
      expect(service.apply([line(1)])[0].discountAmount).toBe(0);
    });
    withPromos([{ type: 'percent', percent: 50, minQty: 1, productIds: ['p1'] }], () => {
      expect(service.apply([line(1)])[0].discountAmount).toBe(50);
    });
  });

  it('el descuento nunca supera el importe de la partida: regalar de más descuadra la caja', () => {
    withPromos([{ type: 'percent', percent: 80, minQty: 1 }], () => {
      const [result] = service.apply([line(1)], { 'product:p1': 500 });
      expect(result.discountAmount).toBe(100);
    });
  });

  it('ignora un descuento manual negativo', () => {
    withPromos([], () => {
      expect(service.apply([line(1)], { 'product:p1': -20 })[0].discountAmount).toBe(0);
    });
  });

  it('promoOnlyDiscount excluye el descuento manual', () => {
    withPromos([{ type: 'percent', percent: 10, minQty: 1 }], () => {
      expect(service.promoOnlyDiscount(line(1))).toBe(10);
    });
  });
});
