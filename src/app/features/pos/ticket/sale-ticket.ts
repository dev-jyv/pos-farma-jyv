import { CurrencyPipe, DatePipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CashSessionSummary, PaymentMethod, Sale, SaleItem, isSaleProductItem } from '../../../shared/models';
import { CONTROLLED_GROUP_RULES } from '../../../shared/utils/controlled';
import { environment } from '../../../../environments/environment';

/** Llaves de i18n (`payment.*`) por método; la plantilla las traduce. */
const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'payment.cash',
  card: 'payment.card',
  transfer: 'payment.transfer',
  mixed: 'payment.mixed',
};

@Component({
  selector: 'app-sale-ticket',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, TranslatePipe],
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

  /**
   * Clave del `@for`: `itemKey` se repite cuando el mismo servicio va con dos
   * doctores o el mismo producto en dos lotes (NG0955). Se agrega la posición.
   */
  trackItem(index: number, item: SaleItem): string {
    return `${index}:${this.itemKey(item)}`;
  }

  /** La promo se imprime con su nombre: el cliente debe ver por qué pagó menos. */
  promoOf(item: SaleItem): { name: string; amount: number } | null {
    if (!isSaleProductItem(item) || !item.promotionName || !item.promotionDiscount) {
      return null;
    }
    return { name: item.promotionName, amount: item.promotionDiscount };
  }

  /** Lo que queda del descuento de la partida fuera de la promo y del cupón. */
  manualDiscountOf(item: SaleItem): number {
    const promo = isSaleProductItem(item) ? (item.promotionDiscount ?? 0) : 0;
    const cupon = isSaleProductItem(item) ? (item.couponDiscount ?? 0) : 0;
    return Math.round((item.discountAmount - promo - cupon) * 100) / 100;
  }

  /** Parte de un cupón de producto en la partida (SPEC 47). */
  couponDiscountOf(item: SaleItem): number {
    return isSaleProductItem(item) ? (item.couponDiscount ?? 0) : 0;
  }

  /**
   * Venta por caja (SPEC 46): "2 cajas × 10 pzas". La partida guarda piezas en
   * `quantity`, así que sin esto el ticket diría "20" junto a un importe de
   * dos cajas.
   */
  boxOf(item: SaleItem): { boxes: number; piecesPerBox: number } | null {
    if (!isSaleProductItem(item) || !item.saleUnit) {
      return null;
    }
    const { boxes, piecesPerBox } = item.saleUnit;
    return { boxes, piecesPerBox };
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
  imports: [CurrencyPipe, DatePipe, TranslatePipe],
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
  readonly methods: { key: PaymentMethod; label: string }[] = (Object.keys(METHOD_LABELS) as PaymentMethod[]).map(
    (key) => ({ key, label: METHOD_LABELS[key] }),
  );
}
