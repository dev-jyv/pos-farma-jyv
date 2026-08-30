import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';

import { AuthService } from '../../../core/auth/auth.service';
import { getApiErrorMessage } from '../../../core/api/api.utils';
import { NotificationService } from '../../../core/notifications/notification.service';
import { ControlledGroup } from '../../../shared/models';
import { CONTROLLED_GROUPS, CONTROLLED_GROUP_RULES } from '../../../shared/utils/controlled';
import {
  endOfZonedDay,
  startOfZonedDay,
  validateDateRange,
  zonedYmd,
} from '../../../shared/utils/date-range';
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

/**
 * Tope por página. El backend admite hasta 1000 para este endpoint, pero 100 es
 * el máximo que acepta cualquier versión desplegada: pedir más devolvía un 400 y
 * la pantalla quedaba con una hoja vacía indistinguible de un libro sin
 * movimientos. Para el periodo completo está `exportCsv()`, que no pagina.
 */
const PAGE_LIMIT = 100;

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
 *
 * Regla que gobierna toda la pantalla: **la hoja impresa no puede afirmar nada que
 * no se haya verificado**. Ni un periodo que no se consultó, ni un total que puede
 * estar truncado, ni un grupo que en realidad no vino en el renglón.
 */
@Component({
  selector: 'app-controlled-ledger',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, ButtonModule, SelectModule, TableModule, TooltipModule],
  templateUrl: './controlled-ledger.html',
  styleUrl: './controlled-ledger.css',
})
export class ControlledLedger {
  private readonly ledgerService = inject(ControlledLedgerService);
  private readonly notifications = inject(NotificationService);
  private readonly authService = inject(AuthService);

  readonly entries = signal<ControlledLedgerEntry[]>([]);
  readonly loading = signal(false);
  readonly exporting = signal(false);
  readonly from = signal(zonedYmd(new Date()));
  readonly to = signal(zonedYmd(new Date()));
  readonly group = signal<ControlledGroup | null>(null);

  /**
   * Periodo realmente consultado, distinto de lo que hay en los campos. El
   * encabezado y el pie imprimen **este**: antes bastaba teclear otras fechas y
   * pulsar Imprimir para obtener una hoja firmada que declaraba un periodo y
   * contenía los renglones de otro.
   */
  readonly appliedFrom = signal(this.from());
  readonly appliedTo = signal(this.to());
  readonly appliedGroup = signal<ControlledGroup | null>(null);

  readonly generatedAt = signal(new Date());
  readonly loadError = signal<string | null>(null);
  /** Total del periodo según el servidor; mayor que `entries()` si se truncó. */
  readonly totalInPeriod = signal<number | null>(null);

  readonly pharmacy = environment.pharmacy;
  readonly canRead = computed(() => this.authService.can('inventory', 'read'));

  /** Motivo por el que el rango capturado no se puede consultar, o `null`. */
  readonly rangeError = computed(() => validateDateRange(this.from(), this.to())?.message ?? null);

  /** Hay más renglones en el periodo de los que se pudieron traer. */
  readonly truncated = computed(() => {
    const total = this.totalInPeriod();
    return total !== null && total > this.entries().length;
  });

  /** Los campos muestran un periodo distinto del que se consultó. */
  readonly rangeDirty = computed(
    () =>
      this.from() !== this.appliedFrom() ||
      this.to() !== this.appliedTo() ||
      this.group() !== this.appliedGroup(),
  );

  /** La hoja no es fiable: no se imprime hasta resolverlo. */
  readonly printBlocked = computed(
    () => this.loading() || this.loadError() !== null || this.rangeError() !== null,
  );

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

  /** Renglones que llegaron sin grupo válido; se cuentan aparte, nunca como VI. */
  readonly ungrouped = computed(() =>
    this.entries().filter((entry) => entry.controlledGroup === null),
  );

