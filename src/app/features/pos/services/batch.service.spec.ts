import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchService } from './batch.service';

describe('BatchService', () => {
  let service: BatchService;
  let getBatchesByProduct: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getBatchesByProduct = vi.fn().mockResolvedValue([]);
    window.electronAPI = {
      getAppVersion: vi.fn(),
      getDeviceInfo: vi.fn(),
      openCashDrawer: vi.fn(),
      catalog: {
        search: vi.fn(),
        getByBarcode: vi.fn(),
        getBatchesByProduct,
        recordStockEntry: vi.fn(),
        upsertMany: vi.fn(),
        getPendingStockEntries: vi.fn(),
        markStockEntrySynced: vi.fn(),
        markStockEntryPushFailed: vi.fn(),
      },
      sales: {
        createLocal: vi.fn(),
        list: vi.fn(),
        getPendingPush: vi.fn(),
        markSynced: vi.fn(),
        markPushFailed: vi.fn(),
        voidLocal: vi.fn(),
        clearPushError: vi.fn(),
        discard: vi.fn(),
      },
      sync: { getStatus: vi.fn(), recordRun: vi.fn() },
    } as unknown as Window['electronAPI'];

    TestBed.configureTestingModule({});
    service = TestBed.inject(BatchService);
  });

  it('consulta los lotes locales del producto por su id', async () => {
    const batches = [
      { id: 'b1', productId: 'p1', lotNumber: 'L1', expiryDate: new Date('2027-01-31'), quantity: 4 },
    ];
    getBatchesByProduct.mockResolvedValue(batches);

    const result = await new Promise((resolve) => service.listByProduct('p1').subscribe(resolve));

    expect(getBatchesByProduct).toHaveBeenCalledWith('p1');
    expect(result).toEqual(batches);
  });

  it('sin electronAPI (fuera de Electron) lanza en vez de fallar en silencio', () => {
    window.electronAPI = undefined;
    expect(() => service.listByProduct('p1').subscribe()).toThrow();
  });
});
