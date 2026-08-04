import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';

import { NotificationService } from '../../../core/notifications/notification.service';
import { CashMovementType } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';

@Component({
  selector: 'app-cash-movement-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, DialogModule, InputNumberModule, InputTextModule, SelectModule],
  templateUrl: './cash-movement-dialog.html',
})
export class CashMovementDialog {
  private readonly cashSessionService = inject(CashSessionService);
  private readonly notifications = inject(NotificationService);

  readonly visible = input(false);
  readonly sessionId = input('');

  readonly closed = output<void>();
  readonly saved = output<void>();

  readonly type = signal<CashMovementType>('withdrawal');
  readonly amount = signal(0);
  readonly reason = signal('');
  readonly submitting = signal(false);

  readonly typeOptions: { label: string; value: CashMovementType }[] = [
    { label: 'Depósito / fondo', value: 'deposit' },
    { label: 'Retiro', value: 'withdrawal' },
    { label: 'Gasto', value: 'expense' },
  ];

  constructor() {
    effect(() => {
      if (this.visible()) {
        this.type.set('withdrawal');
        this.amount.set(0);
        this.reason.set('');
        this.submitting.set(false);
      }
    });
  }

  confirm(): void {
    const sessionId = this.sessionId();
    if (!sessionId || this.amount() <= 0 || !this.reason().trim()) {
      this.notifications.error('Completa tipo, monto y motivo.');
      return;
    }
    this.submitting.set(true);
    this.cashSessionService
      .addMovement(sessionId, {
        type: this.type(),
        amount: this.amount(),
        reason: this.reason().trim(),
      })
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.notifications.success('Movimiento de caja registrado.');
          this.saved.emit();
          this.closed.emit();
        },
        error: () => {
          this.submitting.set(false);
          this.notifications.error('No se pudo registrar el movimiento.');
        },
      });
  }

  cancel(): void {
    this.closed.emit();
  }
}
