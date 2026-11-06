import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { SYNC_ERROR_CODES } from '../../shared/models';
import {
  SYNC_ERROR_ACTIONS,
  SyncRejectionError,
  legacyAlreadyVoided,
  legacySaleRejectionAction,
  syncActionFor,
  syncFailureFromError,
  syncFailureFromResult,
  withSyncCode,
} from './sync-error-codes';

function httpError(status: number, error: unknown): HttpErrorResponse {
  return new HttpErrorResponse({ status, error, statusText: 'x' });
}

describe('tabla de clasificación (SPEC 49)', () => {
  it('cubre todos los códigos del contrato, ni uno más', () => {
    expect(Object.keys(SYNC_ERROR_ACTIONS).sort()).toEqual([...SYNC_ERROR_CODES].sort());
  });

  it.each([
    ['STOCK_INSUFFICIENT', 'reconcile'],
    ['BATCH_EXPIRED', 'reconcile'],
    ['PRODUCT_NOT_FOUND', 'reconcile'],
    ['PRODUCT_INACTIVE', 'reconcile'],
    ['SESSION_CLOSED', 'block'],
    ['SESSION_FORBIDDEN', 'block'],
    ['IDEMPOTENCY_CONFLICT', 'block'],
    ['VALIDATION', 'block'],
    ['DEFERRED', 'retry'],
    ['ENTRY_IN_PROGRESS', 'retry'],
    ['ENTRY_AMBIGUOUS', 'block'],
    ['ALREADY_VOIDED', 'done'],
    ['HAS_RETURNS', 'block'],
    ['VOID_FORBIDDEN', 'block'],
    ['INTERNAL', 'retry'],
  ])('%s → %s', (code, action) => {
    const failure = syncFailureFromResult({ code, error: 'x', retryable: false });
    expect(syncActionFor(failure)).toBe(action);
  });

  it('retryable: true deja pendiente aunque el código diga otra cosa', () => {
    const failure = syncFailureFromResult({ code: 'VALIDATION', error: 'x', retryable: true });
    expect(syncActionFor(failure)).toBe('retry');
  });

  it('un código conocido sin la marca retryable también cuenta como contrato', () => {
    expect(syncActionFor(syncFailureFromResult({ code: 'DEFERRED', error: 'x' }))).toBe('retry');
  });
});

describe('código que la caja no conoce', () => {
  it('en un error HTTP: ≥ 500 pendiente, 4xx bloqueo visible', () => {
    const caido = syncFailureFromError(
      httpError(503, { error: { code: 'X', message: 'm', details: { code: 'NUEVO_CODIGO' } } }),
    );
    const rechazo = syncFailureFromError(
      httpError(422, { error: { code: 'X', message: 'm', details: { code: 'NUEVO_CODIGO' } } }),
    );
    expect(syncActionFor(caido)).toBe('retry');
    expect(syncActionFor(rechazo)).toBe('block');
  });

  it('en un índice del lote manda la marca retryable', () => {
    expect(syncActionFor(syncFailureFromResult({ code: 'NUEVO', error: 'x', retryable: true }))).toBe(
      'retry',
    );
    expect(syncActionFor(syncFailureFromResult({ code: 'NUEVO', error: 'x', retryable: false }))).toBe(
      'block',
    );
  });
});

describe('backend viejo: sin código no hay decisión, decide el texto', () => {
  it('el código HTTP del índice (BAD_REQUEST) no es un código de sincronización', () => {
    const failure = syncFailureFromResult({ code: 'BAD_REQUEST', error: 'Stock insuficiente' });
    expect(failure.hasContract).toBe(false);
    expect(syncActionFor(failure)).toBeNull();
  });

  it('un error HTTP sin details tampoco trae decisión', () => {
    const failure = syncFailureFromError(
      httpError(409, { error: { code: 'CONFLICT', message: 'quedó a medio registrar' } }),
    );
    expect(failure.message).toBe('quedó a medio registrar');
    expect(failure.status).toBe(409);
    expect(syncActionFor(failure)).toBeNull();
  });

  it('un fallo de red no trae decisión', () => {
    expect(syncActionFor(syncFailureFromError(httpError(0, null)))).toBeNull();
  });

  it.each([
    ['Stock insuficiente para CORIVER', 'reconcile'],
    ['No hay lote vigente', 'reconcile'],
    ['Producto no encontrado', 'reconcile'],
    ['El turno de caja ya está cerrado', 'reconcile'],
    ['Llave de idempotencia ya usada', 'block'],
  ])('venta: «%s» → %s', (message, action) => {
    expect(legacySaleRejectionAction(message)).toBe(action);
  });

  it('anulación: el texto "anulada" cumple el objetivo', () => {
    expect(legacyAlreadyVoided('La venta ya está anulada')).toBe(true);
    expect(legacyAlreadyVoided('Sin permiso')).toBe(false);
  });
});

describe('lectura del error', () => {
  it('lee details.code y details.retryable, y conserva el mensaje en español', () => {
    const failure = syncFailureFromError(
      httpError(409, {
        error: {
          code: 'CONFLICT',
          message: 'La entrada se está registrando',
          details: { code: 'ENTRY_IN_PROGRESS', retryable: true },
        },
      }),
    );
    expect(failure).toMatchObject({
      code: 'ENTRY_IN_PROGRESS',
      rawCode: 'ENTRY_IN_PROGRESS',
      retryable: true,
      status: 409,
      message: 'La entrada se está registrando',
      hasContract: true,
    });
  });

  it('un rechazo por índice lanzado como error conserva su código', () => {
    const failure = syncFailureFromResult({ code: 'SESSION_CLOSED', error: 'Turno cerrado', retryable: false });
    expect(syncFailureFromError(new SyncRejectionError(failure))).toBe(failure);
  });
});

describe('withSyncCode', () => {
  it('deja el código al final del motivo para el diagnóstico del panel', () => {
    const failure = syncFailureFromResult({ code: 'SESSION_CLOSED', error: 'x', retryable: false });
    expect(withSyncCode('El turno de caja ya está cerrado', failure)).toBe(
      'El turno de caja ya está cerrado [SESSION_CLOSED]',
    );
  });

  it('sin contrato el mensaje queda igual que antes', () => {
    const failure = syncFailureFromResult({ code: 'BAD_REQUEST', error: 'x' });
    expect(withSyncCode('Llave usada', failure)).toBe('Llave usada');
  });
});
