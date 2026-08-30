/**
 * Rangos de fecha para consultas al backend.
 *
 * El backend filtra por **instante** (`createdAt >= from`, `<= to`), no por día:
 * lo que reciba lo pasa por `new Date(...)`. Mandar una fecha pelada
 * (`2026-08-07`) la interpreta como medianoche **UTC**, que en Ciudad de México
 * son las 18:00 del día anterior; y mandar `2026-08-07T23:59:59.999` sin zona la
 * interpreta como hora local **del servidor**, que en Cloud Functions es UTC.
 *
 * El resultado es una ventana corrida ~6 h: entran movimientos de la tarde del
 * día anterior y se pierden los de la tarde del último día. En el libro de
 * control eso significa una hoja que no cuadra con el periodo que declara.
 *
 * Por eso el POS construye siempre los extremos con el **offset explícito** de
 * la zona de la farmacia, calculado con `Intl` para no hardcodear −06:00 (México
 * suprimió el horario de verano en 2022, pero el offset sigue siendo dato de la
 * zona, no una constante del negocio).
 */

export const POS_TIME_ZONE = 'America/Mexico_City';

/** Offset de la zona en el instante dado, con forma `+HH:MM` / `-HH:MM`. */
export function zoneOffset(at: Date, timeZone = POS_TIME_ZONE): string {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).format(at);
  // "8/7/2026, GMT-06:00" → "-06:00"; "GMT" pelado significa UTC.
  const match = formatted.match(/GMT([+-]\d{2}:\d{2})?/);
  return match?.[1] ?? '+00:00';
}

/** `YYYY-MM-DD` → inicio de ese día en la zona, como ISO con offset. */
export function startOfZonedDay(ymd: string, timeZone = POS_TIME_ZONE): string {
  return `${ymd}T00:00:00.000${zoneOffset(new Date(`${ymd}T12:00:00Z`), timeZone)}`;
}

/** `YYYY-MM-DD` → último instante de ese día en la zona, como ISO con offset. */
export function endOfZonedDay(ymd: string, timeZone = POS_TIME_ZONE): string {
  return `${ymd}T23:59:59.999${zoneOffset(new Date(`${ymd}T12:00:00Z`), timeZone)}`;
}

/** `YYYY-MM-DD` de una fecha en la zona de la farmacia (no en la del navegador). */
export function zonedYmd(at: Date, timeZone = POS_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export interface DateRangeError {
  field: 'from' | 'to' | 'range';
  message: string;
}

/**
 * Valida un rango capturado por el cajero. Un rango invertido o incompleto
 * devuelve 0 renglones sin distinguirse de "no hubo movimientos": en una hoja
 * que se firma, eso es una afirmación falsa.
 */
export function validateDateRange(from: string, to: string): DateRangeError | null {
  if (!from.trim()) {
    return { field: 'from', message: 'Captura la fecha inicial del periodo.' };
  }
  if (!to.trim()) {
    return { field: 'to', message: 'Captura la fecha final del periodo.' };
  }
  if (from > to) {
    return { field: 'range', message: 'La fecha inicial no puede ser posterior a la final.' };
  }
  return null;
}
