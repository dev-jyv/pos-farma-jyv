import { HttpErrorResponse } from '@angular/common/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CartLine, CartProductLine, Product, PromotionDto } from '../../../shared/models';
import { PromoService, closedPromotionFromError } from './promo.service';

const DAY = 24 * 60 * 60 * 1000;

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'local-1',
    remoteId: 'p1',
    sku: 'PAR-500',
    name: 'Paracetamol',
    salePrice: 35,
    stock: 10,
    ...overrides,
  } as Product;
}

function line(quantity: number, overrides: Partial<Product> = {}): CartProductLine {
  return { kind: 'product', product: product(overrides), quantity, discountAmount: 0 };
}

function promotion(overrides: Partial<PromotionDto> = {}): PromotionDto {
  return {
    id: 'promo-1',
    name: 'Paracetamol 2x$60',
    rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
    productIds: ['p1'],
    startsAt: new Date(Date.now() - DAY).toISOString(),
    endsAt: null,
    isActive: true,
    ...overrides,
  };
}

describe('PromoService', () => {
  let service: PromoService;

  beforeEach(() => {
    service = new PromoService();
    service.setPromotions([promotion()]);
  });

  it('paracetamol: 1 = $35, 2 = $60, 3 = $95', () => {
    const cobrado = (qty: number) => {
      const [result] = service.apply([line(qty)]) as CartProductLine[];
      return qty * 35 - result.discountAmount;
    };
    expect(cobrado(1)).toBe(35);
    expect(cobrado(2)).toBe(60);
    expect(cobrado(3)).toBe(95);
  });

  it('marca la partida con la promo aplicada y su parte del descuento', () => {
    const [result] = service.apply([line(2)]) as CartProductLine[];
    expect(result.promotion).toEqual({
      id: 'promo-1',
      name: 'Paracetamol 2x$60',
      discountAmount: 10,
    });
    expect(service.apply([line(1)])[0]).toMatchObject({ promotion: null });
  });

  it('una línea en promoción ignora el descuento manual; sin promo vuelve a contar', () => {
    expect(service.apply([line(2)], { 'product:local-1': 5 })[0].discountAmount).toBe(10);
    // 1 pieza no llega al paquete: el manual guardado aplica.
    expect(service.apply([line(1)], { 'product:local-1': 5 })[0].discountAmount).toBe(5);
    expect(service.apply([line(1)], { 'product:local-1': 500 })[0].discountAmount).toBe(35);
  });

  it('compara contra el id remoto; un producto sin sincronizar no entra', () => {
    expect(service.promoOnlyDiscount(line(2, { remoteId: 'otro' }))).toBe(0);
    expect(service.promoOnlyDiscount(line(2, { id: 'p1', remoteId: undefined }))).toBe(10);
  });

  it('una promo programada empieza a aplicar sola al llegar su hora', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-25T07:59:00Z'));
      service.setPromotions([promotion({ startsAt: '2026-09-25T08:00:00Z' })]);
      expect(service.promoOnlyDiscount(line(2))).toBe(0);

      vi.setSystemTime(new Date('2026-09-25T08:00:00Z'));
      expect(service.promoOnlyDiscount(line(2))).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignora promociones programadas o vencidas', () => {
    service.setPromotions([
      promotion({ startsAt: new Date(Date.now() + DAY).toISOString() }),
      promotion({ id: 'promo-2', endsAt: new Date(Date.now() - 1000).toISOString() }),
    ]);
    expect(service.promoOnlyDiscount(line(2))).toBe(0);
  });

  it('entre varias gana la de mayor descuento, sin acumular', () => {
    service.setPromotions([
      promotion(),
      promotion({ id: 'promo-2', name: '2x1', rule: { type: 'nxm', buy: 2, pay: 1 } }),
    ]);
    const [result] = service.apply([line(2)]) as CartProductLine[];
    expect(result.promotion?.id).toBe('promo-2');
    expect(result.discountAmount).toBe(35);
  });

  it('los servicios nunca entran a una promoción', () => {
    const servicio = {
      kind: 'service',
      service: { id: 'p1', price: 35 },
      provider: null,
      quantity: 2,
      discountAmount: 0,
    } as unknown as CartLine;
    expect(service.promoOnlyDiscount(servicio)).toBe(0);
  });

  it('una lectura vieja que termina tarde no pisa a la más reciente', async () => {
    let resolverVieja!: (rows: PromotionDto[]) => void;
    let resolverNueva!: (rows: PromotionDto[]) => void;
    const listActive = vi
      .fn()
      .mockImplementationOnce(() => new Promise<PromotionDto[]>((r) => (resolverVieja = r)))
      .mockImplementationOnce(() => new Promise<PromotionDto[]>((r) => (resolverNueva = r)));
    const w = window as unknown as { electronAPI?: unknown };
    w.electronAPI = { promotions: { listActive } };
    try {
      const vieja = service.reload(); // la del arranque
      const nueva = service.reload(); // la que dispara el sync, ya con la baja
      resolverNueva([]);
      await nueva;
      resolverVieja([promotion()]);
      await vieja;
    } finally {
      delete w.electronAPI;
    }
    expect(service.promoOnlyDiscount(line(2))).toBe(0);
  });

  it('una promo con regla que esta versión no conoce no rompe el ticket', () => {
    service.setPromotions([
      promotion({ id: 'nueva', rule: { type: 'bundle', items: [] } as never }),
      promotion({ id: 'buena' }),
    ]);
    let result: CartProductLine[] = [];
    expect(() => (result = service.apply([line(2)]) as CartProductLine[])).not.toThrow();
    // La desconocida se ignora y la válida sigue aplicando.
    expect(result[0].promotion?.id).toBe('buena');
    expect(result[0].discountAmount).toBe(10);
  });
});

