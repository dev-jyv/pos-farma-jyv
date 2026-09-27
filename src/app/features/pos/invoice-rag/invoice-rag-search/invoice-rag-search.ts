import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { InvoiceRagSearchHit } from '../../../../shared/models';
import { InvoiceRagService } from '../services/invoice-rag.service';

@Component({
  selector: 'app-invoice-rag-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, PercentPipe, FormsModule, TranslatePipe, ButtonModule, InputTextModule, TagModule],
  templateUrl: './invoice-rag-search.html',
})
export class InvoiceRagSearch {
  private readonly invoiceRag = inject(InvoiceRagService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  readonly available = this.invoiceRag.available;
  readonly query = signal('');
  readonly hits = signal<InvoiceRagSearchHit[]>([]);
  readonly searching = signal(false);
  readonly searched = signal(false);

  async search(): Promise<void> {
    const query = this.query().trim();
    if (!query || this.searching()) {
      return;
    }
    this.searching.set(true);
    try {
      this.hits.set(await this.invoiceRag.search(query));
      this.searched.set(true);
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    } finally {
      this.searching.set(false);
    }
  }

  open(hit: InvoiceRagSearchHit): void {
    void this.router.navigate(['/pos/facturas-rag', hit.document.id]);
  }

  back(): void {
    void this.router.navigate(['/pos/facturas-rag']);
  }
}
