import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { finalize } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashSession, CashSessionSummary, PaymentMethod } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { TicketPrintService } from '../ticket/ticket-print.service';

/**
 * Turno de caja — local-first: abrir/cerrar y ver el efectivo esperado no
 * pasan por red (`CashSessionService.openLocal`/`liveSummary`/`closeLocal`).
 * El cierre siempre procede; si hay diferencia, este componente confirma con
 * el cajero **in-dialog** (no `window.confirm`) que quedará como ajuste
 * pendiente de un administrador — nunca bloquea el cierre en sí.
 */
@Component({
  selector: 'app-cash-session-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, FormsModule, TranslatePipe, ButtonModule, DialogModule, InputNumberModule],
  templateUrl: './cash-session-dialog.html',
})
export class CashSessionDialog {
  private readonly cashSessionService = inject(CashSessionService);
  private readonly authService = inject(AuthService);
  private readonly notifications = inject(NotificationService);
  private readonly ticketPrint = inject(TicketPrintService);
  private readonly translate = inject(TranslateService);

  readonly visible = input(false);
  readonly session = input<CashSession | null>(null);
  /**
   * Deja salir del modo `open` sin abrir turno. Por defecto no: al cajero se le
   * cierra el paso a propósito, porque sin turno no puede vender y dejarlo
   * entrar solo lo lleva a descubrirlo al primer cobro. El admin sí entra sin
   * abrir caja —viene a consultar, mover efectivo o dar entrada de stock— y
   * para él este diálogo es un estorbo, no una guarda.
   */
  readonly dismissible = input(false);

  readonly closed = output<void>();
  /**
   * El turno quedó **cerrado de verdad** (corte confirmado). Se separa de `closed`
   * porque quien abre este diálogo desde el flujo de salida necesita distinguir
   * "el cajero cortó caja" de "el cajero canceló": cancelar no puede cerrar sesión
   * ni disparar ninguna otra acción, solo cerrar el modal.
   */
  readonly shiftClosed = output<void>();

  /**
   * Turno con el que se abrió el diálogo. Es una copia a propósito: `session()`
   * viene de `CashSessionService.current`, que pasa a `null` en cuanto el
   * cierre se escribe en local — si el modo se derivara de ahí, al cerrar el
   * diálogo saltaba a "Abrir turno" por un instante (bug visto en caja).
   */
  readonly sessionAtOpen = signal<CashSession | null>(null);

  readonly mode = computed<'open' | 'close' | 'result'>(() => {
    if (this.closeResult()) {
      return 'result';
    }
    return this.sessionAtOpen() ? 'close' : 'open';
  });

  /** Solo el modo `open` se puede bloquear; cerrar y resultado siempre salen. */
  readonly canDismiss = computed(() => this.mode() !== 'open' || this.dismissible());
  readonly openingAmount = signal(0);
  /** Efectivo heredado del cierre anterior, con el que se precarga el fondo. */
  readonly cashOnHand = signal(0);
  readonly cashOnHandLoading = signal(false);
  /**
   * Se precarga con el efectivo esperado, pero el cajero puede cerrar tal cual
   * o dejarlo en $0.00: ambos son cierres válidos. No se le exige tocar el
   * campo — un botón que no responde al primer clic se lee como pantalla
   * trabada, y el arqueo real se controla con la diferencia, no con el foco.
   */
  readonly countedCashAmount = signal(0);
  readonly submitting = signal(false);
  readonly summaryLoading = signal(false);
  readonly summary = signal<CashSessionSummary | null>(null);
  readonly expectedCash = signal(0);
  /** Esperado del bloque de servicios; informativo, el conteo es uno solo. */
  readonly expectedServicesCash = signal(0);
  /**
   * Lo que el cajero debe encontrar en el cajón: es UN solo cajón, así que la
   * diferencia se mide contra la suma de los dos esperados.
   */
  readonly expectedTotalCash = computed(() => this.expectedCash() + this.expectedServicesCash());
  /** `true` mientras se confirma in-dialog una diferencia antes de cerrar. */
  readonly confirmingDifference = signal(false);
  readonly closeResult = signal<{
    session: CashSession;
    summary: CashSessionSummary;
    expectedCashAmount: number;
    countedCashAmount: number;
    cashDifference: number;
  } | null>(null);

  readonly difference = computed(() => this.countedCashAmount() - this.expectedTotalCash());

  readonly methods: PaymentMethod[] = ['cash', 'card', 'transfer', 'mixed'];

  constructor() {
    // Depende SOLO de `visible`: el turno se lee sin rastrear. Si el efecto
    // reaccionara también a `session()`, al cerrar el turno (`current` pasa a
    // null) se re-ejecutaría y el diálogo saltaría a "Abrir turno" con el
    // corte todavía en pantalla.
    effect(() => {
      if (!this.visible()) {
        return;
      }
      untracked(() => this.resetForOpening());
    });
  }

  private resetForOpening(): void {
    this.openingAmount.set(0);
    this.countedCashAmount.set(0);
    this.submitting.set(false);
    this.confirmingDifference.set(false);
    this.closeResult.set(null);
    const session = this.session();
    this.sessionAtOpen.set(session);
    if (session) {
      this.loadSummary(session.id);
    } else {
      this.summary.set(null);
      this.expectedCash.set(0);
      this.preloadCashOnHand();
    }
  }

