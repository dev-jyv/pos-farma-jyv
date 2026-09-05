import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { forkJoin } from 'rxjs';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashMovement, PaymentMethod, Sale, isSaleProductItem } from '../../../shared/models';
import { addMoney } from '../../../shared/utils/money';
import { CashMovementService } from '../services/cash-movement.service';
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

/** Fila de la tabla de comisiones por doctor. */
interface CommissionRow {
  providerId: string;
  name: string;
  count: number;
  baseAmount: number;
  commissionAmount: number;
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
  private readonly cashMovementService = inject(CashMovementService);
  private readonly notifications = inject(NotificationService);
  private readonly auth = inject(AuthService);

  readonly scope = signal<ReportScope>('session');
  readonly sales = signal<Sale[]>([]);
  readonly movements = signal<CashMovement[]>([]);
  readonly loading = signal(false);
  readonly generatedAt = signal(new Date());

  /**
   * El GET de turno actual falló: no sabemos si hubo ventas o no. Es distinto de
   * "no hay turno abierto" y de "el turno no vendió nada", y la plantilla tiene que
   * decirlo: un reporte en ceros por un error de red es imprimible y engañoso.
   */
  readonly sessionError = signal(false);

  /**
   * Solo tras una carga exitosa se pintan `generatedAt` y los KPIs. Mientras tanto
   * la pantalla sería indistinguible de "no hubo ventas".
   */
  readonly loaded = signal(false);

  readonly cashSession = this.cashSessionService.current;

  readonly pharmacyName = environment.pharmacy.name;
  readonly cashierEmail = computed(() => this.auth.user()?.email ?? '');

  /** Solo para repetir las tarjetas del skeleton mientras carga. */
  readonly skeletonCards = [0, 1, 2, 3, 4, 5, 6];

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

  /**
   * Cobrado con tarjeta, con la misma regla que el efectivo: en una venta mixta
   * solo la parte que pagó la terminal. Sin esto, sumar el total de la venta
   * contaría también el efectivo y el reporte no cuadraría con el corte.
   */
  readonly cardCollected = computed(() =>
    this.validSales().reduce((sum, sale) => {
      if (sale.paymentMethod === 'card') {
        return addMoney(sum, sale.cardAmount ?? sale.total);
      }
      if (sale.paymentMethod === 'mixed') {
        return addMoney(sum, sale.cardAmount ?? 0);
      }
      return sum;
    }, 0),
  );

  private movementTotal(type: CashMovement['type']): number {
    return this.movements()
      .filter((movement) => movement.type === type)
      .reduce((sum, movement) => addMoney(sum, movement.amount), 0);
  }

  readonly expenseTotal = computed(() => this.movementTotal('expense'));
  readonly depositTotal = computed(() => this.movementTotal('deposit'));
  readonly withdrawalTotal = computed(() => this.movementTotal('withdrawal'));
  readonly expenseCount = computed(
    () => this.movements().filter((movement) => movement.type === 'expense').length,
  );
  readonly hasMovements = computed(() => this.movements().length > 0);

