/**
 * Fechas que llegan del backend.
 *
 * Firestore serializa `Timestamp` sobre HTTP como `{_seconds, _nanoseconds}`,
 * no como ISO. `new Date(objeto)` con esa forma devuelve `Invalid Date`, y
 * Prisma rechaza la escritura entera: el pull del catálogo se caía completo por
 * una fecha. Mismo criterio que `toDate()` en `core/api/api.utils.ts`.
 */
function toDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'object' && '_seconds' in value) {
    const parsed = new Date(value._seconds * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Igual que `toDate`, pero nunca `null`: para columnas obligatorias como
 * `updatedAt`, donde una fecha ilegible no debe tirar el pull. Se cae a "ahora",
 * que es cuando de verdad se escribió la fila en este equipo.
 */
function toDateOrNow(value) {
  return toDate(value) ?? new Date();
}

module.exports = { toDate, toDateOrNow };
