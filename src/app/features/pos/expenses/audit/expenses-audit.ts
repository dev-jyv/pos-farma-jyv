import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { finalize } from 'rxjs';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { CashMovement, ExpenseCategory } from '../../../../shared/models';
import { EXPENSE_CATEGORIES, expenseCategoryKey } from '../../../../shared/utils/expense-category';
import { CashMovementService } from '../../services/cash-movement.service';

/**
 * Auditoría de gastos (solo admin): todos los gastos (`type='expense'`) de
 * todas las cajas, vía `listMovementsAudit()` — el backend, no SQLite local.
 */
@Component({
  selector: 'app-expenses-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, FormsModule, TranslatePipe, ButtonModule, SelectModule, TableModule],
  templateUrl: './expenses-audit.html',
})
export class ExpensesAudit {
  private readonly cashMovementService = inject(CashMovementService);
  private readonly translate = inject(TranslateService);

  /** Gastos por página. La paginación es del servidor (`page` + `meta`). */
  readonly pageSize = 50;

  readonly movements = signal<CashMovement[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  /** Primera fila de la página visible; es lo que maneja `p-table` en modo lazy. */
  readonly first = signal(0);
  readonly total = signal(0);
  /** `true` hasta la primera respuesta: la tabla vacía se lee como "no hay gastos". */
  readonly loaded = signal(false);
  readonly initialLoading = computed(() => this.loading() && !this.loaded());

  readonly categoryFilter = signal<ExpenseCategory | ''>('');
  /**
   * Mismo catálogo que el formulario de gasto (`EXPENSE_CATEGORIES`), más el
   * "todas". Estaba duplicado a fuego y en español: una categoría nueva había
   * que agregarla en dos sitios, y la app en inglés mostraba el filtro en
   * español. `p-select` exige la cadena resuelta, así que se traduce con
   * `instant()` en un `computed` que lee `currentLang()` y por tanto reacciona
   * a un cambio de idioma.
   */
  readonly categoryOptions = computed<{ label: string; value: ExpenseCategory | '' }[]>(() => {
    this.translate.currentLang();
    return [
      { label: this.translate.instant('expenses.audit.filterAll') as string, value: '' as const },
      ...EXPENSE_CATEGORIES.map((value) => ({
        label: this.translate.instant(expenseCategoryKey(value)) as string,
        value,
      })),
    ];
  });

  constructor() {
    this.reload();
  }

  reload(resetPage = false): void {
    if (resetPage) {
      this.first.set(0);
    }
    this.loading.set(true);
    const category = this.categoryFilter();
    this.cashMovementService
      .listMovementsAudit({
        type: 'expense',
        ...(category ? { category } : {}),
        page: Math.floor(this.first() / this.pageSize) + 1,
        limit: this.pageSize,
      })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: ({ items, meta }) => {
          this.loaded.set(true);
          this.loadError.set(null);
          this.movements.set(items);
          this.total.set(meta?.total ?? items.length);
          if (meta && meta.total > 0 && this.first() >= meta.total) {
            this.first.set(Math.max(0, (meta.totalPages - 1) * this.pageSize));
            this.reload();
          }
        },
        error: (error: unknown) => {
          this.loaded.set(true);
          this.loadError.set(getApiErrorMessage(error) || 'No se pudo cargar el listado de gastos.');
        },
      });
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

  onCategoryChange(category: ExpenseCategory | ''): void {
    this.categoryFilter.set(category);
    this.reload(true);
  }

  /**
   * Llave de i18n del rótulo; la tabla la traduce con el pipe. Cadena vacía en
   * un gasto viejo sin categoría, y entonces la celda cae al valor crudo.
   */
  categoryKey(category: ExpenseCategory | null | undefined): string {
    return expenseCategoryKey(category);
  }
}
