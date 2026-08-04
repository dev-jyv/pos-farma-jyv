import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CashSessionSummary, PaymentMethod, Sale } from '../../../shared/models';
import { CONTROLLED_GROUP_RULES } from '../../../shared/utils/controlled';
import { environment } from '../../../../environments/environment';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  transfer: 'Transferencia',
  mixed: 'Mixto',
};

@Component({
  selector: 'app-sale-ticket',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe],
  templateUrl: './sale-ticket.html',
  styleUrl: './sale-ticket.css',
  host: {
    '[class.preview]': 'preview()',
  },
})
export class SaleTicket {
  readonly sale = input.required<Sale>();
  readonly cashierLabel = input('');
  readonly preview = input(false);

  readonly pharmacy = environment.pharmacy;
  readonly methodLabel = computed(() => METHOD_LABELS[this.sale().paymentMethod]);
  /**
   * En pago mixto el ticket debe mostrar el reparto; sin él el cliente no puede
   * verificar el cambio contra lo que entregó en efectivo.
   */
  readonly showTenderSplit = computed(
    () => this.sale().cardAmount !== null && this.sale().cashAmount !== null,
  );
  /** Grupos COFEPRIS de la venta; el ticket es parte del rastro de trazabilidad. */
  readonly controlledLabel = computed(() =>
    this.sale()
      .controlledGroups.map((group) => CONTROLLED_GROUP_RULES[group].shortLabel)
      .join(', '),
  );
}

@Component({
  selector: 'app-cash-cut-ticket',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe],
  templateUrl: './cash-cut-ticket.html',
  styleUrl: './sale-ticket.css',
})
export class CashCutTicket {
  readonly openedAt = input.required<Date>();
  readonly closedAt = input<Date | null>(null);
  readonly openingAmount = input.required<number>();
  readonly expectedCashAmount = input.required<number>();
  readonly countedCashAmount = input.required<number>();
  readonly cashDifference = input.required<number>();
  readonly summary = input.required<CashSessionSummary>();

  readonly pharmacy = environment.pharmacy;
  readonly methods: { key: PaymentMethod; label: string }[] = [
    { key: 'cash', label: 'Efectivo' },
    { key: 'card', label: 'Tarjeta' },
    { key: 'transfer', label: 'Transferencia' },
    { key: 'mixed', label: 'Mixto' },
  ];
}
