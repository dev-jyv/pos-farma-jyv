import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { catchError, finalize, forkJoin, from, of } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { CashOnHand } from '../../../core/electron/window.d';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashMovement, CashSession } from '../../../shared/models';
import { CashMovementService } from '../services/cash-movement.service';
import { CashSessionService } from '../services/cash-session.service';

type CashBoxType = 'deposit' | 'withdrawal';

const EMPTY_BALANCE: CashOnHand = {
  amount: 0,
  lastClosedAt: null,
  countedAtLastClose: null,
  movementsSinceClose: 0,
};

/**
 * Caja de la farmacia (solo admin, `cashSessions:write`): entrada o salida de
 * efectivo sin venta de por medio. Local-first, igual que el gasto: escribe en
 * SQLite y el push ocurre en `SyncScheduler`.
 *
 * Híbrido a propósito. Si hay turno abierto el movimiento se le cuelga y baja
 * (o sube) su efectivo esperado, porque el cajero va a contar físicamente ese
 * mismo dinero y si no, cerraría con un faltante sin explicación. Si no hay
 * turno, queda con `cashSessionId: null` y fuera de todo corte.
 */
@Component({
  selector: 'app-cash-box',
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
    TableModule,
  ],
  templateUrl: './cash-box.html',
})
export class CashBoxScreen {
  private readonly cashMovementService = inject(CashMovementService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly authService = inject(AuthService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  /**
   * Turno abierto en **el equipo**, no el del admin que está en pantalla.
   *
   * Esta pantalla es solo de admin, así que preguntar por el turno propio
   * devolvía `null` casi siempre: el retiro se guardaba sin turno, no bajaba el
   * efectivo esperado, y el cajero cerraba con un faltante a su nombre por un
   * movimiento que autorizó el admin. El dinero sale del mismo cajón.
   */
  readonly turnoDelEquipo = signal<CashSession | null>(null);
  readonly cashSessionOpen = computed(() => this.turnoDelEquipo() !== null);

  readonly type = signal<CashBoxType>('withdrawal');
  readonly amount = signal<number | null>(null);
  readonly reason = signal('');
  readonly saving = signal(false);

  /**
   * Efectivo que DEBE haber en la caja: lo contado en el último corte más o
   * menos lo movido después. No es la suma de todos los movimientos —los de un
   * turno ya entraron al conteo de su corte, y restarlos otra vez los contaría
   * dos veces y sacaba el saldo en negativo.
   */
  readonly balance = signal<CashOnHand>(EMPTY_BALANCE);
  readonly movements = signal<CashMovement[]>([]);
  readonly loading = signal(false);
  /** Movimientos por página. El historial local no se trae entero: se pagina en SQLite. */
  readonly pageSize = 50;
  /** Primera fila de la página visible; es lo que `p-table` maneja en modo lazy. */
  readonly first = signal(0);
  readonly total = signal(0);
  /** Banda persistente: el saldo en ceros por un fallo de lectura engaña. */
  readonly loadError = signal<string | null>(null);

  /**
   * `p-select` exige la cadena resuelta, así que se traduce con `instant()` en
   * un `computed` que lee `currentLang()`: reacciona a un cambio de idioma.
   * Estaba a fuego en español, y con la app en inglés el único selector de esta
   * pantalla —el que decide si el dinero entra o sale— se veía en español.
   */
  readonly typeOptions = computed<{ label: string; value: CashBoxType }[]>(() => {
    this.translate.currentLang();
    return [
      { label: this.translate.instant('cashBox.optionWithdrawal') as string, value: 'withdrawal' as const },
      { label: this.translate.instant('cashBox.optionDeposit') as string, value: 'deposit' as const },
    ];
  });

  /** Motivos del bloqueo como llaves de i18n; la plantilla los traduce. */
  readonly blockers = computed<string[]>(() => {
    const reasons: string[] = [];
    if ((this.amount() ?? 0) <= 0) {
      reasons.push('cashBox.noAmount');
    }
    if (!this.reason().trim()) {
      reasons.push('cashBox.noReason');
    }
    if (!this.authService.user()) {
      reasons.push('cashBox.noUser');
    }
    return reasons;
  });

  readonly canSubmit = computed(() => !this.saving() && this.blockers().length === 0);

  constructor() {
    // El turno pudo abrirse en la venta y esta pantalla ser la primera que se
    // visita: refresca en vez de confiar en que `isOpen` ya esté al día.
    this.cashSessionService.refreshCurrent(this.authService.user()?.uid ?? '').subscribe();
    this.cargarTurnoDelEquipo();
    this.load();
  }

  private cargarTurnoDelEquipo(): void {
    const api = window.electronAPI;
    if (!api) {
      return;
    }
    from(api.cashSessions.getOpenLocalAnyUser())
      .pipe(catchError(() => of(null)))
      .subscribe((turno) => this.turnoDelEquipo.set(turno));
  }

  /** Carga saldo y la página visible. Tras registrar un movimiento vuelve a la 1ª. */
  load(resetPage = false): void {
    if (resetPage) {
      this.first.set(0);
    }
    this.loading.set(true);
    this.loadError.set(null);
    forkJoin({
      balance: this.cashSessionService.cashOnHandDetail(),
      page: this.cashMovementService.listPageLocal(
        Math.floor(this.first() / this.pageSize),
        this.pageSize,
      ),
    })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: ({ balance, page }) => {
          this.balance.set(balance);
          this.movements.set(page.items);
          this.total.set(page.total);
          // Borrar movimientos (o filtrar) puede dejar el cursor fuera de rango:
          // sin esto la tabla se queda en una página vacía sin explicación.
          if (page.total > 0 && this.first() >= page.total) {
            this.first.set(Math.max(0, (Math.ceil(page.total / this.pageSize) - 1) * this.pageSize));
            this.load();
          }
        },
        error: () => {
          this.balance.set(EMPTY_BALANCE);
          this.movements.set([]);
          this.total.set(0);
          this.loadError.set(this.translate.instant('cashBox.loadError'));
        },
      });
  }

  /** `p-table` en modo lazy: cada cambio de página vuelve a consultar SQLite. */
  onPageChange(event: { first?: number }): void {
    const first = event.first ?? 0;
    if (first === this.first()) {
      return;
    }
    this.first.set(first);
    this.load();
  }

  save(): void {
    if (this.saving() || !this.canSubmit()) {
      return;
    }
    const user = this.authService.user();
    if (!user) {
      return;
    }
    const cashSessionId = this.turnoDelEquipo()?.id ?? null;
    this.saving.set(true);
    this.cashMovementService
      .create(cashSessionId, {
        type: this.type(),
        amount: this.amount() ?? 0,
        reason: this.reason().trim(),
        createdBy: user.uid,
        createdByLabel: this.authService.profile()?.email ?? undefined,
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.notifications.success(
            this.translate.instant(cashSessionId ? 'cashBox.savedToShift' : 'cashBox.savedToBox'),
          );
          this.amount.set(null);
          this.reason.set('');
          this.load(true);
        },
        error: () => this.notifications.error(this.translate.instant('cashBox.saveError')),
      });
  }

  back(): void {
    void this.router.navigate(['/pos']);
  }
}
