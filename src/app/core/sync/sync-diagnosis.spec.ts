import { describe, expect, it } from 'vitest';

import { BlockedSyncRecord } from '../electron/window.d';
import { blockedCodeOf, describeBlocked } from './sync-diagnosis';

function registro(overrides: Partial<BlockedSyncRecord> = {}): BlockedSyncRecord {
  return {
    kind: 'sale',
    id: 'v-1',
    label: 'PENDIENTE-1',
    detail: '$292.00',
    occurredAt: new Date(),
    reason: 'motivo crudo',
    ...overrides,
  };
}

describe('describeBlocked', () => {
  it('turno sin subir: recomienda reintentar y nombra el turno', () => {
    const ayuda = describeBlocked(
      registro({
        diagnosis: { code: 'turno-sin-subir', dependency: { kind: 'cashSession', label: 'Turno de Ana' } },
      }),
    );

    expect(ayuda.recommended).toBe('reintentar');
    expect(ayuda.explanation).toContain('Turno de Ana');
  });

  it('producto sin subir nombra el producto', () => {
    const ayuda = describeBlocked(
      registro({ diagnosis: { code: 'producto-sin-subir', dependency: { kind: 'product', label: 'Jarabe' } } }),
    );

    expect(ayuda.explanation).toContain('«Jarabe»');
  });

  it('turno cerrado: un gasto se corrige, una venta se consulta con el admin', () => {
    expect(describeBlocked(registro({ kind: 'cashMovement', diagnosis: { code: 'turno-cerrado' } })).recommended).toBe(
      'corregir',
    );
    expect(describeBlocked(registro({ diagnosis: { code: 'turno-cerrado' } })).recommended).toBe('avisar-admin');
  });

  it('sin diagnóstico (IPC viejo) cae en desconocido y manda con el admin', () => {
    const ayuda = describeBlocked(registro());

    expect(ayuda.title).toBe('Motivo no reconocido');
    expect(ayuda.recommended).toBe('avisar-admin');
  });

  it('ENTRY_IN_PROGRESS: el código manda sobre el texto y ya no dice "No la reintentes" (SPEC 49)', () => {
    const ayuda = describeBlocked({
      kind: 'stockEntry',
      id: 'b1',
      // El texto del servidor es el mismo que el de una entrada a medias.
      diagnosis: { code: 'entrada-a-medias', syncCode: 'ENTRY_IN_PROGRESS' },
    } as BlockedSyncRecord);

    expect(ayuda.recommended).toBe('reintentar');
    expect(ayuda.explanation).not.toMatch(/no la reintentes/i);
  });

  it('el código del servidor resuelve la causa aunque el texto no se reconozca', () => {
    expect(
      blockedCodeOf(registro({ diagnosis: { code: 'desconocido', syncCode: 'SESSION_CLOSED' } })),
    ).toBe('turno-cerrado');
    expect(
      blockedCodeOf(registro({ diagnosis: { code: 'desconocido', syncCode: 'PRODUCT_NOT_FOUND' } })),
    ).toBe('producto-no-encontrado');
    // Un código que esta versión no conoce no pisa el diagnóstico por texto.
    expect(blockedCodeOf(registro({ diagnosis: { code: 'sin-stock', syncCode: 'NUEVO' } }))).toBe('sin-stock');
  });

  it('ENTRY_AMBIGUOUS sigue mandando con el admin', () => {
    const ayuda = describeBlocked({
      kind: 'stockEntry',
      id: 'b1',
      diagnosis: { code: 'desconocido', syncCode: 'ENTRY_AMBIGUOUS' },
    } as BlockedSyncRecord);
    expect(ayuda.recommended).toBe('avisar-admin');
  });

  it('una entrada a medias en el servidor se consulta con el admin, no se reintenta', () => {
    const ayuda = describeBlocked({
      kind: 'stockEntry',
      id: 'b1',
      diagnosis: { code: 'entrada-a-medias' },
    } as BlockedSyncRecord);
    expect(ayuda.recommended).toBe('avisar-admin');
    expect(ayuda.title).toMatch(/a medias|medio/i);
  });

  it('un lote cuyo producto el servidor no conoce se reintenta; no habla de una venta', () => {
    const ayuda = describeBlocked({
      kind: 'stockEntry',
      id: 'b1',
      diagnosis: { code: 'producto-no-encontrado' },
    } as BlockedSyncRecord);
    expect(ayuda.recommended).toBe('reintentar');
    expect(`${ayuda.title} ${ayuda.explanation}`).not.toMatch(/venta/i);
  });

  it('nunca recomienda descartar', () => {
    const codes = [
      'turno-sin-subir', 'turno-rechazado', 'producto-sin-subir', 'producto-rechazado',
      'producto-no-encontrado', 'listo-para-reintentar', 'turno-duplicado', 'turno-abierto-existente',
      'turno-ajeno', 'turno-cerrado', 'turno-no-encontrado', 'sin-stock', 'promocion-no-vigente', 'desconocido',
    ] as const;
    for (const code of codes) {
      expect(['reintentar', 'corregir', 'avisar-admin']).toContain(describeBlocked(registro({ diagnosis: { code } })).recommended);
    }
  });
});

describe('describeBlocked — conflicto de catálogo (SPEC 56)', () => {
  it('explica que el panel cambió el producto y nombra las dos salidas', () => {
    const record = registro({
      kind: 'product',
      reason: 'El precio cambió en el panel: $58.00 [CATALOG_CONFLICT]',
      diagnosis: { code: 'catalogo-en-conflicto', syncCode: 'CATALOG_CONFLICT' },
    });

    expect(blockedCodeOf(record)).toBe('catalogo-en-conflicto');
    const ayuda = describeBlocked(record);
    expect(ayuda.title).toBe('El producto cambió en el panel');
    expect(ayuda.explanation).toContain('Usar el del panel');
    expect(ayuda.explanation).toContain('Forzar el mío');
  });
});
