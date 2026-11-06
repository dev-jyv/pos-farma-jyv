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
 * equivocado. Desde SPEC 49 manda primero el código estable del servidor que la
 * caja deja al final del motivo; el texto es el fallback de backends viejos.
 */

/** Orden importa: el primero que coincide gana. */
const PATRONES = [
  ['entrada-a-medias', /qued[oó] a medio registrar/i],
  ['turno-duplicado', /turno remoto .* ya pertenece a otro turno/i],
  ['turno-abierto-existente', /ya tienes un turno de caja abierto/i],
  ['turno-ajeno', /solo el cajero que abri[oó] el turno/i],
  ['turno-cerrado', /turno de caja ya est[aá] cerrado/i],
  ['turno-no-encontrado', /turno de caja no encontrado/i],
  ['producto-no-encontrado', /producto no encontrado/i],
  ['sin-stock', /stock insuficiente/i],
  ['promocion-no-vigente', /promoci[oó]n .* no est[aá] vigente/i],
];

/**
 * Código de sincronización del backend (SPEC 49) → código del panel. La caja lo
 * guarda al final del `pushError` (`… [STOCK_INSUFFICIENT]`, ver
 * `core/sync/sync-error-codes.ts#withSyncCode`). Los que no están aquí caen al
 * clasificador por texto.
 */
const POR_CODIGO = {
  STOCK_INSUFFICIENT: 'sin-stock',
  BATCH_EXPIRED: 'sin-stock',
  PRODUCT_NOT_FOUND: 'producto-no-encontrado',
  SESSION_CLOSED: 'turno-cerrado',
  SESSION_FORBIDDEN: 'turno-ajeno',
  ENTRY_IN_PROGRESS: 'entrada-en-curso',
  ENTRY_AMBIGUOUS: 'entrada-a-medias',
  // SPEC 56: el PATCH de la caja chocó con un cambio de precio o estado del panel.
  CATALOG_CONFLICT: 'catalogo-en-conflicto',
};

const ETIQUETA_DE_CODIGO = /\[([A-Z][A-Z_]*)\]\s*$/;

/** Código de sincronización al final del motivo, o `null` si no lo trae (backend viejo). */
function syncCodeFromReason(reason) {
  const match = ETIQUETA_DE_CODIGO.exec(String(reason ?? ''));
  return match ? match[1] : null;
}

/** Código para un motivo de rechazo; primero por su código de servidor, luego por texto. */
function codeFromReason(reason) {
  const syncCode = syncCodeFromReason(reason);
  if (syncCode && POR_CODIGO[syncCode]) {
    return POR_CODIGO[syncCode];
  }
  const texto = String(reason ?? '');
  for (const [code, patron] of PATRONES) {
    if (patron.test(texto)) {
      return code;
    }
  }
  return 'desconocido';
}

/** Diagnóstico completo de un motivo: `{ code }`, más `syncCode` si el servidor lo mandó. */
function diagnoseReason(reason) {
  const syncCode = syncCodeFromReason(reason);
  return syncCode ? { code: codeFromReason(reason), syncCode } : { code: codeFromReason(reason) };
}

module.exports = { codeFromReason, diagnoseReason, syncCodeFromReason };
