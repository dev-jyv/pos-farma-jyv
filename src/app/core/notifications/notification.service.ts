import { Injectable, inject } from '@angular/core';
import { MessageService } from 'primeng/api';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly messageService = inject(MessageService);

  success(detail: string): void {
    this.messageService.add({ severity: 'success', summary: 'OK', detail });
  }

  error(detail: string): void {
    this.messageService.add({ severity: 'error', summary: 'Error', detail });
  }

  /** Aviso que el cajero tiene que leer antes de seguir: dura más que un éxito. */
  warn(detail: string, summary = 'Atención'): void {
    this.messageService.add({ severity: 'warn', summary, detail, life: 10_000 });
  }

  /**
   * La sesión del backend expira a las 24:00 de Ciudad de México, no a las 24 h de
   * haber entrado: el mensaje tiene que decirlo o el cajero cree que es una falla.
   */
  sessionExpired(detail?: string): void {
    this.messageService.add({
      severity: 'warn',
      summary: 'Sesión expirada',
      detail:
        detail ??
        'La sesión terminó a las 24:00 (hora del centro). Vuelve a iniciar sesión; el ticket en curso queda guardado.',
      life: 10_000,
    });
  }
}
