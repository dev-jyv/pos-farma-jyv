import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { BlockedSyncRecord } from '../electron/window.d';
import { PosBlocker } from '../../shared/models';
import { BlockedSyncService } from './blocked-sync.service';
import { SaleService } from '../../features/pos/services/sale.service';
import { describeBlocked } from './sync-diagnosis';

function build(isAdmin: boolean) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthService,
        useValue: { isAdmin: () => isAdmin, user: () => ({ uid: 'u-cajero' }) },
      },
    ],
  });
  return TestBed.inject(BlockedSyncService);
}

const venta = { kind: 'sale', id: 's1' } as BlockedSyncRecord;
const gasto = { kind: 'cashMovement', id: 'm1' } as BlockedSyncRecord;
const turno = { kind: 'cashSession', id: 't1' } as BlockedSyncRecord;
const entrada = { kind: 'stockEntry', id: 'b1' } as BlockedSyncRecord;
const producto = { kind: 'product', id: 'p1' } as BlockedSyncRecord;

describe('BlockedSyncService', () => {
  it('solo el admin puede descartar una venta rechazada', () => {
    expect(build(false).canDiscard(venta)).toBe(false);
  });

  it('el admin sí puede descartar una venta; un turno nunca', () => {
    const service = build(true);
    expect(service.canDiscard(venta)).toBe(true);
    expect(service.canDiscard(turno)).toBe(false);
  });

  it('el cajero sigue pudiendo descartar su gasto rechazado', () => {
    expect(build(false).canDiscard(gasto)).toBe(true);
  });

  it('las ventas rechazadas se piden acotadas al cajero en sesión', async () => {
    const listBlocked = vi.fn().mockResolvedValue([]);
    window.electronAPI = {
      sales: { listBlocked },
      cashMovements: { listBlocked: vi.fn().mockResolvedValue([]) },
      cashSessions: { listBlocked: vi.fn().mockResolvedValue([]) },
      catalog: {
        listBlockedStockEntries: vi.fn().mockResolvedValue([]),
        listBlockedProducts: vi.fn().mockResolvedValue([]),
      },
    } as unknown as typeof window.electronAPI;
    await build(false).refresh();
    expect(listBlocked).toHaveBeenCalledWith({ ownerUid: 'u-cajero' });
    window.electronAPI = undefined;
  });

  describe('lotes y productos rechazados', () => {
    afterEach(() => {
      window.electronAPI = undefined;
    });

    it('los lotes y productos rechazados también salen en el panel, ordenados por fecha', async () => {
      window.electronAPI = {
        sales: { listBlocked: vi.fn().mockResolvedValue([]) },
        cashMovements: { listBlocked: vi.fn().mockResolvedValue([]) },
        cashSessions: { listBlocked: vi.fn().mockResolvedValue([]) },
        catalog: {
          listBlockedStockEntries: vi
            .fn()
            .mockResolvedValue([{ kind: 'stockEntry', id: 'b1', occurredAt: '2026-10-09T12:00:00Z' }]),
          listBlockedProducts: vi
            .fn()
            .mockResolvedValue([{ kind: 'product', id: 'p1', occurredAt: '2026-10-09T10:00:00Z' }]),
        },
      } as unknown as typeof window.electronAPI;
      const service = build(false);

      await service.refresh();

      expect(service.count()).toBe(2);
      expect(service.records().map((r) => r.kind)).toEqual(['product', 'stockEntry']);
    });

    it('descartar un lote es solo del admin; un producto del catálogo no se descarta', () => {
      expect(build(false).canDiscard(entrada)).toBe(false);
      TestBed.resetTestingModule();
      const admin = build(true);
      expect(admin.canDiscard(entrada)).toBe(true);
      expect(admin.canDiscard(producto)).toBe(false);
    });

    it('un producto rechazado se corrige en su pantalla; un lote no se edita', () => {
      const service = build(true);
      expect(service.canFix(producto)).toBe(true);
      expect(service.canFix(entrada)).toBe(false);
    });

    it('reintentar un lote o un producto limpia el error en su propia cola', async () => {
      const clearStockEntryPushError = vi.fn().mockResolvedValue(undefined);
      const clearCatalogPushError = vi.fn().mockResolvedValue(undefined);
      window.electronAPI = {
        sales: { listBlocked: vi.fn().mockResolvedValue([]) },
        cashMovements: { listBlocked: vi.fn().mockResolvedValue([]) },
        cashSessions: { listBlocked: vi.fn().mockResolvedValue([]) },
        catalog: {
          listBlockedStockEntries: vi.fn().mockResolvedValue([]),
          listBlockedProducts: vi.fn().mockResolvedValue([]),
          clearStockEntryPushError,
          clearCatalogPushError,
        },
      } as unknown as typeof window.electronAPI;
      const service = build(true);

      await service.retry(entrada);
      await service.retry(producto);

      expect(clearStockEntryPushError).toHaveBeenCalledWith('b1');
      expect(clearCatalogPushError).toHaveBeenCalledWith('p1');
    });

    it('el admin descarta un lote rechazado por su canal; el cajero no', async () => {
      const discardStockEntry = vi.fn().mockResolvedValue(undefined);
      window.electronAPI = {
        sales: { listBlocked: vi.fn().mockResolvedValue([]) },
        cashMovements: { listBlocked: vi.fn().mockResolvedValue([]) },
        cashSessions: { listBlocked: vi.fn().mockResolvedValue([]) },
        catalog: {
          listBlockedStockEntries: vi.fn().mockResolvedValue([]),
          listBlockedProducts: vi.fn().mockResolvedValue([]),
          discardStockEntry,
        },
      } as unknown as typeof window.electronAPI;

      await build(false).discard(entrada);
      expect(discardStockEntry).not.toHaveBeenCalled();

      TestBed.resetTestingModule();
      await build(true).discard(entrada);
      expect(discardStockEntry).toHaveBeenCalledWith('b1');
    });
  });
});

