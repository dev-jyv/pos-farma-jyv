import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductCatalogService } from '../../../features/pos/services/product-catalog.service';
import { StockEntryService } from '../../../features/pos/services/stock-entry.service';
import { NotificationService } from '../../notifications/notification.service';
import { BlockedSyncService } from '../blocked-sync.service';
import { SyncScheduler } from '../sync-scheduler.service';
import { PendingUpload } from './pending-upload';

describe('PendingUpload', () => {
  let catalogPending: unknown[];
  let entriesPending: unknown[];
  let online: boolean;
  const catalogCount = signal(0);
  const entriesCount = signal(0);
  const blockedCount = signal(0);
  const flushPendingNow = vi.fn();
  const syncManually = vi.fn();
  const notifications = { success: vi.fn(), error: vi.fn(), warn: vi.fn() };

  const crear = () => {
    TestBed.configureTestingModule({
      imports: [PendingUpload],
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        { provide: ProductCatalogService, useValue: { pendingCount: catalogCount } },
        {
          provide: StockEntryService,
          useValue: { pendingCount: entriesCount, refreshPending: vi.fn() },
        },
        { provide: SyncScheduler, useValue: { flushPendingNow, syncManually } },
        {
          provide: BlockedSyncService,
          useValue: { count: blockedCount, refresh: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: NotificationService, useValue: notifications },
      ],
    });
    const fixture = TestBed.createComponent(PendingUpload);
    fixture.detectChanges();
    return fixture;
  };

  beforeEach(() => {
    catalogPending = [];
    entriesPending = [];
    online = true;
    catalogCount.set(0);
    entriesCount.set(0);
    blockedCount.set(0);
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    (window as unknown as { electronAPI: object }).electronAPI = {
      catalog: {
        getPendingCatalogPush: async () => catalogPending,
        getPendingStockEntries: async () => entriesPending,
      },
    };
    flushPendingNow.mockImplementation(async () => {
      catalogPending = [];
      entriesPending = [];
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    delete (window as unknown as { electronAPI?: object }).electronAPI;
  });

  it('sin pendientes no muestra nada', () => {
    const fixture = crear();
    expect(fixture.nativeElement.querySelector('p-button')).toBeNull();
  });

  it('suma productos y entradas pendientes y ofrece subirlos', () => {
    catalogCount.set(1);
    entriesCount.set(2);
    const fixture = crear();
    expect(fixture.componentInstance.count()).toBe(3);
    expect(fixture.nativeElement.querySelector('p-button')).not.toBeNull();
  });

  it('sube solo lo pendiente (sin pull, sin gastar el cupo de Sincronizar)', async () => {
    catalogCount.set(1);
    catalogPending = [{}];
    const fixture = crear();
    await fixture.componentInstance.upload();
    expect(flushPendingNow).toHaveBeenCalledTimes(1);
    expect(syncManually).not.toHaveBeenCalled();
    expect(notifications.success).toHaveBeenCalled();
  });

  it('sin red no intenta', async () => {
    online = false;
    entriesCount.set(1);
    const fixture = crear();
    await fixture.componentInstance.upload();
    expect(flushPendingNow).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('Sin conexión'));
  });

  it('si queda algo en cola, lo dice en vez de dar por subido', async () => {
    entriesCount.set(1);
    flushPendingNow.mockImplementation(async () => {
      entriesPending = [{}];
    });
    const fixture = crear();
    await fixture.componentInstance.upload();
    expect(notifications.success).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('Quedan 1 sin subir'));
  });

  it('rechazados de antes no convierten en fallo una subida que vació la cola', async () => {
    catalogCount.set(1);
    blockedCount.set(2);
    const fixture = crear();
    await fixture.componentInstance.upload();
    expect(notifications.error).not.toHaveBeenCalled();
    expect(notifications.warn).toHaveBeenCalledWith(expect.stringContaining('2 registro(s) rechazado(s)'));
  });

  it('un segundo clic durante la subida no lanza otra', async () => {
    catalogCount.set(1);
    let release!: () => void;
    flushPendingNow.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const fixture = crear();
    const primera = fixture.componentInstance.upload();
    await fixture.componentInstance.upload();
    release();
    await primera;
    expect(flushPendingNow).toHaveBeenCalledTimes(1);
  });
});
