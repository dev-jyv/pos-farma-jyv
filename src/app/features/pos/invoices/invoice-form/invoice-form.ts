import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { Observable, map, of, switchMap, tap } from 'rxjs';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { Supplier } from '../../../../shared/models';
import { todayLocalDateString } from '../../../../shared/utils/local-date';
import { InvoiceService } from '../../services/invoice.service';
import { SupplierService } from '../../services/supplier.service';
import { UploadsService, validateUploadFile } from '../../services/uploads.service';

/** `Validators.required` acepta "   "; el número se envía con `trim()`, o sea vacío. */
function notBlank(control: AbstractControl<string>): ValidationErrors | null {
  return control.value?.trim() ? null : { required: true };
}

@Component({
  selector: 'app-invoice-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, TranslatePipe, ButtonModule, InputNumberModule, InputTextModule, SelectModule],
  templateUrl: './invoice-form.html',
})
export class InvoiceForm implements OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly invoicesService = inject(InvoiceService);
  private readonly suppliersService = inject(SupplierService);
  private readonly uploadsService = inject(UploadsService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly suppliers = signal<Supplier[]>([]);
  readonly saving = signal(false);
  readonly selectedFile = signal<File | null>(null);
  readonly filePreviewUrl = signal<string | null>(null);
  readonly fileError = signal('');
  readonly dragging = signal(false);

  readonly form = this.fb.nonNullable.group({
    supplierId: ['', Validators.required],
    // Límite alineado a `backend-farma-jyv/functions/src/schemas/inventory.ts`.
    invoiceNumber: ['', [Validators.required, notBlank, Validators.maxLength(60)]],
    invoiceDate: [todayLocalDateString(), Validators.required],
    totalAmount: [0, [Validators.required, Validators.min(0.01)]],
    hasInvoice: [true],
  });

  constructor() {
    this.suppliersService.listActive().subscribe((suppliers) => this.suppliers.set(suppliers));
  }

  ngOnDestroy(): void {
    this.revokePreview();
  }

  selectType(hasInvoice: boolean): void {
    this.form.controls.hasInvoice.setValue(hasInvoice);
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

  private setFile(file: File): void {
    const error = validateUploadFile(file);
    if (error) {
      this.fileError.set(error);
      return;
    }
    this.fileError.set('');
    this.revokePreview();
    this.selectedFile.set(file);
    if (file.type.startsWith('image/')) {
      this.filePreviewUrl.set(URL.createObjectURL(file));
    }
  }

  private revokePreview(): void {
    const url = this.filePreviewUrl();
    if (url) {
      URL.revokeObjectURL(url);
    }
    this.filePreviewUrl.set(null);
  }

  /** Último comprobante subido con éxito, para no repetirlo si el alta de la factura falla. */
  private uploaded: { file: File; storagePath: string } | null = null;

  save(): void {
    // Mismo caso que `Login.onSubmit()`: el `[disabled]` del botón llega un
    // tick después del clic, así que un doble clic real puede llamar a
    // `save()` dos veces antes de que se refleje — sin esto, disparaba 2 POST
    // (el backend lo resolvía con 409, pero la UI no debe depender de eso).
    if (this.saving()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    /**
     * El comprobante es opcional, pero un comprobante **rechazado** no es lo
     * mismo que no adjuntar ninguno: `setFile` deja el error y no guarda el
     * archivo, así que guardar aquí registraría la factura sin adjunto justo
     * cuando el usuario creía haber subido uno.
     */
    if (this.fileError()) {
      return;
    }
    this.saving.set(true);
    const values = this.form.getRawValue();
    const file = this.selectedFile();

    /**
     * El comprobante es opcional: la factura se registra aunque el archivo
     * llegue después. Sin archivo no se llama a `uploads` — una subida vacía
     * sería un viaje de red y un objeto huérfano en el Storage.
     */
    // Si la factura falla tras subir el archivo, el reintento reusa lo ya subido
    // en vez de dejar un objeto huérfano y subirlo otra vez.
    const subido = this.uploaded;
    const fileUrl$: Observable<string | undefined> = !file
      ? of(undefined)
      : subido && subido.file === file
        ? of(subido.storagePath)
        : this.uploadsService.uploadInvoice(file).pipe(
            map((upload) => upload.storagePath),
            tap((storagePath) => (this.uploaded = { file, storagePath })),
          );

    fileUrl$
      .pipe(
        switchMap((fileUrl) =>
          this.invoicesService.create({
            supplierId: values.supplierId,
            invoiceNumber: values.invoiceNumber.trim(),
            invoiceDate: values.invoiceDate,
            totalAmount: values.totalAmount,
            hasInvoice: values.hasInvoice,
            fileUrl,
          }),
        ),
        // Sin esto, cancelar/navegar fuera mientras el POST sigue en vuelo y
        // abrir una segunda factura deja que la respuesta tardía de la primera
        // dispare su `next`/navigate sobre la instancia ya destruida —
        // expulsando al cajero de la segunda factura a medio llenar.
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.notifications.success('Factura registrada.');
          this.saving.set(false);
          void this.router.navigate(['/pos/facturas']);
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.notifications.error(getApiErrorMessage(error));
        },
      });
  }

  cancel(): void {
    void this.router.navigate(['/pos/facturas']);
  }
}
