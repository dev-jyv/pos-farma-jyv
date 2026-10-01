import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SaleService } from '../../features/pos/services/sale.service';
import { PosBlocker } from '../../shared/models';
import { SyncRepairService } from './sync-repair.service';
import { SyncScheduler } from './sync-scheduler.service';

/**
 * "Arreglar" del panel de rechazados y los comandos remotos: primero el
 * bloqueador, luego la venta. Limpiar solo la venta reiniciaba la espera.
 */
describe('SyncRepairService', () => {
  let service: SyncRepairService;
  let flushPendingNow: ReturnType<typeof vi.fn>;
  let sendToUnreconciled: ReturnType<typeof vi.fn>;
  let electron: {
    sales: Record<string, ReturnType<typeof vi.fn>>;
    cashSessions: Record<string, ReturnType<typeof vi.fn>>;
    catalog: Record<string, ReturnType<typeof vi.fn>>;
    syncLog: Record<string, ReturnType<typeof vi.fn>>;
  };

  const turno: PosBlocker = {
    kind: 'cashSession',
    localId: 'cs-1',
    remoteId: null,
    label: 'Turno de ana del 25/09 13:02',
    error: 'Turno remoto ya abierto',
    missingLocally: false,
  };
  const producto: PosBlocker = {
    kind: 'product',
    localId: 'p-1',
    remoteId: null,
    label: 'Paracetamol 500',
    error: null,
    missingLocally: false,
  };

  beforeEach(() => {
    flushPendingNow = vi.fn().mockResolvedValue(undefined);
    sendToUnreconciled = vi.fn().mockResolvedValue(undefined);
    electron = {
      sales: {
        diagnose: vi.fn(),
        clearPushError: vi.fn().mockResolvedValue(undefined),
        listBlocked: vi.fn().mockResolvedValue([]),
      },
      cashSessions: { retryPush: vi.fn().mockResolvedValue(true), listBlocked: vi.fn().mockResolvedValue([]) },
      catalog: { retryProductPush: vi.fn().mockResolvedValue(true), getProductById: vi.fn() },
      syncLog: { append: vi.fn().mockResolvedValue(null) },
    };
    window.electronAPI = electron as unknown as NonNullable<Window['electronAPI']>;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SyncScheduler, useValue: { flushPendingNow } },
        { provide: SaleService, useValue: { sendToUnreconciled } },
      ],
    });
    service = TestBed.inject(SyncRepairService);
  });

  afterEach(() => {
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it('reintenta turno y producto, sube, y con todo resuelto reencola la venta', async () => {
    electron.sales['diagnose'].mockResolvedValueOnce([turno, producto]).mockResolvedValueOnce([]);

    const outcome = await service.fixSale('sale-1');

    expect(outcome.ok).toBe(true);
    expect(electron.cashSessions['retryPush']).toHaveBeenCalledWith('cs-1');
    expect(electron.catalog['retryProductPush']).toHaveBeenCalledWith('p-1');
    expect(electron.sales['clearPushError']).toHaveBeenCalledWith('sale-1');
    expect(flushPendingNow).toHaveBeenCalledTimes(2);
  });

  it('si el bloqueador sigue, NO limpia la venta y explica qué falta', async () => {
    electron.sales['diagnose'].mockResolvedValue([turno]);

    const outcome = await service.fixSale('sale-1');

    expect(outcome).toEqual({ ok: false, message: 'Turno de ana del 25/09 13:02: Turno remoto ya abierto' });
    expect(electron.sales['clearPushError']).not.toHaveBeenCalled();
  });

  it('si el servidor la vuelve a rechazar, lo dice', async () => {
    electron.sales['diagnose'].mockResolvedValue([]);
    electron.sales['listBlocked'].mockResolvedValue([{ id: 'sale-1', reason: 'Stock insuficiente' }]);

    const outcome = await service.fixSale('sale-1');

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('Stock insuficiente');
  });

  it('un producto que no existe en local no se puede arreglar', async () => {
    electron.sales['diagnose'].mockResolvedValue([{ ...producto, missingLocally: true }]);

    const outcome = await service.fixSale('sale-1');

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/no existe en esta caja/);
    expect(flushPendingNow).not.toHaveBeenCalled();
  });

  it('venta inexistente → falla con mensaje', async () => {
    electron.sales['diagnose'].mockResolvedValue(null);
    expect(await service.fixSale('x')).toEqual({ ok: false, message: 'La venta ya no existe en esta caja.' });
    expect(await service.retrySale('x')).toEqual({ ok: false, message: 'La venta no existe en esta caja.' });
  });

  it('retryTarget de un turno inexistente falla sin empujar', async () => {
    electron.cashSessions['retryPush'].mockResolvedValue(false);

    const outcome = await service.retryTarget('cashSession', 'cs-x');

    expect(outcome).toEqual({ ok: false, message: 'El turno no existe en esta caja.' });
    expect(flushPendingNow).not.toHaveBeenCalled();
  });

  it('retryTarget de un producto reporta si quedó sincronizado', async () => {
    electron.catalog['getProductById'].mockResolvedValue({ id: 'p-1', remoteId: 'remote-p1' });
    expect((await service.retryTarget('product', 'p-1')).ok).toBe(true);
  });

  it('mandar a conciliación usa el error del turno como motivo', async () => {
    electron.sales['diagnose'].mockResolvedValue([turno]);

    const outcome = await service.sendSaleToUnreconciled('sale-1');

    expect(outcome.ok).toBe(true);
    expect(sendToUnreconciled).toHaveBeenCalledWith(
      'sale-1',
      'Turno nunca registrado en el servidor (Turno de ana del 25/09 13:02): Turno remoto ya abierto',
    );
  });

  it('si el servidor rechaza la conciliación, devuelve el error', async () => {
    electron.sales['diagnose'].mockResolvedValue([turno]);
    sendToUnreconciled.mockRejectedValue(new Error('Venta ya registrada'));

    expect(await service.sendSaleToUnreconciled('sale-1', 'nota')).toEqual({
      ok: false,
      message: 'Venta ya registrada',
    });
  });
});
