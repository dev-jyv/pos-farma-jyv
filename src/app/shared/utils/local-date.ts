/**
 * Hoy como `YYYY-MM-DD` en la zona del equipo.
 *
 * `toISOString()` da la fecha en UTC: entre ~18:00 y medianoche hora de México
 * (UTC-6) eso adelanta el día al siguiente, y una caducidad de hoy se rechazaba
 * como "en el pasado". Se arma con los componentes locales de `Date`.
 */
export function todayLocalDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
