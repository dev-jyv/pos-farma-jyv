import { describe, expect, it } from 'vitest';

import { daysUntilExpiryLocal, expiryYmd, isExpiredLocal, zonedTodayYmd } from './expiry';

/** Caducidad como la guardan servidor y caja: medianoche UTC del día indicado. */
const CADUCA_6_NOV = new Date('2026-11-06T00:00:00Z');

describe('caducidad por día de México (SPEC 57)', () => {
  it('hoy se mide en America/Mexico_City, no en UTC ni en la zona del equipo', () => {
    // 2026-11-06 20:00 en México ya es 7 de noviembre en UTC.
    expect(zonedTodayYmd(new Date('2026-11-07T02:00:00Z'))).toBe('2026-11-06');
  });

  it('un lote con caducidad de hoy, a las 20:00 hora de México, no está caducado', () => {
    expect(isExpiredLocal(CADUCA_6_NOV, new Date('2026-11-07T02:00:00Z'))).toBe(false);
    // Ni a las 23:59 de ese día.
    expect(isExpiredLocal(CADUCA_6_NOV, new Date('2026-11-07T05:59:00Z'))).toBe(false);
  });

  it('desde las 18:00 de la víspera tampoco (el error de comparar contra la hora local)', () => {
    expect(isExpiredLocal(CADUCA_6_NOV, new Date('2026-11-06T00:30:00Z'))).toBe(false);
  });

  it('caduca al empezar el día siguiente en México', () => {
    expect(isExpiredLocal(CADUCA_6_NOV, new Date('2026-11-07T06:00:00Z'))).toBe(true);
  });

  it('acepta Date, ISO y YYYY-MM-DD; sin fecha no caduca', () => {
    expect(expiryYmd('2026-11-06')).toBe('2026-11-06');
    expect(expiryYmd('2026-11-06T00:00:00.000Z')).toBe('2026-11-06');
    expect(expiryYmd(CADUCA_6_NOV)).toBe('2026-11-06');
    expect(isExpiredLocal(null)).toBe(false);
    expect(isExpiredLocal('')).toBe(false);
  });

  it('los días al aviso de próxima caducidad se cuentan por día de México', () => {
    const noche = new Date('2026-11-07T02:00:00Z'); // 6 nov, 20:00 México
    expect(daysUntilExpiryLocal(CADUCA_6_NOV, noche)).toBe(0);
    expect(daysUntilExpiryLocal(new Date('2026-11-10T00:00:00Z'), noche)).toBe(4);
    expect(daysUntilExpiryLocal(new Date('2026-11-05T00:00:00Z'), noche)).toBe(-1);
    expect(daysUntilExpiryLocal(null, noche)).toBeNull();
  });
});
