import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CashSessionSummary, PaymentMethod, Sale, SaleItem, isSaleProductItem } from '../../../shared/models';
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
  /**
   * Identidad de la partida en el ticket impreso: una de servicio no tiene
   * `productId`, así que se usa el id que corresponda a su tipo.
   */
  itemKey(item: SaleItem): string {
    return (isSaleProductItem(item) ? item.productId : item.serviceId) + item.productName;
  }

  /** La promo se imprime con su nombre: el cliente debe ver por qué pagó menos. */
  promoOf(item: SaleItem): { name: string; amount: number } | null {
    if (!isSaleProductItem(item) || !item.promotionName || !item.promotionDiscount) {
      return null;
    }
    return { name: item.promotionName, amount: item.promotionDiscount };
  }

  /** Lo que queda del descuento de la partida fuera de la promo. */
  manualDiscountOf(item: SaleItem): number {
    const promo = isSaleProductItem(item) ? (item.promotionDiscount ?? 0) : 0;
    return Math.round((item.discountAmount - promo) * 100) / 100;
  }

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
