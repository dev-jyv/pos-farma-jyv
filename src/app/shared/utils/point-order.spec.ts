import { describe, expect, it } from 'vitest';

import { POINT_ORDER_TTL_SECONDS, formatCountdown, pointOrderSecondsLeft } from './point-order';

describe('pointOrderSecondsLeft', () => {
  const start = Date.parse('2026-08-08T10:00:00.000Z');

  it('sin orden en curso no hay cuenta atrás', () => {
    expect(pointOrderSecondsLeft(null, start)).toBeNull();
  });

  it('arranca en la vigencia completa', () => {
    expect(pointOrderSecondsLeft(start, start)).toBe(POINT_ORDER_TTL_SECONDS);
  });

  it('descuenta el tiempo transcurrido', () => {
    expect(pointOrderSecondsLeft(start, start + 60_000)).toBe(POINT_ORDER_TTL_SECONDS - 60);
  });

  it('no baja de cero aunque la orden lleve vencida un rato', () => {
    expect(pointOrderSecondsLeft(start, start + 30 * 60_000)).toBe(0);
  });
});

describe('formatCountdown', () => {
  it('pinta minutos y segundos con dos dígitos', () => {
    expect(formatCountdown(900)).toBe('15:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('sin cuenta atrás no pinta nada', () => {
    expect(formatCountdown(null)).toBeNull();
  });
});