/** Anulación rechazada y descarte con motivo (SPEC 62). */
describe('BlockedSyncService — anulaciones y descarte (SPEC 62)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    window.electronAPI = undefined;
  });

  const anulacion: BlockedSyncRecord = {
    kind: 'saleVoid',
    id: 's-9',
    label: 'Anulación de V-9',
    detail: '$10.00',
    occurredAt: '2026-11-06T10:00:00Z',
    reason: 'Solo un administrador puede anular [VOID_FORBIDDEN]',
    diagnosis: { code: 'anulacion-rechazada' },
  };

  it('el cajero no la reintenta: el panel le pide a un admin; nadie la descarta', () => {
    const cajero = build(false);
    expect(cajero.canRetry(anulacion)).toBe(false);
    expect(cajero.needsAdmin(anulacion)).toBe(true);
    expect(cajero.canDiscard(anulacion)).toBe(false);
    TestBed.resetTestingModule();
    const admin = build(true);
    expect(admin.canRetry(anulacion)).toBe(true);
    expect(admin.needsAdmin(anulacion)).toBe(false);
    expect(admin.canDiscard(anulacion)).toBe(false);
  });

  it('el "Reintentar" del admin la devuelve a la cola de anulaciones remotas', async () => {
    const clearVoidError = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = {
      sales: { listBlocked: vi.fn().mockResolvedValue([]), clearVoidError },
      cashMovements: { listBlocked: vi.fn().mockResolvedValue([]) },
      cashSessions: { listBlocked: vi.fn().mockResolvedValue([]) },
      catalog: {
        listBlockedStockEntries: vi.fn().mockResolvedValue([]),
        listBlockedProducts: vi.fn().mockResolvedValue([]),
      },
    } as unknown as typeof window.electronAPI;

    await build(false).retry(anulacion);
    expect(clearVoidError).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
    await build(true).retry(anulacion);
    expect(clearVoidError).toHaveBeenCalledWith('s-9');
  });

  it('el panel la explica como anulación rechazada y recomienda avisar al admin', () => {
    const ayuda = describeBlocked(anulacion);
    expect(ayuda.title).toBe('El servidor rechazó la anulación');
    expect(ayuda.recommended).toBe('avisar-admin');
  });

  it('descartar una venta pide motivo y va por SaleService.discardSale', async () => {
    const discardSale = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = { sales: {} } as unknown as typeof window.electronAPI;
    TestBed.configureTestingModule({ providers: [{ provide: SaleService, useValue: { discardSale } }] });
    const admin = build(true);

    expect(admin.needsDiscardReason(venta)).toBe(true);
    expect(admin.needsDiscardReason(gasto)).toBe(false);
    await admin.discard(venta, 'Venta de prueba');

    expect(discardSale).toHaveBeenCalledWith('s1', 'Venta de prueba');
  });
});

/** Cuándo el panel ofrece "Arreglar" y cuándo "Mandar a conciliación". */
describe('BlockedSyncService — reparación', () => {
  afterEach(() => TestBed.resetTestingModule());

  const ventaCon = (blockers: PosBlocker[]): BlockedSyncRecord => ({
    kind: 'sale',
    id: 's-1',
    label: 'F-1',
    detail: '$1.00',
    occurredAt: '2026-10-01T10:00:00Z',
    reason: 'x',
    blockers,
  });
  const turnoRechazado: PosBlocker = {
    kind: 'cashSession',
    localId: 'cs-1',
    remoteId: null,
    label: 'Turno',
    error: 'rechazado',
    missingLocally: false,
  };
  const productoPendiente: PosBlocker = {
    kind: 'product',
    localId: 'p-1',
    remoteId: null,
    label: 'Paracetamol',
    error: null,
    missingLocally: false,
  };

  it('Arreglar solo en ventas con bloqueadores locales', () => {
    const service = build(false);
    expect(service.canRepair(ventaCon([turnoRechazado]))).toBe(true);
    expect(service.canRepair(ventaCon([]))).toBe(false);
    expect(service.canRepair({ ...ventaCon([turnoRechazado]), kind: 'cashMovement' })).toBe(false);
  });

  it('conciliación solo tras un Arreglar fallido y con un bloqueador sin arreglo local', () => {
    const service = build(false);
    expect(service.canSendToUnreconciled(ventaCon([turnoRechazado]), false)).toBe(false);
    expect(service.canSendToUnreconciled(ventaCon([turnoRechazado]), true)).toBe(true);
    expect(service.canSendToUnreconciled(ventaCon([{ ...turnoRechazado, error: null }]), true)).toBe(false);
    expect(service.canSendToUnreconciled(ventaCon([productoPendiente]), true)).toBe(false);
    expect(
      service.canSendToUnreconciled(ventaCon([{ ...productoPendiente, missingLocally: true }]), true),
    ).toBe(true);
  });
});

