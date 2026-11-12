import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';

import { ProductCatalogService } from '../../../features/pos/services/product-catalog.service';
import { StockEntryService } from '../../../features/pos/services/stock-entry.service';
import { NotificationService } from '../../notifications/notification.service';
import { BlockedSyncService } from '../blocked-sync.service';
import { SyncScheduler } from '../sync-scheduler.service';

/**
 * "N sin subir · Subir ahora" para altas de producto y entradas de stock.
 *
 * El envío automático ya sube cada alta a los pocos segundos; esto es para
 * cuando el cajero quiere confirmarlo en el momento (p. ej. antes de que el
 * panel la vea).
 *
 * **Solo sube, nunca baja el catálogo**, por eso no gasta el cupo de 15 min de
 * "Sincronizar": ese cupo existe por las lecturas del pull. Usa el mismo
 * `flushPendingNow()` que el cierre de sesión, así que respeta el orden
 * (catálogo → entradas → turnos/gastos/ventas), la fila única de empujes y el
 * filtro por cajero. No reintenta lo rechazado: eso se corrige desde
 * "Rechazados", y reenviarlo a ciegas solo repetiría el mismo error.
 */
@Component({
  selector: 'app-pending-upload',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, ButtonModule],
  template: `
    @if (visible()) {
      <div class="flex items-center gap-2">
        <span
          class="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800"
          role="status"
        >
          {{ 'pendingUpload.count' | translate: { count: count() } }}
        </span>
        <p-button
          size="small"
          icon="pi pi-cloud-upload"
          [outlined]="true"
          [label]="'pendingUpload.upload' | translate"
          [loading]="uploading()"
          (onClick)="upload()"
        />
      </div>
    }
  `,
})
export class PendingUpload {
  private readonly catalog = inject(ProductCatalogService);
  private readonly stockEntries = inject(StockEntryService);
  private readonly scheduler = inject(SyncScheduler);
  private readonly blockedSync = inject(BlockedSyncService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  private t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(key, params) as string;
  }

  readonly uploading = signal(false);
  readonly count = computed(() => this.catalog.pendingCount() + this.stockEntries.pendingCount());
  /** Fuera de Electron no hay cola local que subir. */
  readonly visible = computed(() => !!window.electronAPI && (this.count() > 0 || this.uploading()));

  constructor() {
    // Al entrar a la pantalla el conteo puede venir de antes del último envío.
    this.stockEntries.refreshPending();
  }

  async upload(): Promise<void> {
    if (this.uploading()) {
      return;
    }
    if (!navigator.onLine) {
      this.notifications.error(this.t('pendingUpload.msg.offline'));
      return;
    }
    this.uploading.set(true);
    try {
      await this.scheduler.flushPendingNow();
      await this.blockedSync.refresh();
      this.stockEntries.refreshPending();
      const pending = await this.countPending();
      const rejected = this.blockedSync.count();
      // Los rechazados pueden ser de antes: no convierten en fallo una subida que
      // sí vació la cola, pero se mencionan para que no queden olvidados.
      if (pending > 0) {
        this.notifications.error(
          rejected > 0
            ? this.t('pendingUpload.msg.pendingAndRejected', { pending, rejected })
            : this.t('pendingUpload.msg.pending', { pending }),
        );
      } else if (rejected > 0) {
        this.notifications.warn(
          this.t('pendingUpload.msg.uploadedWithRejected', { rejected }),
        );
      } else {
        this.notifications.success(this.t('pendingUpload.msg.done'));
      }
    } catch (error) {
      this.notifications.error(
        this.t('pendingUpload.msg.failed', { message: (error as Error)?.message ?? this.t('pendingUpload.msg.unknownError') }),
      );
    } finally {
      this.uploading.set(false);
    }
  }

  /** Conteo fresco, sin esperar a que se refresquen las señales. */
  private async countPending(): Promise<number> {
    const api = window.electronAPI;
    if (!api) {
      return 0;
    }
    const [catalog, entries] = await Promise.all([
      api.catalog.getPendingCatalogPush().catch(() => []),
      api.catalog.getPendingStockEntries({ includeWaiting: true }).catch(() => []),
    ]);
    return catalog.length + entries.length;
  }
}
