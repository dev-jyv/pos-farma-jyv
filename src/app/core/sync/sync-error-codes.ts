import { HttpErrorResponse } from '@angular/common/http';

import { getApiErrorMessage, getApiErrorStatus } from '../api/api.utils';
import { SyncErrorCode, isSyncErrorCode } from '../../shared/models';

/**
 * Qué hace la caja con un rechazo de sincronización (SPEC 49).
 *
 * - `retry`: se queda pendiente **sin** `pushError`; el siguiente envío la vuelve a mandar.
 * - `reconcile`: el servidor no puede registrar la venta nunca (un producto que
 *   **no existe**). Va a conciliación (`POST /sales/unreconciled`).
 * - `block`: visible en "Rechazados"; alguien tiene que leerlo y decidir.
 * - `done`: lo que se pedía ya ocurrió en el servidor (anular algo ya anulado).
 */
export type SyncErrorAction = 'retry' | 'reconcile' | 'block' | 'done';

/**
 * La tabla única de clasificación. Ventas (`SaleService`) y entradas
 * (`StockEntryService`) la consultan; ningún servicio decide por su cuenta con
 * el texto del mensaje cuando el backend manda código.
 */
/**
 * Desde SPEC 52 el lote offline (`/sales/bulk`) **acepta** la venta con faltante
 * de stock, con producto inactivo o con el turno ya cerrado, y la devuelve
 * `ok: true` con su marca de revisión. Si aun así llega `STOCK_INSUFFICIENT`,
 * `BATCH_EXPIRED` o `PRODUCT_INACTIVE` (un backend con SPEC 49 sin SPEC 52), se
 * bloquea visible y **no** se manda a conciliación: `unreconciledSales` no
 * descuenta ninguna partida y el inventario de todas las cajas quedaba inflado.
 * Solo lo que el servidor jamás podrá registrar (`PRODUCT_NOT_FOUND`) concilia.
 */
export const SYNC_ERROR_ACTIONS: Readonly<Record<SyncErrorCode, SyncErrorAction>> = {
  STOCK_INSUFFICIENT: 'block',
  BATCH_EXPIRED: 'block',
  PRODUCT_NOT_FOUND: 'reconcile',
  PRODUCT_INACTIVE: 'block',
  SESSION_CLOSED: 'block',
  SESSION_FORBIDDEN: 'block',
  IDEMPOTENCY_CONFLICT: 'block',
  VALIDATION: 'block',
  DEFERRED: 'retry',
  ENTRY_IN_PROGRESS: 'retry',
  ENTRY_AMBIGUOUS: 'block',
  ALREADY_VOIDED: 'done',
  HAS_RETURNS: 'block',
  VOID_FORBIDDEN: 'block',
  INTERNAL: 'retry',
};

/** Un rechazo del servidor tal como lo leyó la caja, con o sin código. */
export interface SyncFailure {
  /** Código conocido de `SyncErrorCode`; `null` si no vino o la caja no lo conoce. */
  code: SyncErrorCode | null;
  /** El código tal como llegó (aunque sea uno que esta versión no conoce). */
  rawCode: string | null;
  /** Marca `retryable` del servidor; `null` si no vino. */
  retryable: boolean | null;
  /** Status HTTP; `null` para un resultado por índice del lote. */
  status: number | null;
  /** Texto en español del servidor: es lo que ve el cajero. */
  message: string;
  /**
   * `true` si la respuesta trae el contrato de SPEC 49 (código de sincronización
   * o `retryable`). Sin él la caja cae al clasificador por texto de siempre:
   * un backend viejo manda en el índice el código HTTP (`BAD_REQUEST`), no uno
   * de sincronización.
   */
  hasContract: boolean;
}

/** Error que lleva un rechazo por índice del lote fuera de un `map` de RxJS. */
export class SyncRejectionError extends Error {
  constructor(readonly failure: SyncFailure) {
    super(failure.message);
    this.name = 'SyncRejectionError';
  }
}

interface BulkRejection {
  error?: unknown;
  code?: unknown;
  retryable?: unknown;
}

