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
import { roundMoney } from '../../../shared/utils/money';
import { CashSessionService } from '../services/cash-session.service';
import { SyncScheduler } from '../../../core/sync/sync-scheduler.service';
import { TicketPrintService } from '../ticket/ticket-print.service';

/**
 * Turno de caja — local-first: abrir/cerrar y ver el efectivo esperado no
 * pasan por red (`CashSessionService.openLocal`/`liveSummary`/`closeLocal`).
 * El cierre siempre procede; si hay diferencia, este componente confirma con
 * el cajero **in-dialog** (no `window.confirm`) que quedará como ajuste
 * pendiente de un administrador — nunca bloquea el cierre en sí.
 */
/** Máximo que el corte espera a sincronizar antes de mostrarse con lo que haya. */
const SYNC_BEFORE_CLOSE_TIMEOUT_MS = 20_000;

@Component({
  selector: 'app-cash-session-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, FormsModule, TranslatePipe, ButtonModule, DialogModule, InputNumberModule],
  templateUrl: './cash-session-dialog.html',
})
export class CashSessionDialog {
  private readonly cashSessionService = inject(CashSessionService);
  private readonly syncScheduler = inject(SyncScheduler);
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
  /**
   * Mientras se sube el corte no hay salida: ni la X, ni Esc, ni el clic fuera.
   * Cerrar a media subida deja al cajero sin saber si el corte llegó.
   */
  readonly canDismiss = computed(
    () => !this.syncing() && (this.mode() !== 'open' || this.dismissible()),
  );
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
  /**
   * El cierre local ya pasó y se está subiendo. Bloquea el diálogo: sin esto el
   * cajero avanzaba —o cerraba con la X— mientras los movimientos, las ventas y
   * el cierre seguían viajando.
   */
  readonly syncing = signal(false);
  /**
   * `pre` = subiendo cola con el turno aún abierto (antes del corte).
   * `post` = subiendo el cierre recién hecho. Misma UI, textos distintos.
   */
  readonly syncPhase = signal<'pre' | 'post' | null>(null);
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

  readonly difference = computed(() =>
    roundMoney(this.countedCashAmount() - this.expectedTotalCash()),
  );

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

  /**
   * Sube lo pendiente **antes** de mostrar el corte, con el turno todavía
   * abierto aquí y en el servidor.
   *
   * Dos razones, y las dos se vieron en producción. Una: un turno cerrado no
   * acepta movimientos ni ventas, así que lo que quedara en cola rebotaba con
   * "el turno de caja ya está cerrado" y el cajero se quedaba con un aviso rojo
   * que no podía resolver. Otra: el desglose que firma es el del servidor, y si
   * hay gastos o ventas sin subir, la cifra que cuenta no es la que quedará
   * asentada.
   *
   * Va aquí y no en cada botón porque el corte se abre desde varios sitios (la
   * barra de venta, el flujo de cerrar sesión, el cierre de la app).
   */
  private async flushBeforeClosing(): Promise<void> {
    // Mismo motor que el botón Sincronizar (push + pull), no solo el push.
    this.syncPhase.set('pre');
    this.syncing.set(true);
    // Tope de espera: sin red, el diálogo no se puede cerrar mientras sincroniza
    // y el cajero quedaba atrapado hasta que vencieran los timeouts de red.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tope = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SYNC_BEFORE_CLOSE_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.syncScheduler.syncNow(), tope]);
    } catch {
      // Sin red se corta igual: el corte es local y lo pendiente sube después.
    } finally {
      clearTimeout(timer);
      this.syncing.set(false);
      this.syncPhase.set(null);
    }
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
      // El resumen se pide DESPUÉS de vaciar la cola: así refleja lo que el
      // servidor ya tiene, no una foto a medias.
      void this.flushBeforeClosing().then(() => this.loadSummary(session.id));
      return;
    }
    // Modo apertura: no hay turno que cortar, solo el fondo inicial.
    this.summary.set(null);
    this.expectedCash.set(0);
    this.preloadCashOnHand();
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
   * El conteo **puede ser negativo**. No es solo "billetes contados a mano":
   * arrastra el fondo heredado, que ya puede venir en rojo, y la caja acaba en
   * números rojos si se gastó de más o si un movimiento se registró mal. Antes
   * se recortaba a cero, y eso no saldaba nada: falseaba el cierre y escondía
   * el faltante justo en el documento que existe para dejarlo asentado.
   */
  setCountedCash(value: number | null): void {
    this.countedCashAmount.set(value ?? 0);
  }

  /**
   * El fondo **puede ser negativo**: hereda el efectivo del corte anterior, y
   * ese saldo queda en rojo si se retiró más de lo que había en el cajón.
   * Recortarlo a cero no hacía aparecer el dinero — solo abría el turno con un
   * fondo falso, y el faltante reaparecía en el arqueo del cierre siguiente sin
   * que nadie pudiera explicarlo.
   */
  setOpeningAmount(value: number | null): void {
    this.openingAmount.set(value ?? 0);
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
    void this.runCloseWithFullSync(session, user);
  }

  /**
   * Orden: sincronizar (como el botón del header) con el turno aún abierto →
   * cerrar en local → subir el cierre. Si se cerrara primero, gastos y ventas
   * pendientes rebotarían con "el turno de caja ya está cerrado".
   */
  private async runCloseWithFullSync(
    session: CashSession,
    user: { uid: string },
  ): Promise<void> {
    this.syncPhase.set('pre');
    this.syncing.set(true);
    try {
      await this.syncScheduler.syncNow();
    } catch {
      // El corte sigue siendo local: lo que no subió queda en cola.
    } finally {
      this.syncing.set(false);
      this.syncPhase.set(null);
    }

    this.cashSessionService
      .closeLocal(session.id, this.countedCashAmount(), user.uid, this.authService.profile()?.email ?? undefined)
      .subscribe({
        next: (closed) => {
          const expected = closed.expectedCashAmount ?? this.expectedCash();
          const counted = closed.countedCashAmount ?? this.countedCashAmount();
          const resultado = {
            session: closed,
            summary: closed.summary ?? this.summary() ?? this.emptySummary(),
            expectedCashAmount: expected,
            countedCashAmount: counted,
            cashDifference: closed.cashDifference ?? counted - expected,
          };

          this.syncPhase.set('post');
          this.syncing.set(true);
          void this.syncScheduler
            .syncAfterShiftCloseAsync()
            .catch(() => {
              // El push ya deja el registro como pendiente o bloqueado y la
              // barra del shell lo muestra; tragarlo aquí evita que un fallo de
              // red esconda un corte que en local sí quedó cerrado.
            })
            .finally(() => {
              this.syncing.set(false);
              this.syncPhase.set(null);
              this.submitting.set(false);
              this.closeResult.set(resultado);
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
