import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';

import { NotificationService } from '../../../../core/notifications/notification.service';
import { PurchaseInvoice } from '../../../../shared/models';
import { InvoiceService } from '../../services/invoice.service';

@Component({
  selector: 'app-invoice-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, TranslatePipe, ButtonModule, ProgressSpinnerModule, TagModule],
  templateUrl: './invoice-detail.html',
})
export class InvoiceDetail {
  private readonly invoicesService = inject(InvoiceService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly invoice = signal<PurchaseInvoice | null>(null);
  readonly loading = signal(true);

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      void this.router.navigate(['/pos/facturas']);
      return;
    }
    this.invoicesService.getById(id).subscribe({
      next: (invoice) => {
        this.invoice.set(invoice);
        this.loading.set(false);
      },
      error: () => {
        this.notifications.error('No se pudo cargar la factura.');
        this.loading.set(false);
      },
    });
  }

  back(): void {
    void this.router.navigate(['/pos/facturas']);
  }
}
