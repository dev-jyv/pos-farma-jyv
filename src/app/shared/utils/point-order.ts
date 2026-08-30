/**
 * Vigencia de una orden en la terminal Point.
 *
 * El backend crea la orden con `expiration_time: PT15M`. Sin esta cuenta atrás en
 * pantalla, el cajero solo veía que la terminal "dejaba de responder" y volvía a
 * mandar el cobro sin saber que el anterior había vencido.
 */

/** Debe coincidir con `POINT_ORDER_EXPIRATION` del backend. */
export const POINT_ORDER_TTL_SECONDS = 15 * 60;

/** Segundos que le quedan a la orden, o `null` si no hay una en curso. */
export function pointOrderSecondsLeft(startedAtMs: number | null, nowMs: number): number | null {
  if (startedAtMs === null) {
    return null;
  }
  const elapsed = Math.floor((nowMs - startedAtMs) / 1000);
  return Math.max(0, POINT_ORDER_TTL_SECONDS - elapsed);
}

/** `m:ss` para pintar la cuenta atrás; `null` cuando no hay orden viva. */
export function formatCountdown(secondsLeft: number | null): string | null {
  if (secondsLeft === null) {
    return null;
  }
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
