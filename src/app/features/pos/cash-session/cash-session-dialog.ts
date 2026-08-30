import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';

import { NotificationService } from '../../../core/notifications/notification.service';
import { CashSession, CashSessionCut, PaymentMethod } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { TicketPrintService } from '../ticket/ticket-print.service';

@Component({
  selector: 'app-cash-session-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, FormsModule, TranslatePipe, ButtonModule, DialogModule, InputNumberModule],
  templateUrl: './cash-session-dialog.html',
})
export class CashSessionDialog {
  private readonly cashSessionService = inject(CashSessionService);
  private readonly notifications = inject(NotificationService);
  private readonly ticketPrint = inject(TicketPrintService);
  private readonly translate = inject(TranslateService);

  readonly visible = input(false);
  readonly session = input<CashSession | null>(null);

  readonly closed = output<void>();

  readonly mode = computed<'open' | 'close' | 'result'>(() => {
    if (this.closeResult()) {
      return 'result';
    }
    return this.session() ? 'close' : 'open';
  });
  readonly openingAmount = signal(0);
  readonly countedCashAmount = signal(0);
  /**
   * El campo de efectivo contado se precarga con lo esperado: sin exigir que el cajero
   * lo toque, cerrar el turno confirmaría un arqueo que nadie contó (y en un turno sin
   * ventas, un $0.00 que cuadra por accidente).
   */
  readonly countedTouched = signal(false);
  readonly submitting = signal(false);
  readonly summaryLoading = signal(false);
  readonly preview = signal<CashSessionCut | null>(null);
  readonly closeResult = signal<CashSessionCut | null>(null);

  readonly expectedCash = computed(() => {
    const cut = this.preview() ?? this.closeResult();
    if (!cut) {
      return 0;
    }
    return cut.expectedCashAmount ?? cut.summary.cashInDrawer;
  });
  readonly difference = computed(() => this.countedCashAmount() - this.expectedCash());

  readonly methods: PaymentMethod[] = ['cash', 'card', 'transfer', 'mixed'];

  constructor() {
    effect(() => {
      if (!this.visible()) {
        return;
      }
      this.openingAmount.set(0);
      this.countedCashAmount.set(0);
      this.countedTouched.set(false);
      this.submitting.set(false);
      this.closeResult.set(null);
      const session = this.session();
      if (session) {
        this.loadSummary(session.id);
      } else {
        this.preview.set(null);
      }
    });
  }

  confirmOpen(): void {
    this.submitting.set(true);
    this.cashSessionService.open(this.openingAmount()).subscribe({
      next: () => {
        this.submitting.set(false);
        this.closed.emit();
      },
      error: () => {
        this.submitting.set(false);
        this.notifications.error(this.translate.instant('cashCut.openError'));
      },
    });
  }

  setCountedCash(value: number | null): void {
    this.countedCashAmount.set(value ?? 0);
    this.countedTouched.set(true);
  }

  /**
   * Cerrar turno es irreversible. Con diferencia distinta de cero el cajero debe
   * confirmarla explícitamente: casi siempre es un conteo a medias, no un faltante real.
   */
  requestClose(): void {
    if (!this.countedTouched()) {
      return;
    }
    const diff = this.difference();
    if (diff !== 0) {
      const label = diff > 0 ? 'sobrante' : 'faltante';
      const confirmed = window.confirm(
        `El arqueo tiene un ${label} de $${Math.abs(diff).toFixed(2)}. ` +
          'El cierre no se puede deshacer. ¿Cerrar el turno de todos modos?',
      );
      if (!confirmed) {
        return;
      }
    }
    this.confirmClose();
  }

  confirmClose(): void {
    const session = this.session();
    if (!session) {
      return;
    }
    this.submitting.set(true);
    this.cashSessionService.close(session.id, this.countedCashAmount()).subscribe({
      next: (result) => {
        this.submitting.set(false);
        this.closeResult.set(result);
        this.preview.set(result);
      },
      error: () => {
        this.submitting.set(false);
        this.notifications.error(this.translate.instant('cashCut.closeError'));
      },
    });
  }

  printCut(): void {
    const result = this.closeResult();
    if (!result) {
      return;
    }
    const counted = result.session.countedCashAmount ?? this.countedCashAmount();
    const expected = result.expectedCashAmount ?? result.summary.cashInDrawer;
    this.ticketPrint.printCashCut({
      session: result.session,
      summary: result.summary,
      expectedCashAmount: expected,
      countedCashAmount: counted,
      cashDifference: result.session.cashDifference ?? counted - expected,
    });
  }

  finish(): void {
    this.closeResult.set(null);
    this.closed.emit();
  }

  cancel(): void {
    if (this.mode() === 'result') {
      this.finish();
      return;
    }
    this.closed.emit();
  }

  private loadSummary(sessionId: string): void {
    this.summaryLoading.set(true);
    this.cashSessionService.getSummary(sessionId).subscribe({
      next: (cut) => {
        this.preview.set(cut);
        this.countedCashAmount.set(cut.expectedCashAmount ?? cut.summary.cashInDrawer);
        this.summaryLoading.set(false);
      },
      error: () => {
        this.summaryLoading.set(false);
        this.notifications.error(this.translate.instant('cashCut.summaryError'));
      },
    });
  }
}
