import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';

import { NotificationService } from '../../../core/notifications/notification.service';
import { PaymentMethod, Sale } from '../../../shared/models';
import { addMoney } from '../../../shared/utils/money';
import { CashSessionService } from '../services/cash-session.service';
import { SaleService } from '../services/sale.service';

type ReportScope = 'session' | 'day';

interface MethodRow {
  method: PaymentMethod;
  label: string;
  count: number;
  total: number;
}

interface HourRow {
  hour: number;
  count: number;
  total: number;
  pct: number;
}

interface TopProductRow {
  productId: string;
  name: string;
  quantity: number;
  total: number;
}

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  transfer: 'Transferencia',
  mixed: 'Mixto',
};

@Component({
  selector: 'app-pos-reports',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, TranslatePipe, ButtonModule, TableModule],
  templateUrl: './reports.html',
})
export class PosReports {
  private readonly saleService = inject(SaleService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly notifications = inject(NotificationService);

  readonly scope = signal<ReportScope>('session');
  readonly sales = signal<Sale[]>([]);
  readonly loading = signal(false);
  readonly generatedAt = signal(new Date());

  readonly cashSession = this.cashSessionService.current;

  readonly scopeOptions = [
    { labelKey: 'reports.scope.session', value: 'session' as ReportScope },
    { labelKey: 'reports.scope.day', value: 'day' as ReportScope },
  ];

  readonly validSales = computed(() => this.sales().filter((sale) => !sale.voidedAt));
  readonly voidedCount = computed(() => this.sales().filter((sale) => sale.voidedAt).length);

  readonly netTotal = computed(() =>
    this.validSales().reduce((sum, sale) => sum + sale.total, 0),
  );
  readonly discountTotal = computed(() =>
    this.validSales().reduce((sum, sale) => sum + sale.discountTotal, 0),
  );
  readonly ticketAverage = computed(() => {
    const count = this.validSales().length;
    return count > 0 ? this.netTotal() / count : 0;
  });

  /**
   * Efectivo cobrado (lo que entró al cajón), con la misma regla que el corte del
   * backend: `cashAmount` es la parte del total pagada en efectivo. En ventas
   * previas al split mixto se reconstruye como `recibido − cambio`; sumar el total
   * de una venta mixta contaría también lo que pagó la tarjeta.
   */
  readonly cashCollected = computed(() =>
    this.validSales().reduce((sum, sale) => {
      if (sale.paymentMethod !== 'cash' && sale.paymentMethod !== 'mixed') {
        return sum;
      }
      const cash = sale.cashAmount ?? (sale.amountReceived ?? 0) - (sale.change ?? 0);
      return addMoney(sum, cash);
    }, 0),
  );

  readonly byMethod = computed<MethodRow[]>(() => {
    const rows = new Map<PaymentMethod, MethodRow>();
    for (const sale of this.validSales()) {
      const row = rows.get(sale.paymentMethod) ?? {
        method: sale.paymentMethod,
        label: METHOD_LABELS[sale.paymentMethod],
        count: 0,
        total: 0,
      };
      row.count += 1;
      row.total += sale.total;
      rows.set(sale.paymentMethod, row);
    }
    return [...rows.values()].sort((a, b) => b.total - a.total);
  });

  readonly byHour = computed<HourRow[]>(() => {
    const buckets = new Map<number, { count: number; total: number }>();
    for (const sale of this.validSales()) {
      const hour = sale.createdAt.getHours();
      const bucket = buckets.get(hour) ?? { count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += sale.total;
      buckets.set(hour, bucket);
    }
    const rows = [...buckets.entries()]
      .map(([hour, bucket]) => ({ hour, ...bucket, pct: 0 }))
      .sort((a, b) => a.hour - b.hour);
    const max = Math.max(...rows.map((row) => row.total), 1);
    return rows.map((row) => ({ ...row, pct: Math.round((row.total / max) * 100) }));
  });

  readonly topByQuantity = computed<TopProductRow[]>(() =>
    this.aggregateProducts().sort((a, b) => b.quantity - a.quantity).slice(0, 10),
  );
  readonly topByAmount = computed<TopProductRow[]>(() =>
    this.aggregateProducts().sort((a, b) => b.total - a.total).slice(0, 10),
  );

  constructor() {
    this.cashSessionService.fetchCurrent().subscribe((session) => {
      if (!session) {
        this.scope.set('day');
      }
      this.reload();
    });
  }

  onScopeChange(scope: ReportScope): void {
    this.scope.set(scope);
    this.reload();
  }

  reload(): void {
    const session = this.cashSession();
    if (this.scope() === 'session' && !session) {
      this.sales.set([]);
      return;
    }
    this.loading.set(true);
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const params =
      this.scope() === 'session' && session
        ? { cashSessionId: session.id, includeVoided: true }
        : { from, includeVoided: true };

    this.saleService.listAll(params).subscribe({
      next: (sales) => {
        this.sales.set(sales);
        this.generatedAt.set(new Date());
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.notifications.error('No se pudo cargar el reporte.');
      },
    });
  }

  print(): void {
    window.print();
  }

  private aggregateProducts(): TopProductRow[] {
    const rows = new Map<string, TopProductRow>();
    for (const sale of this.validSales()) {
      for (const item of sale.items) {
        const row = rows.get(item.productId) ?? {
          productId: item.productId,
          name: item.productName,
          quantity: 0,
          total: 0,
        };
        row.quantity += item.quantity;
        row.total += item.subtotal - item.discountAmount;
        rows.set(item.productId, row);
      }
    }
    return [...rows.values()];
  }
}
