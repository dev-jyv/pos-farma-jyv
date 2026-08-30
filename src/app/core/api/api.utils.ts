import { HttpErrorResponse } from '@angular/common/http';
import { Timestamp } from 'firebase/firestore';

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function getApiErrorStatus(error: unknown): number | null {
  if (error instanceof HttpErrorResponse) {
    return error.status;
  }
  if (error instanceof ApiRequestError) {
    return error.status;
  }
  return null;
}

export function toDate(value: unknown): Date {
  if (value instanceof Timestamp) {
    return value.toDate();
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  if (value && typeof value === 'object' && '_seconds' in value) {
    return new Date((value as { _seconds: number })._seconds * 1000);
  }
  return new Date();
}

export function getApiErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as ApiErrorBody;
    if (body?.error?.message) {
      return body.error.message;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Ocurrió un error inesperado.';
}

export function unwrapEntity<T>(response: unknown): T {
  if (response && typeof response === 'object' && 'data' in response) {
    return (response as { data: T }).data;
  }
  return response as T;
}

/**
 * Paginación tal como la devuelve el backend (`buildListMeta`). Ojo: el campo es
 * `limit`, no `pageSize` como en `shared/models`.
 */
export interface ApiListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function parseListMeta(value: unknown): ApiListMeta | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const dto = value as Record<string, unknown>;
  const numbers = ['page', 'limit', 'total', 'totalPages'].map((key) =>
    typeof dto[key] === 'number' ? (dto[key] as number) : null,
  );
  if (numbers.some((entry) => entry === null)) {
    return null;
  }
  const [page, limit, total, totalPages] = numbers as number[];
  return { page, limit, total, totalPages };
}

/**
 * Igual que `unwrapList`, pero conservando el `meta` de paginación.
 *
 * `unwrapList` lo descarta, y sin él una pantalla no puede saber que el servidor
 * tiene más renglones de los que le mandó: el libro de control se imprimía
 * truncado sin ninguna señal de que faltaba algo.
 */
export function unwrapListWithMeta<T>(
  response: unknown,
  key?: string,
): { items: T[]; meta: ApiListMeta | null } {
  const items = unwrapList<T>(response, key);
  if (response && typeof response === 'object') {
    return { items, meta: parseListMeta((response as Record<string, unknown>)['meta']) };
  }
  return { items, meta: null };
}

export function unwrapList<T>(response: unknown, key?: string): T[] {
  if (Array.isArray(response)) {
    return response;
  }
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    if (key && Array.isArray(record[key])) {
      return record[key] as T[];
    }
    if (Array.isArray(record['data'])) {
      return record['data'] as T[];
    }
    if (Array.isArray(record['items'])) {
      return record['items'] as T[];
    }
  }
  return [];
}
