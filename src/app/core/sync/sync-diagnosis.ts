import { BlockedCode, BlockedSyncRecord } from '../electron/window.d';
import { SyncErrorCode, isSyncErrorCode } from '../../shared/models';

/** Qué conviene hacer primero. Nunca "descartar": puede ser dinero ya cobrado. */
export type BlockedAction = 'reintentar' | 'corregir' | 'avisar-admin';

export interface BlockedHelp {
  /** Llave de i18n (`sync.blocked.*`); la plantilla la traduce con `params`. */
  title: string;
  explanation: string;
  params?: Record<string, string>;
  recommended: BlockedAction;
}

/** Atajo para las entradas de `AYUDA`: llave base `sync.blocked.<clave>.{title,explanation}`. */
function ayuda(
  clave: string,
  recommended: BlockedAction,
  params?: Record<string, string>,
  explicacion = 'explanation',
): BlockedHelp {
  const base = `sync.blocked.${clave}`;
  return { title: `${base}.title`, explanation: `${base}.${explicacion}`, params, recommended };
}

/** ` (dep)` o nada: el turno no siempre tiene nombre. */
const entreParentesis = (dep: string) => ({ dep: dep ? ` (${dep})` : '' });

/**
 * Texto para el cajero por cada causa que clasifica `electron/db/blocked-diagnosis.js`.
 *
 * El panel mostraba solo el `pushError` crudo, que dice qué pasó pero no qué
 * hacer. Esto va arriba del motivo técnico (que se sigue mostrando, en chico,
 * para el admin). `dep` es el turno o el producto que la venta espera.
 */
const AYUDA: Record<BlockedCode, (dep: string, record: BlockedSyncRecord) => BlockedHelp> = {
  'turno-sin-subir': (dep) => ayuda('shiftNotUploaded', 'reintentar', entreParentesis(dep)),
  'turno-rechazado': (dep) => ayuda('shiftRejected', 'avisar-admin', entreParentesis(dep)),
  'producto-sin-subir': (dep) =>
    ayuda('productNotUploaded', 'reintentar', { name: dep }, dep ? 'explanation' : 'explanationNoName'),
  'producto-rechazado': (dep) =>
    ayuda('productRejected', 'avisar-admin', { name: dep }, dep ? 'explanation' : 'explanationNoName'),
  'producto-no-encontrado': (_dep, record) =>
    record.kind === 'stockEntry'
      ? ayuda('productNotFoundEntry', 'reintentar')
      : ayuda('productNotFound', 'avisar-admin'),
  'entrada-en-curso': () => ayuda('entryInProgress', 'reintentar'),
  'entrada-a-medias': () => ayuda('entryHalfDone', 'avisar-admin'),
  'entrada-posible-duplicada': () => ayuda('entryPossibleDuplicate', 'corregir'),
  'listo-para-reintentar': () => ayuda('readyToRetry', 'reintentar'),
  'turno-duplicado': () => ayuda('shiftDuplicate', 'reintentar'),
  'turno-abierto-existente': () => ayuda('shiftAlreadyOpen', 'avisar-admin'),
  'turno-ajeno': () => ayuda('shiftForeign', 'avisar-admin'),
  'turno-cerrado': (_dep, record) =>
    record.kind === 'cashMovement'
      ? ayuda('shiftClosed', 'corregir', undefined, 'explanationMovement')
      : ayuda('shiftClosed', 'avisar-admin'),
  'turno-no-encontrado': () => ayuda('shiftNotFound', 'reintentar'),
  'sin-stock': () => ayuda('noStock', 'avisar-admin'),
  'promocion-no-vigente': () => ayuda('promotionClosed', 'avisar-admin'),
  'anulacion-rechazada': () => ayuda('voidRejected', 'avisar-admin'),
  'catalogo-en-conflicto': () => ayuda('catalogConflict', 'corregir'),
  'producto-duplicado': () => ayuda('productDuplicate', 'corregir'),
  desconocido: (_dep, record) =>
    ayuda(
      'unknown',
      'avisar-admin',
      undefined,
      record.kind === 'stockEntry' || record.kind === 'product' ? 'explanationGoods' : 'explanation',
    ),
};

/**
 * Código de sincronización del servidor (SPEC 49) → causa del panel. Manda sobre
 * el código por texto: un `pushError` guardado con un IPC viejo, o un texto que
 * cambió en el backend, no confunde el diagnóstico cuando la caja tiene el código.
 */
const POR_CODIGO_DE_SERVIDOR: Partial<Record<SyncErrorCode, BlockedCode>> = {
  STOCK_INSUFFICIENT: 'sin-stock',
  BATCH_EXPIRED: 'sin-stock',
  PRODUCT_NOT_FOUND: 'producto-no-encontrado',
  PRODUCT_DUPLICATE: 'producto-duplicado',
  PRODUCT_SKU_TAKEN: 'producto-duplicado',
  PRODUCT_NAME_TAKEN: 'producto-duplicado',
  SESSION_CLOSED: 'turno-cerrado',
  SESSION_FORBIDDEN: 'turno-ajeno',
  ENTRY_IN_PROGRESS: 'entrada-en-curso',
  ENTRY_AMBIGUOUS: 'entrada-a-medias',
  ENTRY_POSSIBLE_DUPLICATE: 'entrada-posible-duplicada',
  CATALOG_CONFLICT: 'catalogo-en-conflicto',
};

/** Causa del panel para un registro: primero el código del servidor, luego el diagnóstico por texto. */
export function blockedCodeOf(record: BlockedSyncRecord): BlockedCode {
  // Una anulación rechazada se explica igual cualquiera que sea el código
  // (`VOID_FORBIDDEN`, `SESSION_FORBIDDEN`…): el remedio siempre es el admin.
  if (record.kind === 'saleVoid') {
    return 'anulacion-rechazada';
  }
  const syncCode = record.diagnosis?.syncCode;
  const porServidor = isSyncErrorCode(syncCode) ? POR_CODIGO_DE_SERVIDOR[syncCode] : undefined;
  return porServidor ?? record.diagnosis?.code ?? 'desconocido';
}

/** Ayuda para un registro bloqueado; sin diagnóstico (versión vieja del IPC) cae en `desconocido`. */
export function describeBlocked(record: BlockedSyncRecord): BlockedHelp {
  const code = blockedCodeOf(record);
  const ayuda = AYUDA[code] ?? AYUDA.desconocido;
  return ayuda(record.diagnosis?.dependency?.label ?? '', record);
}