/**
 * "Lleva 1 más": el menor k de piezas extra con el que el cliente paga menos por
 * pieza de lo que ya paga. No se ofrece repetir un paquete ya completo ni una
 * pieza más de un porcentaje que ya aplica: eso no es una mejora.
 */
describe('PromoService.nextStepHint', () => {
  let service: PromoService;
  const a10 = (qty: number) => line(qty, { salePrice: 10 });

  beforeEach(() => {
    service = new PromoService();
  });

  it('tiered 2x$17: con 1 sugiere llevar 1 más; con 2 nada; con 3 otra vez', () => {
    service.setPromotions([promotion({ rule: { type: 'tiered', tiers: [{ quantity: 2, price: 17 }] } })]);
    expect(service.nextStepHint(a10(1))).toEqual({ extraQty: 1, totalForAll: 17, savings: 3 });
    expect(service.nextStepHint(a10(2))).toBeNull();
    expect(service.nextStepHint(a10(3))).toEqual({ extraQty: 1, totalForAll: 34, savings: 6 });
  });

  it('nxm 3x2: con 1 hacen falta 2 más; con el paquete completo no sugiere repetirlo', () => {
    service.setPromotions([promotion({ rule: { type: 'nxm', buy: 3, pay: 2 } })]);
    expect(service.nextStepHint(a10(1))).toEqual({ extraQty: 2, totalForAll: 20, savings: 10 });
    expect(service.nextStepHint(a10(2))).toEqual({ extraQty: 1, totalForAll: 20, savings: 10 });
    expect(service.nextStepHint(a10(3))).toBeNull();
  });

  it('percent 10 % desde 3: sugiere llegar al mínimo, y ya en él no insiste', () => {
    service.setPromotions([promotion({ rule: { type: 'percent', percent: 10, minQty: 3 } })]);
    expect(service.nextStepHint(a10(1))).toEqual({ extraQty: 2, totalForAll: 27, savings: 3 });
    expect(service.nextStepHint(a10(2))).toEqual({ extraQty: 1, totalForAll: 27, savings: 3 });
    expect(service.nextStepHint(a10(3))).toBeNull();
    expect(service.nextStepHint(a10(7))).toBeNull();
  });

  it('con varias promos usa la mejor en cada cantidad, igual que apply', () => {
    service.setPromotions([
      promotion({ id: 'pct', rule: { type: 'percent', percent: 10, minQty: 1 } }),
      promotion({ id: 'nxm', rule: { type: 'nxm', buy: 2, pay: 1 } }),
    ]);
    // 1 pieza: 10 % ($9). 2 piezas: 2x1 ($10) — la pieza extra cuesta $1.
    expect(service.nextStepHint(a10(1))).toEqual({ extraQty: 1, totalForAll: 10, savings: 10 });
  });

  it('sin promo, con una regla desconocida, vencida o de servicio no sugiere nada', () => {
    expect(service.nextStepHint(a10(1))).toBeNull();
    service.setPromotions([promotion({ rule: { type: 'bundle' } as never })]);
    expect(service.nextStepHint(a10(1))).toBeNull();
    service.setPromotions([promotion({ endsAt: new Date(Date.now() - 1000).toISOString() })]);
    expect(service.nextStepHint(a10(1))).toBeNull();
    service.setPromotions([promotion()]);
    const servicio = {
      kind: 'service',
      service: { id: 'p1', price: 35 },
      provider: null,
      quantity: 1,
      discountAmount: 0,
    } as unknown as CartLine;
    expect(service.nextStepHint(servicio)).toBeNull();
  });

  it('es pura: no toca el carrito ni la promo aplicada', () => {
    service.setPromotions([promotion()]);
    const partida = line(1);
    const antes = structuredClone(partida);
    service.nextStepHint(partida);
    expect(partida).toEqual(antes);
  });
});

