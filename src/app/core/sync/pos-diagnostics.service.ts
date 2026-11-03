import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { getApiErrorMessage, unwrapEntity } from '../api/api.utils';
import { AuthService } from '../auth/auth.service';
import { PosCommand, PosCommandResult } from '../../shared/models';
import { environment } from '../../../environments/environment';
import { RepairOutcome, SyncRepairService } from './sync-repair.service';

/**
 * Diagnóstico remoto: manda al backend la foto de salud del sync de esta caja
 * (`POST /pos/diagnostics`) y ejecuta los comandos que el admin dejó para ella.
 *
 * Por qué existe: una venta atorada solo era visible en la propia caja. El
 * servidor no tenía rastro y el admin se enteraba cuando el corte no cuadraba.
 * Con esto el admin la ve desde el panel web y puede destrabarla sin ir a la
 * farmacia.
 *
 * Todo es **best-effort**: sin sesión no se manda nada, y cualquier fallo se
 * asienta en la bitácora local y se traga. Nunca puede romper ni retrasar un
 * sync ni un cobro.
 */
@Injectable({ providedIn: 'root' })
export class PosDiagnosticsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly repair = inject(SyncRepairService);
  private readonly apiUrl = environment.apiUrl;

  /** Un reporte a la vez: el sync completo y el pull horario pueden coincidir. */
  private inFlight: Promise<void> | null = null;
  /**
   * Comandos ya ejecutados en esta sesión cuyo resultado no se pudo reportar.
   * Si el backend los vuelve a mandar, se reporta el resultado guardado en vez
   * de ejecutarlos otra vez.
   */
  private readonly unreported = new Map<string, PosCommandResult>();

  /** Dispara el reporte; se puede esperar, pero nunca rechaza. */
  report(): Promise<void> {
    // `diagnostics` falta en un preload viejo (o en un doble de prueba): sin
    // él no hay foto que mandar.
    if (!window.electronAPI?.diagnostics || !this.auth.user()) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.doReport()
      .catch((error: unknown) =>
        this.log('warn', 'diagnostics', `No se pudo mandar el diagnóstico: ${getApiErrorMessage(error)}`, null),
      )
      .then(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async doReport(): Promise<void> {
    const api = window.electronAPI!;
    const snapshot = await api.diagnostics.buildSnapshot();
    const response = await firstValueFrom(this.http.post<unknown>(`${this.apiUrl}/pos/diagnostics`, snapshot));
    const commands = unwrapEntity<{ commands?: PosCommand[] } | null>(response)?.commands ?? [];

    for (const command of commands) {
      if (command.status !== 'pending') {
        continue;
      }
      // Defensa: el backend ya filtra por equipo, pero ejecutar el comando de
      // otra caja sería tocar registros que aquí significan otra cosa.
      if (command.deviceId && command.deviceId !== snapshot.deviceId) {
        continue;
      }
      await this.handleCommand(command, snapshot.deviceId);
    }
  }

  private async handleCommand(command: PosCommand, deviceId: string): Promise<void> {
    let result = this.unreported.get(command.id);
    if (!result) {
      await this.log(
        'info',
        'command',
        `Comando remoto ${command.type} → ${command.targetLocalId} (de ${command.createdBy})`,
        command.id,
      );
      const outcome = await this.execute(command).catch(
        (error: unknown): RepairOutcome => ({ ok: false, message: getApiErrorMessage(error) }),
      );
      result = { status: outcome.ok ? 'done' : 'failed', message: outcome.message, deviceId };
      await this.log(
        outcome.ok ? 'info' : 'warn',
        'command',
        `Comando ${command.type} ${outcome.ok ? 'completado' : 'fallido'}: ${outcome.message}`,
        command.id,
      );
    }

    try {
      await firstValueFrom(
        this.http.post(`${this.apiUrl}/pos/commands/${encodeURIComponent(command.id)}/result`, result),
      );
      this.unreported.delete(command.id);
    } catch (error: unknown) {
      this.unreported.set(command.id, result);
      await this.log(
        'warn',
        'command',
        `No se pudo reportar el resultado del comando: ${getApiErrorMessage(error)}`,
        command.id,
      );
    }
  }

  private execute(command: PosCommand): Promise<RepairOutcome> {
    switch (command.type) {
      case 'retrySale':
        return this.repair.retrySale(command.targetLocalId);
      case 'retryCashSession':
        return this.repair.retryTarget('cashSession', command.targetLocalId);
      case 'retryProduct':
        return this.repair.retryTarget('product', command.targetLocalId);
      case 'sendSaleToUnreconciled':
        return this.repair.sendSaleToUnreconciled(command.targetLocalId, command.note);
      default:
        return Promise.resolve({ ok: false, message: `Comando desconocido: ${String(command.type)}` });
    }
  }

  private async log(
    level: 'info' | 'warn' | 'error',
    entity: string,
    message: string,
    ref: string | null,
  ): Promise<void> {
    try {
      await window.electronAPI?.syncLog?.append({ level, entity, message, ref });
    } catch {
      // La bitácora es de apoyo: si no se puede escribir, se sigue.
    }
  }
}
