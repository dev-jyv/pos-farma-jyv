import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, map } from 'rxjs';

import { unwrapEntity } from '../api/api.utils';
import { BlockedSyncRecord } from '../electron/window.d';
import { environment } from '../../../environments/environment';
import { BlockedAction } from './sync-diagnosis';

/** Tope del backend (`syncHelpSchema`): más largo responde 400. */
const MAX_REASON_CHARS = 500;

export interface SyncHelpReply {
  explicacion: string;
  pasos: BlockedAction[];
  avisarAdmin: boolean;
}

/**
 * Ayuda con IA para un registro atorado que las reglas locales no reconocen
 * (`diagnosis.code === 'desconocido'`). Va al backend (`POST /assistant/sync-help`),
 * nunca directo a OpenRouter: la llave vive solo allá.
 *
 * Se manda un **resumen**: tipo, código, motivo recortado y la dependencia. Ni
 * cliente, ni partidas, ni payload — el modelo no necesita nada de eso para
 * explicar un motivo de rechazo.
 */
@Injectable({ providedIn: 'root' })
export class SyncHelpService {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);

  private t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(key, params) as string;
  }

  async ask(record: BlockedSyncRecord): Promise<SyncHelpReply> {
    const body = {
      kind: record.kind,
      code: record.diagnosis?.code ?? 'desconocido',
      reason: (record.reason || 'Sin motivo').slice(0, MAX_REASON_CHARS),
      ...(record.diagnosis?.dependency ? { dependency: record.diagnosis.dependency } : {}),
      appVersion: environment.version,
    };
    try {
      return await firstValueFrom(
        this.http
          .post<unknown>(`${environment.apiUrl}/assistant/sync-help`, body)
          .pipe(map((response) => unwrapEntity<SyncHelpReply>(response))),
      );
    } catch (error) {
      throw new Error(this.t(mensajeDeFallo(error)));
    }
  }
}

/** Lo que el cajero lee si la ayuda falla: nunca un error técnico de red. */
function mensajeDeFallo(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 429) {
      return 'shell.blocked.aiError.tooMany';
    }
    if (error.status === 0) {
      return 'shell.blocked.aiError.offline';
    }
  }
  return 'shell.blocked.aiError.unavailable';
}
