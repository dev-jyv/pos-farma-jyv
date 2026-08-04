import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';

import { AuthService } from '../../../core/auth/auth.service';
import { getApiErrorMessage } from '../../../core/api/api.utils';
import { NotificationService } from '../../../core/notifications/notification.service';
import { ControlledGroup } from '../../../shared/models';
import { CONTROLLED_GROUPS, CONTROLLED_GROUP_RULES } from '../../../shared/utils/controlled';
import { environment } from '../../../../environments/environment';
import {
  ControlledLedgerEntry,
  ControlledLedgerService,
  ControlledLedgerType,
} from '../services/controlled-ledger.service';

const TYPE_LABELS: Record<ControlledLedgerType, string> = {
  sale: 'Venta',
  void: 'Anulación',
  return: 'Devolución',
};

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/**
 * Libro de control de medicamentos controlados (COFEPRIS).
 *
 * Se consulta desde la caja porque la visita de verificación ocurre en el mostrador:
 * el verificador pide el libro del periodo y se imprime en el momento. Es de solo
 * lectura — los renglones los escribe el backend dentro de la transacción de venta,
 * anulación o devolución.
 */
@Component({
  selector: 'app-controlled-ledger',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, ButtonModule, SelectModule, TableModule],
  templateUrl: './controlled-ledger.html',
})
export class ControlledLedger {
  private readonly ledgerService = inject(ControlledLedgerService);
  private readonly notifications = inject(NotificationService);
  private readonly authService = inject(AuthService);

  readonly entries = signal<ControlledLedgerEntry[]>([]);
  readonly loading = signal(false);
  readonly from = signal(isoDate(new Date()));
  readonly to = signal(isoDate(new Date()));
  readonly group = signal<ControlledGroup | null>(null);
  readonly generatedAt = signal(new Date());

  readonly pharmacy = environment.pharmacy;
  readonly canRead = computed(() => this.authService.can('inventory', 'read'));

  readonly groupOptions = [
    { label: 'Todos los grupos', value: null },
    ...CONTROLLED_GROUPS.filter((group) => CONTROLLED_GROUP_RULES[group].requiresLedger).map(
      (group) => ({ label: CONTROLLED_GROUP_RULES[group].label, value: group }),
    ),
  ];

  /** Salidas menos reingresos: es la cifra que debe cuadrar contra existencias. */
  readonly netQuantity = computed(() =>
    this.entries().reduce((sum, entry) => sum + entry.quantity, 0),
  );

  /**
   * Resumen por grupo: es lo primero que revisa el verificador, y evita que tenga
   * que sumar los renglones a mano en la hoja impresa.
   */
  readonly byGroup = computed(() => {
    const totals = new Map<ControlledGroup, { movements: number; quantity: number }>();
    for (const entry of this.entries()) {
      const current = totals.get(entry.controlledGroup) ?? { movements: 0, quantity: 0 };
      current.movements += 1;
      current.quantity += entry.quantity;
      totals.set(entry.controlledGroup, current);
    }
    return CONTROLLED_GROUPS.filter((group) => totals.has(group)).map((group) => ({
      group,
      label: CONTROLLED_GROUP_RULES[group].shortLabel,
      ...totals.get(group)!,
    }));
  });

  readonly quickRanges = [
    { label: 'Hoy', days: 0 },
    { label: '7 días', days: 6 },
    { label: '30 días', days: 29 },
  ];

  /** Rango activo, para marcar el botón correspondiente. */
  readonly activeRangeDays = computed(() => {
    const today = isoDate(new Date());
    if (this.to() !== today) {
      return null;
    }
    return (
      this.quickRanges.find((range) => this.from() === isoDate(daysAgo(range.days)))?.days ?? null
    );
  });

  selectQuickRange(days: number): void {
    this.from.set(isoDate(daysAgo(days)));
    this.to.set(isoDate(new Date()));
    this.reload();
  }

  constructor() {
    this.reload();
  }

  groupLabel(group: ControlledGroup): string {
    return CONTROLLED_GROUP_RULES[group].shortLabel;
  }

  typeLabel(type: ControlledLedgerType): string {
    return TYPE_LABELS[type] ?? type;
  }

  reload(): void {
    if (!this.canRead()) {
      this.entries.set([]);
      return;
    }
    this.loading.set(true);
    this.generatedAt.set(new Date());
    this.ledgerService
      .list({
        from: this.from() || undefined,
        // El backend filtra por instante: sin la hora final el último día quedaría fuera.
        to: this.to() ? `${this.to()}T23:59:59.999` : undefined,
        group: this.group() ?? undefined,
        limit: 200,
      })
      .subscribe({
        next: (entries) => {
          this.entries.set(entries);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.loading.set(false);
          this.notifications.error(getApiErrorMessage(error));
        },
      });
  }

  print(): void {
    window.print();
  }
}
