/**
 * Caducidad por fecha local de la farmacia (SPEC 57) — espejo de
 * `src/app/shared/utils/expiry.ts` y de `isExpired` en
 * `functions/src/utils/fefo.ts` del backend. Cambiar uno es cambiar los tres.
 *
 * La caducidad se guarda como medianoche UTC del día indicado y el lote se vende
 * todo ese día: se comparan fechas Y-M-D (la de la caducidad contra la de hoy en
 * `America/Mexico_City`), nunca instantes contra `Date.now()`, que la daba por
 * caducada desde las 18:00 de la víspera.
 */

const EXPIRY_TIME_ZONE = 'America/Mexico_City';
const YMD = /^\d{4}-\d{2}-\d{2}/;

function zonedTodayYmd(now = new Date(), timeZone = EXPIRY_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(typeof now === 'number' ? new Date(now) : now);
}

function expiryYmd(expiryDate) {
  if (expiryDate === null || expiryDate === undefined || expiryDate === '') return null;
  if (typeof expiryDate === 'string' && YMD.test(expiryDate)) return expiryDate.slice(0, 10);
  const date = expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isExpiredLocal(expiryDate, now = new Date()) {
  const ymd = expiryYmd(expiryDate);
  return ymd !== null && ymd < zonedTodayYmd(now);
}

function ymdToUtcMs(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysUntilExpiryLocal(expiryDate, now = new Date()) {
  const ymd = expiryYmd(expiryDate);
  if (ymd === null) return null;
  return Math.round((ymdToUtcMs(ymd) - ymdToUtcMs(zonedTodayYmd(now))) / 86_400_000);
}

module.exports = {
  EXPIRY_TIME_ZONE,
  zonedTodayYmd,
  expiryYmd,
  isExpiredLocal,
  daysUntilExpiryLocal,
};
