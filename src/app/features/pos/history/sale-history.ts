import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { Observable, Subject, catchError, debounceTime, distinctUntilChanged, finalize, map, merge, of, switchMap, tap } from 'rxjs';

import { getApiErrorMessage } from '../../../core/api/api.utils';
import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { PaymentMethod, Sale } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { SaleMovement } from '../../../core/electron/window.d';
import { SaleService } from '../services/sale.service';
import { SaleTicket } from '../ticket/sale-ticket';
import { TicketPrintService } from '../ticket/ticket-print.service';

/**
 * El backend filtra por `search`, así que el historial ya no descarga todo el turno
 * para filtrar en cliente: una sola página basta para lo que el cajero consulta.
 */
const PAGE_LIMIT = 100;

@Component({
  selector: 'app-sale-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    TranslatePipe,
    ButtonModule,
    DialogModule,
    InputTextModule,
    TableModule,
    TagModule,
    TooltipModule,
    SaleTicket,
  ],
  templateUrl: './sale-history.html',
})
export class SaleHistory {
  private readonly saleService = inject(SaleService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly authService = inject(AuthService);
  private readonly notifications = inject(NotificationService);
  private readonly ticketPrint = inject(TicketPrintService);

  readonly sales = signal<Sale[]>([]);
  readonly loading = signal(false);
  readonly search = signal('');
  readonly detailSale = signal<Sale | null>(null);
  /** Bitácora de la venta abierta en el detalle: cobro y anulación, con autor. */
  readonly detailMovements = signal<SaleMovement[]>([]);
  readonly detailVisible = signal(false);
  /**
   * Motivo del último listado fallido. Se pinta como banda persistente porque un toast
   * se auto-cierra y deja una tabla con datos viejos que parecen al día — y con esa
   * tabla se cuadra el turno.
   */
  readonly loadError = signal<string | null>(null);
  /** Venta cuya anulación está viajando; bloquea el doble POST /sales/:id/void. */
  readonly voiding = signal<string | null>(null);

  readonly isAdmin = this.authService.isAdmin;
  /**
   * Anular es rutina de mostrador: el cajero se equivoca de producto o el
   * cliente se arrepiente, y eso pasa con la fila enfrente. Basta `sales:write`,
   * el mismo permiso con el que cobra — el backend valida igual. Lo que protege
   * la operación no es negarla, sino que quede firmada (`voidedBy`, `voidedAt`).
   *
   * Una venta de un turno ya cerrado sí sigue siendo de admin: ahí se toca un
   * arqueo firmado. El servidor lo rechaza y el mensaje lo explica.
   */
  readonly canVoid = computed(() => this.authService.can('sales', 'write'));
  readonly cashSession = this.cashSessionService.current;

  /**
   * Sin turno abierto el listado cambia de "este turno" a "desde medianoche local";
   * la pantalla tiene que decirlo, porque es justo la diferencia al cuadrar caja.
   */
  readonly scope = computed<'shift' | 'day'>(() => (this.cashSession() ? 'shift' : 'day'));
  readonly shiftOpenedAt = computed(() => this.cashSession()?.openedAt ?? null);

  /**
   * Ventas encoladas offline (folios `PENDIENTE-…`): viven en localStorage y la API no
   * las conoce, pero el cliente sí puede volver a pedir su ticket. Se listan aparte
   * porque la cola no guarda una venta completa (sin id ni folio real, nada que anular).
   */
  readonly pendingSales = this.saleService.pendingSales;

  /** Se dispara al teclear: con debounce para no lanzar una petición por pulsación. */
  private readonly searchInput$ = new Subject<string>();
  /** Recargas explícitas (alta inicial, botón refrescar, reintento): sin debounce. */
  private readonly reload$ = new Subject<void>();
  /** Elemento que abrió el diálogo, para devolverle el foco al cerrarlo. */
  private detailTrigger: HTMLElement | null = null;

  methodLabelKey(method: PaymentMethod): string {
    return `payment.${method}`;
  }

  /**
   * Misma resolución para el detalle en pantalla y para el ticket impreso: el UID de
   * Firestore no le dice nada a nadie, así que se sustituye por el correo cuando la
   * venta es del cajero con la sesión abierta.
   */
  cashierLabel(sale: Sale): string {
    const user = this.authService.user();
    if (user && user.uid === sale.cashierId) {
      return user.email ?? sale.cashierId;
    }
    return sale.cashierId;
  }

  constructor() {
    merge(
      this.searchInput$.pipe(debounceTime(250), distinctUntilChanged()),
      this.reload$.pipe(map(() => this.search().trim())),
    )
      .pipe(
        tap(() => this.loading.set(true)),
        // `switchMap` cancela la respuesta anterior: al teclear rápido solo cuenta la última.
        switchMap((term) => this.fetchSales(term)),
        takeUntilDestroyed(),
      )
      .subscribe((sales) => {
        if (sales) {
          this.loadError.set(null);
          this.sales.set(sales);
        }
      });

    this.cashSessionService.refreshCurrent(this.authService.user()?.uid ?? '').subscribe(() => this.reload());
  }

  reload(): void {
    this.reload$.next();
  }

  onSearch(term: string): void {
    this.search.set(term);
    this.searchInput$.next(term.trim());
  }

  openDetail(sale: Sale): void {
    // Al cerrar, el foco vuelve aquí; si no, cae en <body> y con 250 filas son
    // cientos de tabulaciones para regresar a la acción de origen.
    this.detailTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.detailSale.set(sale);
    this.detailVisible.set(true);
    this.loadMovements(sale.id);
  }

  onDetailHide(): void {
    this.detailTrigger?.focus();
    this.detailTrigger = null;
  }

  print(sale: Sale): void {
    this.ticketPrint.printSale(sale, this.cashierLabel(sale));
  }

  voidSale(sale: Sale): void {
    if (sale.voidedAt || !this.canVoid() || this.voiding()) {
      return;
    }
    if (!window.confirm(`¿Anular la venta ${sale.folio}?`)) {
      return;
    }
    this.voiding.set(sale.id);
    this.saleService
      .void(sale)
      .pipe(finalize(() => this.voiding.set(null)))
      .subscribe({
        next: (voided) => {
          this.sales.update((list) => list.map((item) => (item.id === voided.id ? voided : item)));
          if (this.detailSale()?.id === voided.id) {
            this.detailSale.set(voided);
            // La anulación acaba de asentar su renglón: el detalle debe mostrarlo
            // sin obligar a cerrar y volver a abrir.
            this.loadMovements(sale.id);
          }
          this.notifications.success('Venta anulada.');
        },
        // El mensaje del backend distingue 403 de rol, "ya está anulada" y turno cerrado.
        error: (error: unknown) =>
          this.notifications.error(getApiErrorMessage(error) || 'No se pudo anular la venta.'),
      });
  }

  /**
   * Quién hizo el movimiento, en legible. La bitácora guarda el correo del
   * momento; si esa venta es vieja y solo tiene el uid, se cae al mismo criterio
   * del ticket (`cashierLabel`) antes que mostrar un identificador de Firestore.
   */
  movementAuthor(movement: SaleMovement): string {
    if (movement.userLabel) {
      return movement.userLabel;
    }
    const user = this.authService.user();
    return user && user.uid === movement.userId ? (user.email ?? movement.userId) : movement.userId;
  }

  /** Quién anuló, en legible, para la fila del listado. */
  voidedByLabel(sale: Sale): string {
    const user = this.authService.user();
    if (user && user.uid === sale.voidedBy) {
      return user.email ?? sale.voidedBy!;
    }
    return sale.voidedBy ?? '';
  }

  private loadMovements(saleId: string): void {
    this.detailMovements.set([]);
    this.saleService.movements(saleId).subscribe({
      next: (movements) => this.detailMovements.set(movements),
      // La bitácora es informativa: si falla, el detalle sigue siendo útil.
      error: () => this.detailMovements.set([]),
    });
  }

  /** `null` = la petición falló; el llamador conserva la lista previa y marca el error. */
  private fetchSales(term: string): Observable<Sale[] | null> {
    const session = this.cashSession();
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const params = session
      ? { cashSessionId: session.id, includeVoided: true }
      : { from, includeVoided: true };

    return this.saleService.list({ ...params, search: term || undefined, limit: PAGE_LIMIT }).pipe(
      tap(() => this.loading.set(false)),
      catchError((error: unknown) => {
        this.loading.set(false);
        this.loadError.set(getApiErrorMessage(error) || 'No se pudo cargar el historial de ventas.');
        this.notifications.error('No se pudo cargar el historial de ventas.');
        return of(null);
      }),
    );
  }
}
