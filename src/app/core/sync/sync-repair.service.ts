import { Injectable, Injector, inject } from '@angular/core';

import { getApiErrorMessage } from '../api/api.utils';
import { SaleService } from '../../features/pos/services/sale.service';
import { PosBlocker } from '../../shared/models';
import { SyncScheduler } from './sync-scheduler.service';

/** Resultado de un intento de reparación, para notificar o reportar al backend. */
export interface RepairOutcome {
  ok: boolean;
  message: string;
}

/** El backend limita `reason` de `/sales/unreconciled` a 500 caracteres. */
const MAX_REASON_LENGTH = 500;

/**
 * Destraba lo que detiene a una venta en la caja. Lo usan el botón "Arreglar"
 * del panel de rechazados y los comandos remotos del diagnóstico
 * (`PosDiagnosticsService`), para que ambos caminos hagan exactamente lo mismo.
 *
 * El orden importa y es el punto de este servicio: primero se reintenta el
 * **bloqueador** (turno o producto) y se sube; solo si quedó con identidad
 * remota se devuelve la venta a la cola. Limpiar el error de la venta sin
 * resolver su bloqueador solo reiniciaba la espera: dos días después volvía a
 * aparecer bloqueada con el mismo problema.
 */
@Injectable({ providedIn: 'root' })
export class SyncRepairService {
  private readonly injector = inject(Injector);
  private readonly saleService = inject(SaleService);

  /**
   * Perezoso: `SyncScheduler` → `PosDiagnosticsService` → este servicio, y este
   * necesita el empuje ordenado del scheduler. Pedirlo en el constructor
   * armaría una dependencia circular.
   */
  private scheduler(): SyncScheduler {
    return this.injector.get(SyncScheduler);
  }