describe('PromoService.hasPromotion', () => {
  let service: PromoService;

  beforeEach(() => {
    service = new PromoService();
  });

  it('marca el producto con una promo vigente, por su id remoto', () => {
    service.setPromotions([promotion()]);
    expect(service.hasPromotion(product())).toBe(true);
    expect(service.hasPromotion(product({ remoteId: 'otro' }))).toBe(false);
  });

  it('no marca promos programadas, vencidas o con regla desconocida', () => {
    service.setPromotions([
      promotion({ startsAt: new Date(Date.now() + DAY).toISOString() }),
      promotion({ id: 'b', endsAt: new Date(Date.now() - 1000).toISOString() }),
      promotion({ id: 'c', rule: { type: 'bundle' } as never }),
    ]);
    expect(service.hasPromotion(product())).toBe(false);
  });
});

describe('PromoService.findClosedPromotion', () => {
  let service: PromoService;

  beforeEach(() => {
    service = new PromoService();
    service.setPromotions([promotion()]);
  });

  it('nada que reportar mientras la promo aplicada siga vigente', () => {
    const lines = service.apply([line(2)]);
    expect(service.findClosedPromotion(lines)).toBeNull();
  });

  it('reporta la promo aplicada que el pull dio de baja', () => {
    const lines = service.apply([line(2)]);
    service.setPromotions([]);
    expect(service.findClosedPromotion(lines)).toBe('Paracetamol 2x$60');
  });

  it('reporta la que venció con el cobro abierto', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
      service.setPromotions([promotion({ startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-25T10:05:00Z' })]);
      const lines = service.apply([line(2)]);
      vi.setSystemTime(new Date('2026-09-25T10:06:00Z'));
      expect(service.findClosedPromotion(lines)).toBe('Paracetamol 2x$60');
    } finally {
      vi.useRealTimers();
    }
  });

  it('que ahora gane otra promo no es una promo cerrada', () => {
    const lines = service.apply([line(2)]);
    service.setPromotions([
      promotion(),
      promotion({ id: 'promo-2', name: '2x1', rule: { type: 'nxm', buy: 2, pay: 1 } }),
    ]);
    expect(service.findClosedPromotion(lines)).toBeNull();
  });
});

describe('closedPromotionFromError', () => {
  const rechazo = (status: number, message: string) =>
    new HttpErrorResponse({ status, error: { error: { message } } });

  it('reconoce el 400 del backend y devuelve el nombre de la promo', () => {
    expect(closedPromotionFromError(rechazo(400, 'La promoción "Paracetamol 2x$60" no está vigente'))).toBe(
      'Paracetamol 2x$60',
    );
  });

  it('ignora otros errores y otros códigos', () => {
    expect(closedPromotionFromError(rechazo(400, 'Stock insuficiente'))).toBeNull();
    expect(closedPromotionFromError(rechazo(500, 'La promoción "X" no está vigente'))).toBeNull();
    expect(closedPromotionFromError(new Error('sin red'))).toBeNull();
  });
});
