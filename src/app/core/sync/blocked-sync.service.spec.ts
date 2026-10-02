import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { BlockedSyncRecord } from '../electron/window.d';
import { BlockedSyncService } from './blocked-sync.service';

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
    } as unknown as typeof window.electronAPI;
    await build(false).refresh();
    expect(listBlocked).toHaveBeenCalledWith({ ownerUid: 'u-cajero' });
    window.electronAPI = undefined;
  });
});
