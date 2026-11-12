import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly messageService = inject(MessageService);
  private readonly translate = inject(TranslateService);

  success(detail: string): void {
    this.messageService.add({ severity: 'success', summary: this.translate.instant('common.ok'), detail });
  }

  error(detail: string): void {
    this.messageService.add({ severity: 'error', summary: this.translate.instant('common.error'), detail });
  }

  /** Aviso que el cajero tiene que leer antes de seguir: dura más que un éxito. */
  warn(detail: string, summary?: string): void {
    this.messageService.add({
      severity: 'warn',
      summary: summary ?? this.translate.instant('common.attention'),
      detail,
      life: 10_000,
    });
  }

  /**
   * La sesión del backend expira a las 24:00 de Ciudad de México, no a las 24 h de
   * haber entrado: el mensaje tiene que decirlo o el cajero cree que es una falla.
   */
  sessionExpired(detail?: string): void {
    this.messageService.add({
      severity: 'warn',
      summary: this.translate.instant('common.sessionExpired'),
      detail: detail ?? this.translate.instant('common.sessionExpiredDetail'),
      life: 10_000,
    });
  }
}
