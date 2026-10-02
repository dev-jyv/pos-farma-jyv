import { Injectable, inject, signal } from '@angular/core';

import { AuthService } from '../auth/auth.service';
import { BlockedSyncRecord } from '../electron/window.d';
import { pushOwnerFilter } from './push-owner';

/**
 * Registros que el servidor rechazó al sincronizar.
 *
 * Un rechazo (4xx) no se reintenta solo, a propósito: turno cerrado, sin stock o
 * precio cambiado no se arreglan reintentando. El problema era que tampoco se
 * mostraban en ninguna parte — ni como pendientes ni como bloqueados —, así que
 * una venta ya cobrada podía llevar días sin llegar al servidor sin que nadie se
 * enterara. Esto solo los hace visibles; decidir qué hacer sigue siendo del
 * cajero o del admin.
 */
@Injectable({ providedIn: 'root' })
export class BlockedSyncService {
  private readonly auth = inject(AuthService);

  readonly records = signal<BlockedSyncRecord[]>([]);
  readonly count = signal(0);

  /** Relee las tres fuentes. Silencioso ante fallo: es un indicador, no una operación. */
  async refresh(): Promise<void> {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    try {
      const [sales, movements, sessions] = await Promise.all([
        api.sales.listBlocked(pushOwnerFilter(this.auth)),
        api.cashMovements.listBlocked(),
        api.cashSessions.listBlocked(),
      ]);
      const all = [...sales, ...movements, ...sessions].sort(
        (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
      );
      this.records.set(all);
      this.count.set(all.length);
    } catch {
      // Se deja el valor anterior: un IPC caído no debe borrar el aviso.
    }
  }

  /**
   * Solo los gastos se pueden corregir desde la caja: una venta ya cobrada no se
   * edita (se descarta y se vuelve a registrar), y un turno tampoco.
   */
  canFix(record: BlockedSyncRecord): boolean {
    return record.kind === 'cashMovement';
  }

  /**
   * Un turno no se borra: sus gastos y ventas cuelgan de él y quedarían
   * huérfanos. Para ese caso la salida es corregir la causa y reintentar.
   */
  canDiscard(record: BlockedSyncRecord): boolean {
    if (record.kind === 'sale') {
      // Descartar una venta cobrada la saca del efectivo esperado y del libro de
      // control sin dejar rastro: igual que en la cola normal, solo el admin.
      return this.auth.isAdmin();
    }
    return record.kind === 'cashMovement';
  }

  /**
   * Borra el registro **de este equipo**. Solo para lo que nunca llegó al
   * servidor: la venta repone el stock que había descontado; el gasto solo deja
   * de restar del efectivo esperado.
   */
  async discard(record: BlockedSyncRecord): Promise<void> {
    const api = window.electronAPI;
    if (!api || !this.canDiscard(record)) {
      return;
    }
    if (record.kind === 'sale') {
      await api.sales.discard(record.id);
    } else {
      await api.cashMovements.discard(record.id);
    }
    await this.refresh();
  }

  /**
   * Devuelve el registro a la cola normal. Se usa **después** de corregir la
   * causa (reabrir turno, reponer stock); la llave de idempotencia es la misma,
   * así que si el intento anterior sí llegó, el backend no lo duplica.
   */
  async retry(record: BlockedSyncRecord): Promise<void> {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    if (record.kind === 'sale') {
      await api.sales.clearPushError(record.id);
    } else if (record.kind === 'cashMovement') {
      await api.cashMovements.clearPushError(record.id);
    } else {
      await api.cashSessions.clearPushError(record.id);
    }
    await this.refresh();
  }
}
