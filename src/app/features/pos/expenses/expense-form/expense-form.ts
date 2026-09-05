import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { finalize } from 'rxjs';

import { AuthService } from '../../../../core/auth/auth.service';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { CashMovement, ExpenseCategory } from '../../../../shared/models';
import {
  EXPENSE_CATEGORIES,
  expenseCategoryKey,
  expenseCategoryNeedsDescription,
} from '../../../../shared/utils/expense-category';
import { addMoney } from '../../../../shared/utils/money';
import { CashMovementService } from '../../services/cash-movement.service';
import { CashSessionService } from '../../services/cash-session.service';

/**
 * Gasto del turno abierto — local-first: escribe directo en SQLite (sin red)
 * vía `CashMovementService`, con `type: 'expense'` fijo. Requiere un turno
 * abierto local (mismo criterio que `ensureShiftOpen()` en la venta).
 */
@Component({
  selector: 'app-expense-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    TranslatePipe,
    ButtonModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
    TooltipModule,
  ],
  templateUrl: './expense-form.html',
})
export class ExpenseForm {
  private readonly cashMovementService = inject(CashMovementService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly authService = inject(AuthService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  readonly cashSessionOpen = this.cashSessionService.isOpen;

  /** Gastos ya registrados en este turno; es la comprobación de lo que va del día. */
  readonly sessionExpenses = signal<CashMovement[]>([]);
  readonly expensesLoading = signal(false);
  readonly expensesTotal = computed(() =>
    this.sessionExpenses().reduce((total, expense) => addMoney(total, expense.amount), 0),
  );

  /**
   * Gasto que el cajero está corrigiendo, o `null` si captura uno nuevo. El
   * formulario es el mismo: separar "alta" de "edición" en dos pantallas obliga
   * a recordar la cifra vieja para compararla.
   */
  readonly editing = signal<CashMovement | null>(null);

  readonly amount = signal<number | null>(null);
  readonly category = signal<ExpenseCategory | null>(null);
  readonly reason = signal('');
  readonly description = signal('');
  readonly saving = signal(false);

  /**
   * Opciones del `p-select`, que exige una cadena ya resuelta (no admite un
   * pipe). Se traduce con `instant()` dentro de un `computed` que lee
   * `currentLang()`: así el rótulo **sí** se recalcula si cambia el idioma, que
   * es lo que fallaría si `instant()` se llamara una sola vez en el campo.
   */
  readonly categoryOptions = computed<{ label: string; value: ExpenseCategory }[]>(() => {
    this.translate.currentLang();
    return EXPENSE_CATEGORIES.map((value) => ({
      label: this.translate.instant(expenseCategoryKey(value)) as string,
      value,
    }));
  });

  readonly requiresDescription = computed(() => expenseCategoryNeedsDescription(this.category()));

  /**
   * Motivos por los que no se puede guardar, como **llaves** de i18n: la
   * plantilla las traduce con el pipe. Antes eran cadenas en español a fuego, y
   * la app en inglés mostraba los avisos del formulario en español.
   */
  readonly blockers = computed<string[]>(() => {
    const reasons: string[] = [];
    if (!this.cashSessionOpen()) {
      reasons.push('expenses.noSession');
    }
    if (!(this.amount() ?? 0) || (this.amount() ?? 0) <= 0) {
      reasons.push('expenses.noAmount');
    }
    if (!this.category()) {
      reasons.push('expenses.noCategory');
    }
    if (this.requiresDescription() && !this.description().trim()) {
      reasons.push('expenses.descriptionRequired');
    }
    return reasons;
  });

  readonly canSubmit = computed(() => !this.saving() && this.blockers().length === 0);

  /** Carga un gasto existente en el formulario para corregirlo. */
  edit(expense: CashMovement): void {
    this.editing.set(expense);
    this.amount.set(expense.amount);
    this.category.set((expense.category as ExpenseCategory | null) ?? null);
    this.description.set(expense.description ?? '');
    // El motivo se guarda como "Categoría: detalle"; al editar se muestra solo
    // el detalle, que es lo que el cajero escribió.
    const label = this.categoryLabel(expense.category);
    this.reason.set(
      expense.reason?.startsWith(`${label}: `) ? expense.reason.slice(label.length + 2) : '',
    );
  }

  cancelEdit(): void {
    this.editing.set(null);
    this.resetForm();
  }

  private resetForm(): void {
    this.amount.set(null);
    this.category.set(null);
    this.reason.set('');
    this.description.set('');
  }

  constructor() {
    // El turno pudo abrirse en otra pantalla (login/venta); esta pantalla puede
    // ser la primera que visita el cajero en la sesión, así que refresca el
    // estado local en vez de asumir que `current`/`isOpen` ya están al día.
    this.cashSessionService
      .refreshCurrent(this.authService.user()?.uid ?? '')
      .subscribe(() => this.loadSessionExpenses());
  }

  /**
   * Gastos del turno abierto, leídos de SQLite: sin red, y lo que ve el cajero es
   * exactamente lo que va a descontar su corte. Un formulario a ciegas invita a
   * capturar el mismo gasto dos veces.
   */
  private loadSessionExpenses(): void {
    const session = this.cashSessionService.current();
    if (!session) {
      this.sessionExpenses.set([]);
      return;
    }
    this.expensesLoading.set(true);
    this.cashMovementService
      .listForSession(session.id)
      .pipe(finalize(() => this.expensesLoading.set(false)))
      .subscribe({
        next: (movements) =>
          this.sessionExpenses.set(movements.filter((movement) => movement.type === 'expense')),
        error: () => this.sessionExpenses.set([]),
      });
  }

  /** Llave de i18n del rótulo; la plantilla la traduce con el pipe. */
  categoryKey(category: ExpenseCategory | null | undefined): string {
    return expenseCategoryKey(category);
  }

  categoryLabel(category: ExpenseCategory | null | undefined): string {
    const key = expenseCategoryKey(category);
    return key ? (this.translate.instant(key) as string) : (category ?? '');
  }

  save(): void {
    if (this.saving() || !this.canSubmit()) {
      return;
    }
    const editing = this.editing();
    if (editing) {
      this.saveEdit(editing);
      return;
    }
    const session = this.cashSessionService.current();
    const user = this.authService.user();
    const category = this.category();
    if (!session || !user || !category) {
      return;
    }
    this.saving.set(true);
    this.cashMovementService
      .create(session.id, {
        type: 'expense',
        amount: this.amount() ?? 0,
        reason: this.buildReason(category),
        category,
        description: this.description().trim() || undefined,
        createdBy: user.uid,
        createdByLabel: this.authService.profile()?.email ?? undefined,
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.notifications.success(this.translate.instant('expenses.saved'));
          // Se queda en la pantalla: el gasto recién capturado aparece en la lista
          // del turno, que es la confirmación de que quedó registrado. Salir a la
          // venta dejaba al cajero sin ver el resultado de lo que acababa de hacer.
          this.resetForm();
          this.loadSessionExpenses();
        },
        error: () => this.notifications.error(this.translate.instant('expenses.saveError')),
      });
  }

  /**
   * Guarda la corrección. Al recargar la lista, el total del turno y el efectivo
   * esperado del corte quedan al día: ambos se derivan de las filas locales, así
   * que la caja refleja el cambio sin depender de la red.
   */
  private saveEdit(editing: CashMovement): void {
    const category = this.category();
    if (!category) {
      return;
    }
    this.saving.set(true);
    this.cashMovementService
      .updateExpense(editing.id, {
        amount: this.amount() ?? 0,
        reason: this.buildReason(category),
        category,
        description: this.description().trim() || undefined,
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.notifications.success(this.translate.instant('expenses.updated'));
          this.editing.set(null);
          this.resetForm();
          this.loadSessionExpenses();
        },
        error: (error: unknown) =>
          this.notifications.error(
            error instanceof Error
              ? error.message
              : this.translate.instant('expenses.updateError'),
          ),
      });
  }

  cancel(): void {
    void this.router.navigate(['/pos']);
  }

  /**
   * El motivo corto que ve el corte de caja: la etiqueta de la categoría, o el
   * texto libre si lo hay. Se resuelve con `instant()` porque esto **se guarda**
   * en la fila del movimiento y el corte lo imprime tal cual: no puede ser una
   * llave sin traducir.
   */
  private buildReason(category: ExpenseCategory): string {
    const label = this.categoryLabel(category) || category;
    const detail = this.reason().trim();
    return detail ? `${label}: ${detail}` : label;
  }
}