  /**
   * Lo que debe quedar en el cajón por estas ventas: el efectivo cobrado menos
   * lo que salió (gastos y retiros) más lo que entró. Es la misma cuenta del
   * corte, sin el fondo inicial —que no es venta del día.
   */
  readonly cashInDrawer = computed(() =>
    addMoney(
      addMoney(this.cashCollected(), this.depositTotal()),
      -addMoney(this.expenseTotal(), this.withdrawalTotal()),
    ),
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
    /**
     * En alcance turno el orden es cronológico *del turno*, no del reloj: con un
     * turno abierto a las 22:00 las ventas de la 1:00 son posteriores, no anteriores.
     * En alcance día el turno no aplica y se ordena por hora natural.
     */
    const openHour =
      this.scope() === 'session' ? this.cashSession()?.openedAt.getHours() : undefined;
    const rank = (hour: number) => (openHour === undefined ? hour : (hour - openHour + 24) % 24);

    const rows = [...buckets.entries()]
      .map(([hour, bucket]) => ({ hour, ...bucket, pct: 0 }))
      .sort((a, b) => rank(a.hour) - rank(b.hour));
    const max = Math.max(...rows.map((row) => row.total), 1);
    return rows.map((row) => ({
      ...row,
      // Piso del 2 %: una hora con ventas nunca debe dibujar una barra de 0 px.
      pct: row.total > 0 ? Math.max(2, Math.round((row.total / max) * 100)) : 0,
    }));
  });

  /* ── Servicios ────────────────────────────────────────────────────────── */

  /**
   * Venta de farmacia y de servicios, separadas. Salen de los campos
   * denormalizados de cada venta, con el default de compatibilidad que hace que
   * toda venta anterior a los servicios sea 100 % farmacia. `netTotal` sigue
   * siendo el gran total: no se le cambia el significado.
   */
  readonly pharmacyNet = computed(() =>
    this.validSales().reduce((sum, sale) => addMoney(sum, sale.pharmacyTotal ?? sale.total), 0),
  );
  readonly servicesNet = computed(() =>
    this.validSales().reduce((sum, sale) => addMoney(sum, sale.servicesTotal ?? 0), 0),
  );
  readonly servicesCount = computed(
    () => this.validSales().filter((sale) => (sale.servicesTotal ?? 0) > 0).length,
  );
  readonly commissionTotal = computed(() =>
    this.validSales().reduce((sum, sale) => addMoney(sum, sale.commissionTotal ?? 0), 0),
  );
  /** Efectivo atribuible a servicios: el número que el cajero compara en el corte. */
  readonly servicesCash = computed(() =>
    this.validSales()
      .filter((sale) => sale.paymentMethod === 'cash' || sale.paymentMethod === 'mixed')
      .reduce((sum, sale) => addMoney(sum, sale.servicesCashAmount ?? 0), 0),
  );
  readonly hasServiceActivity = computed(() => this.servicesNet() > 0 || this.commissionTotal() > 0);

  readonly topServicesByAmount = computed<TopProductRow[]>(() =>
    this.aggregateServices().sort((a, b) => b.total - a.total).slice(0, 10),
  );
  readonly commissionsByProvider = computed<CommissionRow[]>(() => this.aggregateCommissions());

  readonly topByQuantity = computed<TopProductRow[]>(() =>
    this.aggregateProducts().sort((a, b) => b.quantity - a.quantity).slice(0, 10),
  );
  readonly topByAmount = computed<TopProductRow[]>(() =>
    this.aggregateProducts().sort((a, b) => b.total - a.total).slice(0, 10),
  );

  constructor() {
    this.loading.set(true);
    this.cashSessionService.refreshCurrent(this.auth.user()?.uid ?? '').subscribe({
      next: (session) => {
        this.sessionError.set(false);
        if (!session) {
          this.scope.set('day');
        }
        this.reload();
      },
      // Sin este bloque la pantalla quedaba en ceros, con hora fresca y sin un solo
      // aviso: el cajero leía "el turno no vendió nada" y podía imprimirlo.
      error: () => this.failSession(),
    });
  }

  onScopeChange(scope: ReportScope): void {
    this.scope.set(scope);
    this.reload();
  }

  reload(): void {
    const session = this.cashSession();
    if (this.scope() === 'session' && !session) {
      /**
       * Refrescar nunca debe quedarse sin efecto observable: reintenta el GET del
       * turno y, si de verdad no hay turno abierto, cae al día en vez de dejar la
       * pantalla muerta con el único alcance activo deshabilitado.
       */
      this.loading.set(true);
      this.cashSessionService.refreshCurrent(this.auth.user()?.uid ?? '').subscribe({
        next: (fresh) => {
          this.sessionError.set(false);
          if (!fresh) {
            this.scope.set('day');
          }
          this.loadSales();
        },
        error: () => this.failSession(),
      });
      return;
    }
    this.sessionError.set(false);
    this.loadSales();
  }

  private failSession(): void {
    this.loading.set(false);
    this.loaded.set(false);
    this.sessionError.set(true);
    this.sales.set([]);
    this.notifications.error(
      'No se pudo determinar el turno actual. Reintenta o cambia el alcance a "Día".',
    );
  }

  private loadSales(): void {
    this.loading.set(true);
    const session = this.cashSession();
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const params =
      this.scope() === 'session' && session
        ? { cashSessionId: session.id, includeVoided: true }
        : { from, includeVoided: true };

    // Mismo alcance para ventas y movimientos: mezclar los gastos del día con
    // las ventas de un turno daría un "efectivo en cajón" que no cuadra con nada.
    const movementScope =
      this.scope() === 'session' && session ? { cashSessionId: session.id } : { from };

    forkJoin({
      sales: this.saleService.listAll(params),
      movements: this.cashMovementService.listForScope(movementScope),
    }).subscribe({
      next: ({ sales, movements }) => {
        this.sales.set(sales);
        this.movements.set(movements);
        this.generatedAt.set(new Date());
        this.loaded.set(true);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        // El reporte anterior deja de ser válido: no dejarlo en pantalla como si lo fuera.
        this.loaded.set(false);
        this.sales.set([]);
        this.movements.set([]);
        this.notifications.error('No se pudo cargar el reporte.');
      },
    });
  }

  print(): void {
    window.print();
  }

  /**
   * Top de medicamentos. **Solo la rama de producto**: agrupar ciego por id
   * metía los servicios en el Top 10 de la farmacia y desplazaba productos
   * reales. `kind` ausente = venta anterior a los servicios = producto.
   */
  private aggregateProducts(): TopProductRow[] {
    const rows = new Map<string, TopProductRow>();
    for (const sale of this.validSales()) {
      for (const item of sale.items) {
        if (!isSaleProductItem(item)) {
          continue;
        }
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

  /** Top de servicios, en su propia tabla: no compiten con los medicamentos. */
  private aggregateServices(): TopProductRow[] {
    const rows = new Map<string, TopProductRow>();
    for (const sale of this.validSales()) {
      for (const item of sale.items) {
        if (isSaleProductItem(item)) {
          continue;
        }
        const row = rows.get(item.serviceId) ?? {
          productId: item.serviceId,
          name: item.productName,
          quantity: 0,
          total: 0,
        };
        row.quantity += item.quantity;
        row.total += item.subtotal - item.discountAmount;
        rows.set(item.serviceId, row);
      }
    }
    return [...rows.values()];
  }

  /** Comisiones devengadas por doctor: es la tabla con la que se paga. */
  private aggregateCommissions(): CommissionRow[] {
    const rows = new Map<string, CommissionRow>();
    for (const sale of this.validSales()) {
      for (const item of sale.items) {
        if (isSaleProductItem(item) || !item.commissionAmount) {
          continue;
        }
        const id = item.providerId ?? 'sin-doctor';
        const row = rows.get(id) ?? {
          providerId: id,
          name: item.providerName ?? 'Sin doctor asignado',
          count: 0,
          baseAmount: 0,
          commissionAmount: 0,
        };
        row.count += item.quantity;
        row.baseAmount += item.subtotal - item.discountAmount;
        row.commissionAmount += item.commissionAmount;
        rows.set(id, row);
      }
    }
    return [...rows.values()].sort((a, b) => b.commissionAmount - a.commissionAmount);
  }
}
