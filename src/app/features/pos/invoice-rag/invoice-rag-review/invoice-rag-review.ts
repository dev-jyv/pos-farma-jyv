import { DatePipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { AuthService } from '../../../../core/auth/auth.service';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { InvoiceRagDocument } from '../../../../shared/models';
import { InvoiceRagPreview } from '../invoice-rag-preview/invoice-rag-preview';
import { InvoiceRagStockDialog } from '../invoice-rag-stock/invoice-rag-stock-dialog';
import { InvoiceRagFile, InvoiceRagService } from '../services/invoice-rag.service';
import {
  InvoiceRagForm,
  buildInvoiceRagForm,
  buildItemGroup,
  buildTaxGroup,
  readInvoiceRagForm,
} from './invoice-rag-form';
import { INVOICE_RAG_STATUS_SEVERITY, INVOICE_RAG_TYPE_OPTIONS } from '../invoice-rag.constants';

type BusyAction = 'extract' | 'confirm' | 'remove' | 'upload';

@Component({
  selector: 'app-invoice-rag-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PercentPipe,
    ReactiveFormsModule,
    TranslatePipe,
    ButtonModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TagModule,
    TextareaModule,
    InvoiceRagPreview,
    InvoiceRagStockDialog,
    DatePipe,
  ],
  templateUrl: './invoice-rag-review.html',
})
export class InvoiceRagReview implements OnDestroy {
  private readonly invoiceRag = inject(InvoiceRagService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly typeOptions = INVOICE_RAG_TYPE_OPTIONS;
  readonly parties = [
    { key: 'issuer', labelKey: 'invoiceRag.issuer' },
    { key: 'receiver', labelKey: 'invoiceRag.receiver' },
  ] as const;
  readonly statusSeverity = INVOICE_RAG_STATUS_SEVERITY;
  readonly document = signal<InvoiceRagDocument | null>(null);
  readonly file = signal<InvoiceRagFile | null>(null);
  readonly form = signal<InvoiceRagForm>(buildInvoiceRagForm(this.fb));
  readonly loading = signal(true);
  readonly busy = signal<BusyAction | null>(null);
  readonly confirmingRemove = signal(false);
  readonly stockDialogOpen = signal(false);
  readonly canEnterStock = inject(AuthService).can('stockEntry', 'write');
  readonly canApplyStock = computed(() => {
    const doc = this.document();
    return doc?.status === 'indexed' && !doc.stockAppliedAt;
  });
  readonly hasData = computed(() => {
    const doc = this.document();
    return !!(doc?.confirmed ?? doc?.extracted);
  });

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.back();
      return;
    }
    void this.load(id);
  }

  ngOnDestroy(): void {
    this.revokeFile();
  }

  addTax(): void {
    this.form().controls.taxes.push(buildTaxGroup(this.fb));
  }

  removeTax(index: number): void {
    this.form().controls.taxes.removeAt(index);
  }

  addItem(): void {
    this.form().controls.items.push(buildItemGroup(this.fb));
  }

  removeItem(index: number): void {
    this.form().controls.items.removeAt(index);
  }

  async reextract(): Promise<void> {
    const doc = this.document();
    if (!doc || this.busy()) {
      return;
    }
    this.busy.set('extract');
    try {
      this.applyDocument(await this.invoiceRag.extract(doc));
      this.notifications.success('Datos extraídos. Revísalos antes de guardar.');
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
      await this.refresh(doc.id);
    } finally {
      this.busy.set(null);
    }
  }

  async confirm(): Promise<void> {
    const doc = this.document();
    const form = this.form();
    if (!doc || this.busy()) {
      return;
    }
    if (form.invalid) {
      form.markAllAsTouched();
      return;
    }
    this.busy.set('confirm');
    try {
      const data = readInvoiceRagForm(form, (doc.confirmed ?? doc.extracted)?.confidence ?? 0);
      this.applyDocument(await this.invoiceRag.confirm(doc.id, data));
      this.notifications.success('Documento guardado e indexado.');
      if (!this.document()?.storagePath) {
        await this.backup(doc.id);
      }
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    } finally {
      this.busy.set(null);
    }
  }

  async upload(): Promise<void> {
    const doc = this.document();
    if (!doc || this.busy()) {
      return;
    }
    this.busy.set('upload');
    try {
      if (await this.backup(doc.id)) {
        this.notifications.success('Archivo subido a la nube.');
      }
    } finally {
      this.busy.set(null);
    }
  }

  async remove(): Promise<void> {
    const doc = this.document();
    if (!doc || this.busy()) {
      return;
    }
    this.busy.set('remove');
    try {
      await this.invoiceRag.remove(doc.id);
      this.notifications.success('Documento eliminado.');
      this.back();
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    } finally {
      this.busy.set(null);
      this.confirmingRemove.set(false);
    }
  }

  back(): void {
    void this.router.navigate(['/pos/facturas-rag']);
  }

  private async load(id: string): Promise<void> {
    try {
      const doc = await this.invoiceRag.getById(id);
      if (!doc) {
        this.notifications.error('Documento no encontrado.');
        this.back();
        return;
      }
      this.applyDocument(doc);
      this.file.set(await this.invoiceRag.loadFile(id));
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  private async refresh(id: string): Promise<void> {
    const doc = await this.invoiceRag.getById(id).catch(() => null);
    if (doc) {
      this.document.set(doc);
    }
  }

  /** Un fallo aquí no deshace el indexado: el archivo queda local y se reintenta a mano. */
  private async backup(id: string): Promise<boolean> {
    try {
      this.document.set(await this.invoiceRag.upload(id));
      return true;
    } catch (error) {
      this.notifications.warn(`No se pudo subir el archivo a la nube: ${getApiErrorMessage(error)}`);
      return false;
    }
  }

  private applyDocument(doc: InvoiceRagDocument): void {
    this.document.set(doc);
    const data = doc.confirmed ?? doc.extracted;
    this.form.set(data ? buildInvoiceRagForm(this.fb, data) : buildInvoiceRagForm(this.fb));
  }

  private revokeFile(): void {
    const file = this.file();
    if (file) {
      URL.revokeObjectURL(file.url);
    }
  }
}
