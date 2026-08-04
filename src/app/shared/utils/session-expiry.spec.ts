import { describe, expect, it } from 'vitest';

import { getSessionExpiryMs, isSessionExpired } from './session-expiry';

/** 2026-08-04 15:30 CDMX (UTC-6 en horario de verano) = 21:30 UTC. */
const AUTH_TIME = Date.parse('2026-08-04T21:30:00Z');

describe('getSessionExpiryMs', () => {
  it('expira a las 00:00 del día siguiente en hora del centro', () => {
    // 2026-08-05T00:00 CDMX = 2026-08-05T06:00Z
    expect(getSessionExpiryMs(AUTH_TIME)).toBe(Date.parse('2026-08-05T06:00:00Z'));
  });

  it('un login pasada la medianoche UTC pero antes en CDMX sigue siendo del mismo día local', () => {
    // 2026-08-05T01:00Z = 2026-08-04T19:00 CDMX → expira igual que AUTH_TIME.
    expect(getSessionExpiryMs(Date.parse('2026-08-05T01:00:00Z'))).toBe(
      getSessionExpiryMs(AUTH_TIME),
    );
  });

  it('no expira antes del corte y sí después', () => {
    expect(isSessionExpired(AUTH_TIME, Date.parse('2026-08-05T05:59:00Z'))).toBe(false);
    expect(isSessionExpired(AUTH_TIME, Date.parse('2026-08-05T06:00:00Z'))).toBe(true);
  });
});
