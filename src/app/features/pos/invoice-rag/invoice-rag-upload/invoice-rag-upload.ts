import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { validateUploadFile } from '../../services/uploads.service';
import { InvoiceRagPreview } from '../invoice-rag-preview/invoice-rag-preview';
import { InvoiceRagService } from '../services/invoice-rag.service';

type UploadStep = 'idle' | 'saving' | 'extracting';

@Component({
  selector: 'app-invoice-rag-upload',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, ButtonModule, InvoiceRagPreview],
  templateUrl: './invoice-rag-upload.html',
})
export class InvoiceRagUpload implements OnDestroy {
  private readonly invoiceRag = inject(InvoiceRagService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  readonly available = this.invoiceRag.available;
  readonly selectedFile = signal<File | null>(null);
  readonly previewUrl = signal<string | null>(null);
  readonly fileError = signal('');
  readonly dragging = signal(false);
  readonly step = signal<UploadStep>('idle');

  ngOnDestroy(): void {
    this.revokePreview();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.setFile(file);
    }
    input.value = '';
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      this.setFile(file);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragging.set(false);
  }

  clearFile(): void {
    this.revokePreview();
    this.selectedFile.set(null);
    this.fileError.set('');
  }

  async analyze(): Promise<void> {
    const file = this.selectedFile();
    if (!file || this.step() !== 'idle') {
      return;
    }
    this.step.set('saving');
    try {
      const { document, duplicate } = await this.invoiceRag.register(file);
      if (duplicate) {
        this.notifications.warn('Este archivo ya estaba cargado; se abre el existente.');
      }
      if (!duplicate || document.status === 'uploaded' || document.status === 'failed') {
        this.step.set('extracting');
        await this.invoiceRag.extract(document, file).catch((error: unknown) => {
          this.notifications.error(getApiErrorMessage(error));
        });
      }
      await this.router.navigate(['/pos/facturas-rag', document.id]);
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    } finally {
      this.step.set('idle');
    }
  }

  cancel(): void {
    void this.router.navigate(['/pos/facturas-rag']);
  }

  private setFile(file: File): void {
    const error = validateUploadFile(file);
    if (error) {
      this.fileError.set(error);
      return;
    }
    this.fileError.set('');
    this.revokePreview();
    this.selectedFile.set(file);
    this.previewUrl.set(URL.createObjectURL(file));
  }

  private revokePreview(): void {
    const url = this.previewUrl();
    if (url) {
      URL.revokeObjectURL(url);
    }
    this.previewUrl.set(null);
  }
}
