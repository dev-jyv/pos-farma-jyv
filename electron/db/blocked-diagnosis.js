/**
 * Diagnóstico de los registros del panel "Rechazados al sincronizar".
 *
 * El panel mostraba el `pushError` crudo y el cajero no sabía qué hacer con él:
 * "Turno de caja no encontrado" o "ya lleva demasiados intentos" no dicen si hay
 * que sincronizar, reintentar, corregir o llamar al admin. Aquí se traduce el
 * motivo a un código estable; el texto y las acciones de cada código viven en
 * Angular (`core/sync/sync-diagnosis.ts`).
 *
 * Funciona **sin red** a propósito: buena parte de estos bloqueos pasa justo
 * cuando la caja no tiene conexión.
 *
 * Los patrones siguen los textos reales del backend (`badRequest(...)` en
 * `sales.service.ts`, `assertCanAccessSession`, `${resource} no encontrado`) y
 * los que pone la propia caja (`markCreateSynced` en cash-sessions). Si el
 * backend cambia un mensaje, el registro cae en `desconocido`, no en un código
 * equivocado.
 */

/** Orden importa: el primero que coincide gana. */
const PATRONES = [
  ['turno-duplicado', /turno remoto .* ya pertenece a otro turno/i],
  ['turno-abierto-existente', /ya tienes un turno de caja abierto/i],
  ['turno-ajeno', /solo el cajero que abri[oó] el turno/i],
  ['turno-cerrado', /turno de caja ya est[aá] cerrado/i],
  ['turno-no-encontrado', /turno de caja no encontrado/i],
  ['producto-no-encontrado', /producto no encontrado/i],
  ['sin-stock', /stock insuficiente/i],
  ['promocion-no-vigente', /promoci[oó]n .* no est[aá] vigente/i],
];

/** Código para un motivo de rechazo en texto; `desconocido` si no se reconoce. */
function codeFromReason(reason) {
  const texto = String(reason ?? '');
  for (const [code, patron] of PATRONES) {
    if (patron.test(texto)) {
      return code;
    }
  }
  return 'desconocido';
}

module.exports = { codeFromReason };