  /**
   * El fondo inicial arranca con el efectivo que quedó en el cajón al cerrar
   * el turno anterior (ajustado por lo que se metió o sacó entre turnos): ese
   * dinero sigue ahí físicamente, y teclearlo a mano cada mañana es la vía
   * rápida a un fondo mal capturado y un arqueo que no cuadra.
   */
  private preloadCashOnHand(): void {
    this.cashOnHandLoading.set(true);
    this.cashSessionService
      .cashOnHand()
      .pipe(finalize(() => this.cashOnHandLoading.set(false)))
      .subscribe({
        next: (amount) => {
          this.cashOnHand.set(amount);
          // No pisa lo que el cajero ya haya tecleado mientras cargaba.
          if (this.openingAmount() === 0) {
            this.openingAmount.set(amount);
          }
        },
        // Es una comodidad, no un requisito: si la consulta falla, el fondo
        // queda en cero para teclearlo a mano. Sin este manejador el error
        // escapaba del `subscribe` como excepción no controlada.
        error: () => this.cashOnHand.set(0),
      });
  }

  confirmOpen(): void {
    const user = this.authService.user();
    // El doble clic abriría dos turnos: el segundo ahora lo rechaza SQLite,
    // pero el cajero solo vería un error donde en realidad todo salió bien.
    if (!user || this.submitting()) {
      return;
    }
    this.submitting.set(true);
    this.cashSessionService
      .openLocal(user.uid, this.authService.profile()?.email ?? undefined, this.openingAmount())
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.closed.emit();
        },
        error: () => {
          this.submitting.set(false);
          this.notifications.error(this.translate.instant('cashCut.openError'));
        },
      });
  }

  /**
   * Un cajón no puede tener menos de $0.00. El `p-inputnumber` deja teclear el
   * signo, y un conteo en negativo inventaba una diferencia del doble del
   * esperado y la mandaba al ajuste pendiente como si faltara ese dinero.
   */
  setCountedCash(value: number | null): void {
    this.countedCashAmount.set(Math.max(0, value ?? 0));
  }

  /** Mismo motivo: un fondo inicial negativo desalinea el corte desde la apertura. */
  setOpeningAmount(value: number | null): void {
    this.openingAmount.set(Math.max(0, value ?? 0));
  }

  /**
   * Cerrar turno es irreversible. Con diferencia distinta de cero, se muestra
   * el paso de confirmación in-dialog (`confirmingDifference`) explicando que
   * quedará como ajuste pendiente de un administrador — el cierre en sí nunca
   * se bloquea, solo se confirma la intención.
   */
  requestClose(): void {
    // El doble clic del mostrador llega en el mismo tick, antes de que el
    // `[loading]` del botón alcance a deshabilitarlo: sin este candado se
    // escribían DOS cierres del mismo turno (y dos cortes) en SQLite.
    if (this.submitting()) {
      return;
    }
    if (Math.abs(this.difference()) < 0.01) {
      this.confirmClose();
      return;
    }
    this.confirmingDifference.set(true);
  }

  cancelDifferenceConfirm(): void {
    this.confirmingDifference.set(false);
  }

  confirmClose(): void {
    const session = this.sessionAtOpen();
    const user = this.authService.user();
    // Mismo candado que `requestClose()`: a este método también se llega desde
    // el botón "cerrar de todos modos" del paso de confirmación.
    if (!session || !user || this.submitting()) {
      return;
    }
    this.confirmingDifference.set(false);
    this.submitting.set(true);
    this.cashSessionService
      .closeLocal(session.id, this.countedCashAmount(), user.uid, this.authService.profile()?.email ?? undefined)
      .subscribe({
        next: (closed) => {
          this.submitting.set(false);
          const expected = closed.expectedCashAmount ?? this.expectedCash();
          const counted = closed.countedCashAmount ?? this.countedCashAmount();
          this.closeResult.set({
            session: closed,
            summary: closed.summary ?? this.summary() ?? this.emptySummary(),
            expectedCashAmount: expected,
            countedCashAmount: counted,
            cashDifference: closed.cashDifference ?? counted - expected,
          });
        },
        error: () => {
          this.submitting.set(false);
          this.notifications.error(this.translate.instant('cashCut.closeError'));
        },
      });
  }

  printCut(): void {
    const result = this.closeResult();
    if (!result) {
      return;
    }
    this.ticketPrint.printCashCut({
      session: result.session,
      summary: result.summary,
      expectedCashAmount: result.expectedCashAmount,
      countedCashAmount: result.countedCashAmount,
      cashDifference: result.cashDifference,
    });
  }

  finish(): void {
    this.closeResult.set(null);
    // Solo se llega aquí con el corte ya confirmado.
    this.shiftClosed.emit();
    this.closed.emit();
  }

  cancel(): void {
    if (this.mode() === 'result') {
      this.finish();
      return;
    }
    this.closed.emit();
  }

  private loadSummary(sessionId: string): void {
    this.summaryLoading.set(true);
    this.cashSessionService.liveSummary(sessionId).subscribe({
      next: ({ summary, expectedCashAmount, expectedServicesCashAmount }) => {
        this.summary.set(summary);
        this.expectedCash.set(expectedCashAmount);
        this.expectedServicesCash.set(expectedServicesCashAmount ?? 0);
        this.countedCashAmount.set(expectedCashAmount + (expectedServicesCashAmount ?? 0));
        this.summaryLoading.set(false);
      },
      error: () => {
        this.summaryLoading.set(false);
        this.notifications.error(this.translate.instant('cashCut.summaryError'));
      },
    });
  }

  private emptySummary(): CashSessionSummary {
    const zero = { count: 0, total: 0 };
    return {
      salesCount: 0,
      voidedCount: 0,
      byMethod: { cash: { ...zero }, card: { ...zero }, transfer: { ...zero }, mixed: { ...zero } },
      movements: { deposits: { ...zero }, withdrawals: { ...zero }, expenses: { ...zero } },
      grandTotal: 0,
      cashInDrawer: 0,
    };
  }
}
