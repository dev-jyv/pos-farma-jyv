import { HttpErrorResponse } from '@angular/common/http';
import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';

import {
  ApiRequestError,
  getApiErrorMessage,
  getApiErrorStatus,
  toDate,
  unwrapEntity,
  unwrapList,
  unwrapListWithMeta,
} from './api.utils';

describe('api.utils', () => {
  describe('toDate', () => {
    it('convierte un Timestamp de Firestore', () => {
      const timestamp = Timestamp.fromDate(new Date('2026-08-08T12:00:00.000Z'));
      expect(toDate(timestamp).toISOString()).toBe('2026-08-08T12:00:00.000Z');
    });

    it('devuelve la misma Date sin clonarla', () => {
      const date = new Date('2026-01-01T00:00:00.000Z');
      expect(toDate(date)).toBe(date);
    });

    it('parsea ISO y epoch en milisegundos', () => {
      expect(toDate('2026-08-08T12:00:00.000Z').toISOString()).toBe('2026-08-08T12:00:00.000Z');
      expect(toDate(1_775_000_000_000).getTime()).toBe(1_775_000_000_000);
    });

    it('acepta el Timestamp serializado del Admin SDK (`_seconds`)', () => {
      expect(toDate({ _seconds: 1_775_000_000, _nanoseconds: 0 }).getTime()).toBe(
        1_775_000_000_000,
      );
    });

    it('cae a la fecha actual cuando el valor no es una fecha', () => {
      expect(toDate('no es fecha')).toBeInstanceOf(Date);
      expect(toDate(null)).toBeInstanceOf(Date);
    });
  });

  describe('getApiErrorStatus', () => {
    it('lee el status de un HttpErrorResponse', () => {
      expect(getApiErrorStatus(new HttpErrorResponse({ status: 409 }))).toBe(409);
    });

    it('lee el status de un ApiRequestError', () => {
      expect(getApiErrorStatus(new ApiRequestError('sin red', 0))).toBe(0);
    });

    it('devuelve null para cualquier otro error', () => {
      expect(getApiErrorStatus(new Error('boom'))).toBeNull();
    });
  });

  describe('getApiErrorMessage', () => {
    it('prefiere el mensaje del sobre de error del backend', () => {
      const error = new HttpErrorResponse({
        status: 400,
        error: { error: { code: 'BAD_REQUEST', message: 'Stock insuficiente' } },
      });
      expect(getApiErrorMessage(error)).toBe('Stock insuficiente');
    });

    it('cae al mensaje del Error cuando el cuerpo no trae sobre', () => {
      expect(getApiErrorMessage(new Error('sin red'))).toBe('sin red');
    });

    it('da un mensaje genérico para lo que no es Error', () => {
      expect(getApiErrorMessage('algo')).toBe('Ocurrió un error inesperado.');
    });
  });

  describe('unwrapEntity', () => {
    it('desenvuelve `data`', () => {
      expect(unwrapEntity<{ id: string }>({ data: { id: 'abc' } })).toEqual({ id: 'abc' });
    });

    it('devuelve la respuesta cruda cuando no viene envuelta', () => {
      expect(unwrapEntity<{ id: string }>({ id: 'abc' })).toEqual({ id: 'abc' });
    });
  });

  describe('unwrapList', () => {
    it('acepta un arreglo pelón', () => {
      expect(unwrapList<number>([1, 2])).toEqual([1, 2]);
    });

    it('prefiere la llave explícita sobre `data`', () => {
      expect(unwrapList<number>({ products: [1], data: [2] }, 'products')).toEqual([1]);
    });

    it('cae a `data` y luego a `items`', () => {
      expect(unwrapList<number>({ data: [1] })).toEqual([1]);
      expect(unwrapList<number>({ items: [2] })).toEqual([2]);
    });

    it('devuelve arreglo vacío ante una forma desconocida', () => {
      expect(unwrapList<number>({ nope: 1 })).toEqual([]);
      expect(unwrapList<number>(null)).toEqual([]);
    });
  });

  describe('unwrapListWithMeta', () => {
    it('conserva la paginación para saber si el servidor truncó la lista', () => {
      const result = unwrapListWithMeta<number>({
        data: [1, 2],
        meta: { page: 1, limit: 2, total: 10, totalPages: 5 },
      });
      expect(result.items).toEqual([1, 2]);
      expect(result.meta).toEqual({ page: 1, limit: 2, total: 10, totalPages: 5 });
    });

    it('descarta un meta incompleto en vez de inventar números', () => {
      const result = unwrapListWithMeta<number>({ data: [1], meta: { page: 1 } });
      expect(result.meta).toBeNull();
    });

    it('deja `meta` en null cuando la respuesta es un arreglo', () => {
      expect(unwrapListWithMeta<number>([1]).meta).toBeNull();
    });
  });
});
