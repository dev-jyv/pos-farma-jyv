import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';

import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { PaymentMethod, Sale } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { SaleService } from '../services/sale.service';
import { SaleTicket } from '../ticket/sale-ticket';
import { TicketPrintService } from '../ticket/ticket-print.service';

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
  readonly detailVisible = signal(false);

  readonly isAdmin = this.authService.isAdmin;
  readonly cashSession = this.cashSessionService.current;

  methodLabelKey(method: PaymentMethod): string {
    return `payment.${method}`;
  }

  constructor() {
    this.cashSessionService.fetchCurrent().subscribe(() => this.reload());
  }

  reload(): void {
    this.loading.set(true);
    const session = this.cashSession();
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const params = session
      ? { cashSessionId: session.id, includeVoided: true }
      : { from, includeVoided: true };

    this.saleService.listAll(params).subscribe({
      next: (sales) => {
        const term = this.search().trim().toLowerCase();
        this.sales.set(
          term
            ? sales.filter(
                (sale) =>
                  sale.folio.toLowerCase().includes(term) ||
                  sale.items.some((item) => item.productName.toLowerCase().includes(term)),
              )
            : sales,
        );
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.notifications.error('No se pudo cargar el historial de ventas.');
      },
    });
  }

  onSearch(term: string): void {
    this.search.set(term);
    this.reload();
  }

  openDetail(sale: Sale): void {
    this.detailSale.set(sale);
    this.detailVisible.set(true);
  }

  print(sale: Sale): void {
    this.ticketPrint.printSale(sale, this.authService.user()?.email ?? sale.cashierId);
  }

  voidSale(sale: Sale): void {
    if (sale.voidedAt || !this.isAdmin()) {
      return;
    }
    if (!window.confirm(`¿Anular la venta ${sale.folio}?`)) {
      return;
    }
    this.saleService.void(sale.id).subscribe({
      next: (voided) => {
        this.sales.update((list) => list.map((item) => (item.id === voided.id ? voided : item)));
        if (this.detailSale()?.id === voided.id) {
          this.detailSale.set(voided);
        }
        this.notifications.success('Venta anulada.');
      },
      error: () => this.notifications.error('No se pudo anular la venta.'),
    });
  }
}
