/**
 * Expiración de sesión — espejo de `functions/src/utils/session.ts`.
 *
 * El backend rechaza cualquier token cuyo `auth_time` sea de un día anterior en
 * hora de Ciudad de México: la sesión muere a las 24:00 locales, no a las 24 h
 * de haber entrado. El POS replica el cálculo para avisar y cerrar sesión de
 * forma ordenada (guardando el ticket) en vez de descubrirlo con un 401 a media
 * venta.
 */

export const SESSION_TIME_ZONE = 'America/Mexico_City';

function zonedYmd(ms: number, timeZone = SESSION_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function addOneDayYmd(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Instante UTC del inicio del día `ymd` en la zona dada. Búsqueda binaria (±14 h)
 * como en el backend: evita hardcodear el offset y sobrevive al horario de verano.
 */
function zonedStartOfDayMs(ymd: string, timeZone = SESSION_TIME_ZONE): number {
  let low = Date.parse(`${ymd}T00:00:00Z`) - 14 * 3600 * 1000;
  let high = Date.parse(`${ymd}T00:00:00Z`) + 14 * 3600 * 1000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (zonedYmd(middle, timeZone) < ymd) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Milisegundos UTC en los que el backend empieza a rechazar el token. */
export function getSessionExpiryMs(authTimeMs: number): number {
  return zonedStartOfDayMs(addOneDayYmd(zonedYmd(authTimeMs)));
}

export function isSessionExpired(authTimeMs: number, nowMs = Date.now()): boolean {
  return nowMs >= getSessionExpiryMs(authTimeMs);
}