describe('BlockedSyncService — conflicto de catálogo con el panel (SPEC 56)', () => {
  afterEach(() => {
    window.electronAPI = undefined;
    TestBed.resetTestingModule();
  });

  const enConflicto = {
    kind: 'product',
    id: 'p1',
    conflict: { salePrice: 58, isActive: true },
  } as BlockedSyncRecord;

  it('solo un producto con conflicto ofrece "Usar el del panel" / "Forzar el mío"', () => {
    const service = build(false);
    expect(service.canResolveConflict(enConflicto)).toBe(true);
    expect(service.canResolveConflict(producto)).toBe(false);
    expect(service.canResolveConflict({ ...venta, conflict: enConflicto.conflict } as BlockedSyncRecord)).toBe(false);
  });

  it('resolver pasa la elección al proceso main y relee la lista', async () => {
    const resolveCatalogConflict = vi.fn().mockResolvedValue(true);
    const listBlockedProducts = vi.fn().mockResolvedValue([]);
    window.electronAPI = {
      sales: { listBlocked: vi.fn().mockResolvedValue([]) },
      cashMovements: { listBlocked: vi.fn().mockResolvedValue([]) },
      cashSessions: { listBlocked: vi.fn().mockResolvedValue([]) },
      catalog: {
        listBlockedStockEntries: vi.fn().mockResolvedValue([]),
        listBlockedProducts,
        resolveCatalogConflict,
      },
    } as unknown as typeof window.electronAPI;

    await build(false).resolveConflict(enConflicto, 'mine');

    expect(resolveCatalogConflict).toHaveBeenCalledWith('p1', 'mine');
    expect(listBlockedProducts).toHaveBeenCalled();
  });
});

describe('BlockedSyncService — posible factura recapturada (SPEC 58)', () => {
  afterEach(() => {
    window.electronAPI = undefined;
    TestBed.resetTestingModule();
  });

  const duplicada: BlockedSyncRecord = {
    kind: 'stockEntry',
    id: 'b-dup',
    label: 'Entrada L-1',
    detail: 'Paracetamol · 6 pzas',
    occurredAt: '2026-11-06T10:00:00Z',
    reason: 'La factura ya tiene una entrada igual. [ENTRY_POSSIBLE_DUPLICATE]',
    diagnosis: { code: 'entrada-posible-duplicada', syncCode: 'ENTRY_POSSIBLE_DUPLICATE' },
  };

  function api() {
    const confirmDuplicateStockEntry = vi.fn().mockResolvedValue(true);
    const discardStockEntry = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = {
      sales: { listBlocked: vi.fn().mockResolvedValue([]) },
      cashMovements: { listBlocked: vi.fn().mockResolvedValue([]) },
      cashSessions: { listBlocked: vi.fn().mockResolvedValue([]) },
      catalog: {
        listBlockedStockEntries: vi.fn().mockResolvedValue([]),
        listBlockedProducts: vi.fn().mockResolvedValue([]),
        confirmDuplicateStockEntry,
        discardStockEntry,
      },
    } as unknown as typeof window.electronAPI;
    return { confirmDuplicateStockEntry, discardStockEntry };
  }

  it('reconoce el aviso solo en entradas con ese diagnóstico', () => {
    const service = build(false);
    expect(service.isPossibleDuplicate(duplicada)).toBe(true);
    expect(service.isPossibleDuplicate(entrada)).toBe(false);
    expect(service.isPossibleDuplicate({ ...duplicada, kind: 'sale' })).toBe(false);
  });

  it('"Sí, es otra partida" reenvía la entrada con confirmDuplicate', async () => {
    const { confirmDuplicateStockEntry } = api();
    await build(false).confirmDuplicate(duplicada);
    expect(confirmDuplicateStockEntry).toHaveBeenCalledWith('b-dup');
  });

  it('una entrada sin el aviso no se confirma como duplicada', async () => {
    const { confirmDuplicateStockEntry } = api();
    await build(true).confirmDuplicate(entrada);
    expect(confirmDuplicateStockEntry).not.toHaveBeenCalled();
  });

  it('"Descartar" también lo puede elegir el cajero ante el aviso; otro lote no', async () => {
    const { discardStockEntry } = api();
    const cajero = build(false);
    expect(cajero.canDiscard(duplicada)).toBe(true);
    expect(cajero.canDiscard(entrada)).toBe(false);

    await cajero.discard(duplicada);
    expect(discardStockEntry).toHaveBeenCalledWith('b-dup');
  });
});
