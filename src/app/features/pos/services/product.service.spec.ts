import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Product } from '../../../shared/models';
import { ProductService } from './product.service';

describe('ProductService', () => {
  let service: ProductService;
  let search: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    search = vi.fn().mockResolvedValue([]);
    window.electronAPI = {
      getAppVersion: vi.fn(),
      getDeviceInfo: vi.fn(),
      openCashDrawer: vi.fn(),
      catalog: {
        search,
        getByBarcode: vi.fn(),
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
      sync: {
        getStatus: vi.fn(),
        recordRun: vi.fn(),
      },
    } as unknown as Window['electronAPI'];

    TestBed.configureTestingModule({});
    service = TestBed.inject(ProductService);
  });

  it('término vacío no llama al catálogo local', async () => {
    const result = await new Promise((resolve) => service.search('   ').subscribe(resolve));
    expect(result).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('busca en el catálogo local con el término recortado', async () => {
    const products: Product[] = [{ id: 'p1', name: 'Paracetamol', sku: 'sku1', salePrice: 10, stock: 3 }];
    search.mockResolvedValue(products);

    const result = await new Promise((resolve) => service.search('  paracetamol  ').subscribe(resolve));

    expect(search).toHaveBeenCalledWith('paracetamol');
    expect(result).toEqual(products);
  });

  it('sin electronAPI (fuera de Electron) lanza en vez de fallar en silencio', () => {
    window.electronAPI = undefined;
    expect(() => service.search('paracetamol').subscribe()).toThrow();
  });
});
