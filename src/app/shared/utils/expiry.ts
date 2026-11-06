/**
 * Caducidad por fecha local de la farmacia (SPEC 57) — espejo de
 * `electron/db/expiry.js` y de `isExpired` en `functions/src/utils/fefo.ts` del
 * backend. Cambiar uno es cambiar los tres.
 *
 * La caducidad se guarda como medianoche UTC del día indicado (`2026-11-06` →
 * `2026-11-06T00:00:00Z`) y el lote se vende **todo ese día**. Compararla contra
 * el reloj local la daba por caducada desde las 18:00 del día anterior en México
 * (UTC-6): esa medianoche UTC es la tarde de la víspera. Aquí se comparan fechas
 * Y-M-D: la de la caducidad (su día calendario guardado) contra la de hoy en
 * `America/Mexico_City`, igual que el servidor.
 */

export const EXPIRY_TIME_ZONE = 'America/Mexico_City';

const YMD = /^\d{4}-\d{2}-\d{2}/;

/** Hoy (o `now`) como `YYYY-MM-DD` en la zona de la farmacia. */
export function zonedTodayYmd(now: Date | number = new Date(), timeZone = EXPIRY_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(typeof now === 'number' ? new Date(now) : now);
}

/**
 * Día calendario de una caducidad. Un `Date` se lee en UTC: así se guardó
 * (medianoche UTC). Una medianoche local de México (06:00 UTC) da el mismo día,
 * así que la lectura no depende de quién la escribió. `null` si no hay fecha.
 */
export function expiryYmd(expiryDate: Date | string | null | undefined): string | null {
  if (expiryDate === null || expiryDate === undefined || expiryDate === '') {
    return null;
  }
  if (typeof expiryDate === 'string' && YMD.test(expiryDate)) {
    return expiryDate.slice(0, 10);
  }
  const date = expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** `true` si el lote ya caducó: su día es anterior a hoy en México. Sin fecha, no caduca. */
export function isExpiredLocal(
  expiryDate: Date | string | null | undefined,
  now: Date | number = new Date(),
): boolean {
  const ymd = expiryYmd(expiryDate);
  return ymd !== null && ymd < zonedTodayYmd(now);
}

function ymdToUtcMs(ymd: string): number {
  const [year, month, day] = ymd.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Días de hoy (México) a la caducidad: 0 = caduca hoy, negativo = ya caducó.
 * `null` sin fecha. Es la cuenta del aviso de próxima caducidad.
 */
export function daysUntilExpiryLocal(
  expiryDate: Date | string | null | undefined,
  now: Date | number = new Date(),
): number | null {
  const ymd = expiryYmd(expiryDate);
  if (ymd === null) {
    return null;
  }
  return Math.round((ymdToUtcMs(ymd) - ymdToUtcMs(zonedTodayYmd(now))) / 86_400_000);
}