function buildFailure(
  rawCode: unknown,
  retryable: unknown,
  status: number | null,
  message: string,
  fromDetails = false,
): SyncFailure {
  const code = isSyncErrorCode(rawCode) ? rawCode : null;
  const flag = typeof retryable === 'boolean' ? retryable : null;
  const raw = typeof rawCode === 'string' && rawCode ? rawCode : null;
  return {
    code,
    rawCode: raw,
    retryable: flag,
    status,
    message,
    // `details.code` solo existe desde SPEC 49: aunque la caja no conozca el
    // código, es contrato. En el índice del lote no basta un código cualquiera,
    // porque el backend viejo ya mandaba ahí el HTTP (`BAD_REQUEST`).
    hasContract: code !== null || flag !== null || (fromDetails && raw !== null),
  };
}

/** Rechazo de un índice de `/sales/bulk`: `{ ok: false, code, error, retryable }`. */
export function syncFailureFromResult(result: BulkRejection): SyncFailure {
  const message = typeof result.error === 'string' && result.error
    ? result.error
    : 'El servidor rechazó la venta sin motivo.';
  return buildFailure(result.code, result.retryable, null, message);
}

/**
 * Rechazo de una petición entera. El código de sincronización viaja en
 * `error.details.code`; `error.code` sigue siendo el HTTP (`BAD_REQUEST`) y
 * no se mira aquí.
 */
export function syncFailureFromError(error: unknown): SyncFailure {
  if (error instanceof SyncRejectionError) {
    return error.failure;
  }
  const status = getApiErrorStatus(error);
  const message = getApiErrorMessage(error);
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { error?: { details?: { code?: unknown; retryable?: unknown } } } | null;
    const details = body?.error?.details;
    if (details && typeof details === 'object') {
      return buildFailure(details.code, details.retryable, status, message, true);
    }
  }
  return buildFailure(null, null, status, message);
}

/**
 * Qué hacer con un rechazo **que trae código**; `null` si no lo trae (backend
 * viejo, red caída): entonces decide el fallback de cada servicio.
 *
 * `retryable: true` siempre deja pendiente. Un código que esta versión no
 * conoce se resuelve por el status: ≥ 500 pendiente, 4xx bloqueo visible; en un
 * índice del lote (sin status) manda la marca `retryable`.
 */
export function syncActionFor(failure: SyncFailure): SyncErrorAction | null {
  if (!failure.hasContract) {
    return null;
  }
  if (failure.retryable === true) {
    return 'retry';
  }
  if (failure.code) {
    return SYNC_ERROR_ACTIONS[failure.code];
  }
  if (failure.status !== null) {
    return failure.status >= 500 ? 'retry' : 'block';
  }
  return 'block';
}

/**
 * Fallback por texto para ventas de un backend sin código: lo que la caja hacía
 * antes de SPEC 49. Inventario remoto o turno ya cerrado no se arreglan
 * reintentando el mismo push → conciliación; lo demás se bloquea visible.
 */
export function legacySaleRejectionAction(message: string): 'reconcile' | 'block' {
  const normalized = message.toLowerCase();
  const inventory =
    normalized.includes('stock') ||
    normalized.includes('lote') ||
    normalized.includes('producto no encontrado') ||
    normalized.includes('producto no existe');
  const closedShift = normalized.includes('turno') && normalized.includes('cerrado');
  return inventory || closedShift ? 'reconcile' : 'block';
}

/** Fallback por texto para una anulación remota: "ya está anulada" cumple el objetivo. */
export function legacyAlreadyVoided(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('anulad') || normalized.includes('already void');
}

/**
 * Texto que se guarda en `pushError`: el mensaje del servidor con el código al
 * final (`Stock insuficiente para X [STOCK_INSUFFICIENT]`).
 *
 * Así el diagnóstico del panel (`electron/db/blocked-diagnosis.js`) clasifica
 * por código y no por texto, sin otra columna en SQLite que pudiera quedarse
 * vieja: cualquier escritura nueva de `pushError` reemplaza el código junto con
 * el texto. Sin código el mensaje queda igual que antes.
 */
export function withSyncCode(message: string, failure: Pick<SyncFailure, 'rawCode' | 'hasContract'>): string {
  if (!failure.hasContract || !failure.rawCode || !/^[A-Z][A-Z_]*$/.test(failure.rawCode)) {
    return message;
  }
  return `${message} [${failure.rawCode}]`;
}
