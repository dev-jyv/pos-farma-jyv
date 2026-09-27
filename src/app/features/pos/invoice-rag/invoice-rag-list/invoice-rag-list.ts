import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { InvoiceRagDocument, InvoiceRagDocumentType, InvoiceRagStatus } from '../../../../shared/models';
import {
  INVOICE_RAG_STATUS_OPTIONS,
  INVOICE_RAG_STATUS_SEVERITY,
  INVOICE_RAG_TYPE_OPTIONS,
} from '../invoice-rag.constants';
import { InvoiceRagService } from '../services/invoice-rag.service';

@Component({
  selector: 'app-invoice-rag-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, FormsModule, TranslatePipe, ButtonModule, InputTextModule, SelectModule, TableModule, TagModule],
  templateUrl: './invoice-rag-list.html',
})
export class InvoiceRagList {
  private readonly invoiceRag = inject(InvoiceRagService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  readonly available = this.invoiceRag.available;
  readonly typeOptions = INVOICE_RAG_TYPE_OPTIONS;
  readonly statusOptions = INVOICE_RAG_STATUS_OPTIONS;
  readonly rows = 20;
  readonly rowsPerPageOptions = [20, 50, 100];

  readonly documents = signal<InvoiceRagDocument[]>([]);
  readonly totalRecords = signal(0);
  readonly loading = signal(false);
  readonly term = signal('');
  readonly status = signal<InvoiceRagStatus | null>(null);
  readonly documentType = signal<InvoiceRagDocumentType | null>(null);

  private readonly term$ = new Subject<string>();
  private page = 1;
  private pageSize = this.rows;

  constructor() {
    this.term$.pipe(debounceTime(300), distinctUntilChanged(), takeUntilDestroyed()).subscribe(() => {
      this.page = 1;
      void this.reload();
    });
  }

  onTerm(value: string): void {
    this.term.set(value);
    this.term$.next(value.trim());
  }

  onStatus(value: InvoiceRagStatus | null): void {
    this.status.set(value);
    this.page = 1;
    void this.reload();
  }

  onDocumentType(value: InvoiceRagDocumentType | null): void {
    this.documentType.set(value);
    this.page = 1;
    void this.reload();
  }

  onLazyLoad(event: TableLazyLoadEvent): void {
    this.pageSize = event.rows ?? this.rows;
    this.page = Math.floor((event.first ?? 0) / this.pageSize) + 1;
    void this.reload();
  }

  async reload(): Promise<void> {
    if (!this.available) {
      return;
    }
    this.loading.set(true);
    try {
      const { items, total } = await this.invoiceRag.list({
        term: this.term().trim() || undefined,
        status: this.status() ?? undefined,
        documentType: this.documentType() ?? undefined,
        page: this.page,
        limit: this.pageSize,
      });
      this.documents.set(items);
      this.totalRecords.set(total);
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  severity(status: InvoiceRagStatus) {
    return INVOICE_RAG_STATUS_SEVERITY[status];
  }

  create(): void {
    void this.router.navigate(['/pos/facturas-rag/nuevo']);
  }

  openSearch(): void {
    void this.router.navigate(['/pos/facturas-rag/buscar']);
  }

  open(document: InvoiceRagDocument): void {
    void this.router.navigate(['/pos/facturas-rag', document.id]);
  }
}
