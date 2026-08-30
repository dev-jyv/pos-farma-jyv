import { describe, expect, it } from 'vitest';

import {
  addMoney,
  compareMoney,
  fromCents,
  isMoneyGreaterOrEqual,
  roundMoney,
  subtractMoney,
  toCents,
} from './money';

describe('money', () => {
  describe('toCents', () => {
    it('redondea a centavo entero', () => {
      expect(toCents(10.005)).toBe(1001);
      expect(toCents(10.004)).toBe(1000);
    });

    it('trata los no finitos como cero en vez de propagar NaN a la caja', () => {
      expect(toCents(Number.NaN)).toBe(0);
      expect(toCents(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('redondea negativos hacia arriba, igual que Math.round', () => {
      expect(toCents(-10.555)).toBe(-1055);
    });
  });

  it('fromCents devuelve pesos con dos decimales', () => {
    expect(fromCents(1234)).toBe(12.34);
    expect(fromCents(1234.6)).toBe(12.35);
  });

  describe('roundMoney', () => {
    it('elimina el residuo binario de la suma flotante', () => {
      expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    });

    it('deja intacto un importe ya redondeado', () => {
      expect(roundMoney(99.99)).toBe(99.99);
    });
  });

  describe('addMoney', () => {
    it('suma en centavos y no arrastra error flotante', () => {
      expect(addMoney(0.1, 0.2)).toBe(0.3);
      expect(addMoney(19.99, 0.01, 5)).toBe(25);
    });

    it('sin sumandos devuelve cero', () => {
      expect(addMoney()).toBe(0);
    });
  });

  it('subtractMoney resta en centavos', () => {
    expect(subtractMoney(0.3, 0.1)).toBe(0.2);
    expect(subtractMoney(10, 10.005)).toBe(-0.01);
  });

  describe('compareMoney', () => {
    it('considera iguales dos importes que solo difieren por residuo binario', () => {
      expect(compareMoney(0.1 + 0.2, 0.3)).toBe(0);
    });

    it('devuelve el signo de la diferencia', () => {
      expect(compareMoney(10, 9.99)).toBe(1);
      expect(compareMoney(9.99, 10)).toBe(-1);
    });
  });

  describe('isMoneyGreaterOrEqual', () => {
    it('acepta el pago exacto aunque venga de una suma flotante', () => {
      expect(isMoneyGreaterOrEqual(0.1 + 0.2, 0.3)).toBe(true);
    });

    it('rechaza un centavo de menos', () => {
      expect(isMoneyGreaterOrEqual(9.99, 10)).toBe(false);
    });
  });
});
