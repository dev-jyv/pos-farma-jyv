import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

@Component({
  selector: 'app-invoice-rag-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './invoice-rag-preview.html',
  host: { class: 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50' },
})
export class InvoiceRagPreview {
  private readonly sanitizer = inject(DomSanitizer);

  readonly url = input.required<string>();
  readonly mimeType = input.required<string>();
  readonly fileName = input('');

  readonly isPdf = computed(() => this.mimeType() === 'application/pdf');
  readonly frameUrl = computed(() =>
    this.url().startsWith('blob:') ? this.sanitizer.bypassSecurityTrustResourceUrl(this.url()) : null,
  );
}