  /**
   * Resumen por grupo: es lo primero que revisa el verificador, y evita que tenga
   * que sumar los renglones a mano en la hoja impresa.
   */
  readonly byGroup = computed(() => {
    const totals = new Map<ControlledGroup, { movements: number; quantity: number }>();
    for (const entry of this.entries()) {
      if (entry.controlledGroup === null) {
        continue;
      }
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
    const today = zonedYmd(new Date());
    if (this.to() !== today) {
      return null;
    }
    return (
      this.quickRanges.find((range) => this.from() === zonedYmd(daysAgo(range.days)))?.days ?? null
    );
  });

  private loadedOnce = false;

  constructor() {
    // `GET /auth/me` resuelve **después** del primer render, así que cargar en el
    // constructor salía por `!canRead()` y no volvía a intentarlo nunca: la
    // pantalla se pintaba entera (encabezado, resumen, pie de firmas) sin haber
    // consultado. Se espera a que el permiso quede resuelto.
    effect(() => {
      if (this.canRead() && !this.loadedOnce) {
        this.loadedOnce = true;
        this.reload();
      }
    });
  }

  groupLabel(group: ControlledGroup | null): string {
    return group ? CONTROLLED_GROUP_RULES[group].shortLabel : 'Sin grupo';
  }

  typeLabel(type: ControlledLedgerType): string {
    return TYPE_LABELS[type] ?? type;
  }

  selectQuickRange(days: number): void {
    this.from.set(zonedYmd(daysAgo(days)));
    this.to.set(zonedYmd(new Date()));
    this.reload();
  }

  reload(): void {
    if (!this.canRead()) {
      this.entries.set([]);
      return;
    }
    const invalid = this.rangeError();
    if (invalid) {
      this.notifications.error(invalid);
      return;
    }

    const from = this.from();
    const to = this.to();
    const group = this.group();

    this.loading.set(true);
    this.loadError.set(null);
    this.ledgerService
      .list({
        // Extremos con offset explícito de la zona de la farmacia: el backend
        // filtra por instante y una fecha pelada corría la ventana ~6 h.
        from: startOfZonedDay(from),
        to: endOfZonedDay(to),
        group: group ?? undefined,
        limit: PAGE_LIMIT,
      })
      .subscribe({
        next: (page) => {
          this.entries.set(page.entries);
          this.totalInPeriod.set(page.meta?.total ?? null);
          // El periodo consultado solo se sella cuando la consulta tuvo éxito.
          this.appliedFrom.set(from);
          this.appliedTo.set(to);
          this.appliedGroup.set(group);
          this.generatedAt.set(new Date());
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.loading.set(false);
          // Se vacía la tabla: dejar los renglones anteriores bajo un encabezado
          // con el periodo nuevo produce una hoja que mezcla dos consultas.
          this.entries.set([]);
          this.totalInPeriod.set(null);
          this.loadError.set(getApiErrorMessage(error));
          this.notifications.error(getApiErrorMessage(error));
        },
      });
  }

  print(): void {
    if (this.printBlocked()) {
      return;
    }
    // El sello es la hora de impresión, no la de la consulta.
    this.generatedAt.set(new Date());
    window.print();
  }

  /**
   * Descarga el periodo completo en CSV. Es la salida correcta cuando la vista
   * está truncada: el entregable de una visita no puede ser una página de 100.
   */
  exportCsv(): void {
    if (this.rangeError() || !this.canRead()) {
      return;
    }
    this.exporting.set(true);
    this.ledgerService
      .exportCsv({
        from: startOfZonedDay(this.from()),
        to: endOfZonedDay(this.to()),
        group: this.group() ?? undefined,
      })
      .subscribe({
        next: (blob) => {
          this.exporting.set(false);
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `libro-control-${this.from()}-a-${this.to()}.csv`;
          anchor.click();
          URL.revokeObjectURL(url);
        },
        error: (error: unknown) => {
          this.exporting.set(false);
          this.notifications.error(getApiErrorMessage(error));
        },
      });
  }
}