  private api() {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('Esta acción solo está disponible en la app de escritorio.');
    }
    return api;
  }

  private async log(level: 'info' | 'warn' | 'error', entity: string, message: string, ref: string | null) {
    try {
      await window.electronAPI?.syncLog?.append({ level, entity, message, ref });
    } catch {
      // La bitácora es de apoyo: si no se puede escribir, la reparación sigue.
    }
  }

  /**
   * Limpia el error del bloqueador para que su cola lo reintente. `false` si no
   * existe en esta caja (o es un producto que ni siquiera está en local).
   */
  async retryBlocker(blocker: Pick<PosBlocker, 'kind' | 'localId' | 'missingLocally'>): Promise<boolean> {
    const api = this.api();
    if (blocker.kind === 'cashSession') {
      return api.cashSessions.retryPush(blocker.localId);
    }
    if (blocker.missingLocally) {
      return false;
    }
    return api.catalog.retryProductPush(blocker.localId);
  }

  /**
   * "Arreglar": reintenta los bloqueadores, empuja, y si ya no queda ninguno
   * devuelve la venta a la cola y vuelve a empujar.
   */
  async fixSale(saleId: string): Promise<RepairOutcome> {
    const api = this.api();
    const blockers = await api.sales.diagnose(saleId);
    if (blockers === null) {
      return { ok: false, message: 'La venta ya no existe en esta caja.' };
    }
    await this.log('info', 'sale', `Arreglar: ${blockers.length} bloqueador(es)`, saleId);

    const missing = blockers.filter((blocker) => blocker.missingLocally);
    if (missing.length) {
      const names = missing.map((blocker) => blocker.label).join(', ');
      const outcome = {
        ok: false,
        message: `No se puede arreglar: ${names} no existe en esta caja. Descártala o mándala a conciliación.`,
      };
      await this.log('warn', 'sale', outcome.message, saleId);
      return outcome;
    }

    try {
      for (const blocker of blockers) {
        await this.retryBlocker(blocker);
      }
      if (blockers.length) {
        await this.scheduler().flushPendingNow();
      }

      const remaining = (await api.sales.diagnose(saleId)) ?? [];
      if (remaining.length) {
        const outcome = { ok: false, message: describeRemaining(remaining) };
        await this.log('warn', 'sale', `Arreglar falló: ${outcome.message}`, saleId);
        return outcome;
      }

      await api.sales.clearPushError(saleId);
      await this.scheduler().flushPendingNow();

      const stillBlocked = (await api.sales.listBlocked()).find((record) => record.id === saleId);
      if (stillBlocked) {
        const outcome = { ok: false, message: `El servidor la volvió a rechazar: ${stillBlocked.reason}` };
        await this.log('warn', 'sale', `Arreglar falló: ${outcome.message}`, saleId);
        return outcome;
      }
      const outcome = { ok: true, message: 'Venta reenviada al servidor.' };
      await this.log('info', 'sale', `Arreglar: ${outcome.message}`, saleId);
      return outcome;
    } catch (error: unknown) {
      const outcome = { ok: false, message: getApiErrorMessage(error) };
      await this.log('error', 'sale', `Arreglar falló: ${outcome.message}`, saleId);
      return outcome;
    }
  }

  /** Comando remoto `retrySale`: lo mismo que "Reintentar" + un empuje. */
  async retrySale(saleId: string): Promise<RepairOutcome> {
    const api = this.api();
    if ((await api.sales.diagnose(saleId)) === null) {
      return { ok: false, message: 'La venta no existe en esta caja.' };
    }
    await api.sales.clearPushError(saleId);
    await this.scheduler().flushPendingNow();
    const stillBlocked = (await api.sales.listBlocked()).find((record) => record.id === saleId);
    return stillBlocked
      ? { ok: false, message: stillBlocked.reason }
      : { ok: true, message: 'Venta reencolada y empuje ejecutado.' };
  }

  /** Comandos remotos `retryCashSession` / `retryProduct`. */
  async retryTarget(kind: PosBlocker['kind'], localId: string): Promise<RepairOutcome> {
    const api = this.api();
    const exists = await this.retryBlocker({ kind, localId, missingLocally: false });
    if (!exists) {
      return {
        ok: false,
        message: kind === 'cashSession' ? 'El turno no existe en esta caja.' : 'El producto no existe en esta caja.',
      };
    }
    await this.scheduler().flushPendingNow();
    if (kind === 'cashSession') {
      const blocked = (await api.cashSessions.listBlocked()).find((record) => record.id === localId);
      return blocked
        ? { ok: false, message: blocked.reason }
        : { ok: true, message: 'Turno reintentado.' };
    }
    const product = await api.catalog.getProductById(localId);
    return product?.remoteId
      ? { ok: true, message: 'Producto sincronizado.' }
      : { ok: false, message: 'El producto sigue sin subir; revisa su error en el diagnóstico.' };
  }

  /**
   * Manda la venta a `/sales/unreconciled` sin el turno local. Solo con
   * confirmación (panel) o por orden explícita del admin (comando remoto):
   * saca la venta de la cola para siempre.
   */
  async sendSaleToUnreconciled(saleId: string, note?: string | null): Promise<RepairOutcome> {
    const api = this.api();
    const blockers = await api.sales.diagnose(saleId);
    if (blockers === null) {
      return { ok: false, message: 'La venta no existe en esta caja.' };
    }
    const session = blockers.find((blocker) => blocker.kind === 'cashSession');
    const motivo =
      note?.trim() ||
      (session
        ? `Turno nunca registrado en el servidor (${session.label}): ${session.error ?? 'sin detalle'}`
        : 'Enviada a conciliación desde la caja');
    const reason = motivo.slice(0, MAX_REASON_LENGTH);
    try {
      await this.saleService.sendToUnreconciled(saleId, reason);
      await this.log('info', 'sale', `Mandada a conciliación: ${reason}`, saleId);
      return { ok: true, message: 'Venta registrada en conciliación.' };
    } catch (error: unknown) {
      const message = getApiErrorMessage(error);
      await this.log('error', 'sale', `No se pudo mandar a conciliación: ${message}`, saleId);
      return { ok: false, message };
    }
  }
}

function describeRemaining(blockers: PosBlocker[]): string {
  return blockers
    .map((blocker) => (blocker.error ? `${blocker.label}: ${blocker.error}` : `${blocker.label} sigue sin subir`))
    .join('; ');
}
