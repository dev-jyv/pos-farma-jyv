import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { finalize } from 'rxjs';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { CashAdjustmentStatus, CashSession } from '../../../../shared/models';
import { CashSessionService } from '../../services/cash-session.service';

/**
 * Auditoría de cortes de caja (solo admin): todas las cajas, no solo la de
 * este equipo — por eso usa `listAudit()` (backend) y no `listLocal()` (SQLite
 * de este equipo). Aprobar/rechazar es la única acción; el POS nunca decide
 * el ajuste por su cuenta.
 */
@Component({
  selector: 'app-cash-session-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    TranslatePipe,
    ButtonModule,
    DialogModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TableModule,
    TagModule,
  ],
  templateUrl: './cash-session-audit.html',
})
export class CashSessionAudit {
  private readonly cashSessionService = inject(CashSessionService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  /** Cortes por página. La paginación es del servidor (`page` + `meta`). */
  readonly pageSize = 50;

  readonly sessions = signal<CashSession[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  /** Primera fila de la página visible; es lo que maneja `p-table` en modo lazy. */
  readonly first = signal(0);
  readonly total = signal(0);
  /** `true` hasta la primera respuesta: la tabla vacía se lee como "no hay cortes". */
  readonly loaded = signal(false);
  readonly initialLoading = computed(() => this.loading() && !this.loaded());

  readonly statusFilter = signal<CashAdjustmentStatus | ''>('pending');
  /**
   * Rótulos del filtro. `p-select` exige la cadena resuelta, así que se traduce
   * con `instant()` dentro de un `computed` que lee `currentLang()`: el rótulo
   * se recalcula si cambia el idioma. Antes estaban a fuego en español y el
   * filtro se veía en español con la app en inglés.
   */
  readonly statusOptions = computed<{ label: string; value: CashAdjustmentStatus | '' }[]>(() => {
    this.translate.currentLang();
    return [
      { label: this.translate.instant('cashCut.audit.filterAll') as string, value: '' as const },
      { label: this.translate.instant('cashCut.audit.filterPending') as string, value: 'pending' as const },
      { label: this.translate.instant('cashCut.audit.filterApproved') as string, value: 'approved' as const },
      { label: this.translate.instant('cashCut.audit.filterRejected') as string, value: 'rejected' as const },
    ];
  });

  readonly reviewing = signal<CashSession | null>(null);
  readonly reviewNote = signal('');
  readonly reviewSaving = signal(false);
  /**
   * Un corte que aún no sincronizó no existe para el backend, así que no se
   * puede resolver su ajuste. `decide()` ya salía en silencio, pero los botones
   * seguían habilitados: el admin los pulsaba y no pasaba nada, sin explicación.
   */
  readonly canDecide = computed(() => !!this.reviewing()?.remoteId);

  constructor() {
    this.reload();
  }

  reload(resetPage = false): void {
    if (resetPage) {
      this.first.set(0);
    }
    this.loading.set(true);
    const status = this.statusFilter();
    this.cashSessionService
      .listAudit({
        ...(status ? { adjustmentStatus: status } : {}),
        page: Math.floor(this.first() / this.pageSize) + 1,
        limit: this.pageSize,
      })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: ({ items, meta }) => {
          this.loaded.set(true);
          this.loadError.set(null);
          this.sessions.set(items);
          // Sin `meta` (backend viejo) el paginador se queda con lo que hay: es
          // preferible una sola página real que prometer páginas inexistentes.
          this.total.set(meta?.total ?? items.length);
          if (meta && meta.total > 0 && this.first() >= meta.total) {
            this.first.set(Math.max(0, (meta.totalPages - 1) * this.pageSize));
            this.reload();
          }
        },
        error: (error: unknown) => {
          this.loaded.set(true);
          this.loadError.set(getApiErrorMessage(error) || 'No se pudo cargar el listado de cortes.');
        },
      });
  }

  /** Mismo umbral que el backend (`>= 0.01`): debajo de un centavo no es faltante. */
  hasDifference(session: { cashDifference: number | null }): boolean {
    return Math.abs(session.cashDifference ?? 0) >= 0.01;
  }

  /** `p-table` lazy: cambiar de página vuelve a consultar al servidor. */
  onPageChange(event: { first?: number }): void {
    const first = event.first ?? 0;
    if (first === this.first()) {
      return;
    }
    this.first.set(first);
    this.reload();
  }

  onStatusChange(status: CashAdjustmentStatus | ''): void {
    this.statusFilter.set(status);
    this.reload(true);
  }

  openReview(session: CashSession): void {
    this.reviewNote.set('');
    this.reviewing.set(session);
  }

  closeReview(): void {
    this.reviewing.set(null);
  }

  decide(decision: 'approved' | 'rejected'): void {
    const session = this.reviewing();
    if (!session?.remoteId || this.reviewSaving()) {
      return;
    }
    this.reviewSaving.set(true);
    this.cashSessionService
      .reviewAdjustment(session.remoteId, decision, this.reviewNote().trim() || undefined)
      .pipe(finalize(() => this.reviewSaving.set(false)))
      .subscribe({
        next: () => {
          this.notifications.success(
            this.translate.instant(
              decision === 'approved' ? 'cashCut.audit.approved' : 'cashCut.audit.rejected',
            ),
          );
          this.reviewing.set(null);
          this.reload();
        },
        error: (error: unknown) =>
          this.notifications.error(getApiErrorMessage(error) || 'No se pudo revisar el ajuste.'),
      });
  }
}
