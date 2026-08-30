import { describe, expect, it } from 'vitest';

import {
  endOfZonedDay,
  startOfZonedDay,
  validateDateRange,
  zoneOffset,
  zonedYmd,
} from './date-range';

describe('zoneOffset', () => {
  it('devuelve el offset de Ciudad de México', () => {
    // México suprimió el horario de verano en 2022: −06:00 todo el año.
    expect(zoneOffset(new Date('2026-01-15T12:00:00Z'))).toBe('-06:00');
    expect(zoneOffset(new Date('2026-07-15T12:00:00Z'))).toBe('-06:00');
  });

  it('devuelve +00:00 en UTC', () => {
    expect(zoneOffset(new Date('2026-07-15T12:00:00Z'), 'UTC')).toBe('+00:00');
  });
});

describe('startOfZonedDay / endOfZonedDay', () => {
  it('marca los extremos del día local con offset explícito', () => {
    expect(startOfZonedDay('2026-08-07')).toBe('2026-08-07T00:00:00.000-06:00');
    expect(endOfZonedDay('2026-08-07')).toBe('2026-08-07T23:59:59.999-06:00');
  });

  it('produce instantes que cubren exactamente el día local, no el de UTC', () => {
    const start = new Date(startOfZonedDay('2026-08-07')).getTime();
    const end = new Date(endOfZonedDay('2026-08-07')).getTime();

    // 24 h menos el milisegundo final.
    expect(end - start).toBe(24 * 60 * 60 * 1000 - 1);

    // El bug que esto corrige: la fecha pelada arrancaba 6 h antes, así que
    // entraban movimientos de la tarde del día anterior.
    expect(start).toBeGreaterThan(Date.parse('2026-08-07T00:00:00Z'));
    expect(start).toBe(Date.parse('2026-08-07T06:00:00Z'));

    // ...y se perdía la tarde del último día.
    expect(end).toBeGreaterThan(Date.parse('2026-08-07T23:59:59.999Z'));
  });

  it('un rango de varios días no deja huecos entre extremos consecutivos', () => {
    const endOfFirst = new Date(endOfZonedDay('2026-08-07')).getTime();
    const startOfSecond = new Date(startOfZonedDay('2026-08-08')).getTime();
    expect(startOfSecond - endOfFirst).toBe(1);
  });
});

describe('zonedYmd', () => {
  it('usa el día de la farmacia, no el del navegador', () => {
    // 03:00 UTC del día 8 son las 21:00 del día 7 en Ciudad de México.
    expect(zonedYmd(new Date('2026-08-08T03:00:00Z'))).toBe('2026-08-07');
  });
});

describe('validateDateRange', () => {
  it('acepta un rango bien formado', () => {
    expect(validateDateRange('2026-08-01', '2026-08-07')).toBeNull();
    expect(validateDateRange('2026-08-07', '2026-08-07')).toBeNull();
  });

  it('exige ambos extremos', () => {
    expect(validateDateRange('', '2026-08-07')?.field).toBe('from');
    expect(validateDateRange('2026-08-07', '')?.field).toBe('to');
  });

  it('rechaza un rango invertido', () => {
    // Devolvía 0 renglones, indistinguible de un periodo sin movimientos.
    expect(validateDateRange('2026-08-31', '2026-08-01')?.field).toBe('range');
  });
});
