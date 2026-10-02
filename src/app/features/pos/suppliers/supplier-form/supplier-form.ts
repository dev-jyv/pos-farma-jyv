import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { SupplierService } from '../../services/supplier.service';

/**
 * Alineado a `phoneMx` del backend (exactamente 10 dígitos, México), no al
 * validador original del admin (7-15 dígitos "internacional"): ese regex más
 * laxo deja pasar el formulario y el backend lo rechaza igual con un 400 — el
 * cajero veía el formulario "aceptar" el teléfono y solo hasta guardar se
 * enteraba, y encima sin mensaje claro (ver fix de `ZodValidationPipe`).
 */
function optionalPhoneValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (!value) {
    return null;
  }
  const digits = value.replace(/[\s()-]/g, '');
  if (!/^\d{10}$/.test(digits)) {
    return { phone: true };
  }
  return null;
}

@Component({
  selector: 'app-supplier-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, TranslatePipe, ButtonModule, CheckboxModule, InputTextModule, ProgressSpinnerModule],
  templateUrl: './supplier-form.html',
})
export class SupplierForm {
  private readonly fb = inject(FormBuilder);
  private readonly suppliersService = inject(SupplierService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly editingId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);

  readonly form = this.fb.nonNullable.group({
    // Límites alineados a `backend-farma-jyv/functions/src/schemas/inventory.ts`.
    name: ['', [Validators.required, Validators.maxLength(120)]],
    contactName: ['', Validators.maxLength(120)],
    email: ['', Validators.email],
    phone: ['', optionalPhoneValidator],
    address: ['', Validators.maxLength(300)],
    notes: ['', Validators.maxLength(500)],
    isActive: [true],
  });

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.editingId.set(id);
      this.loading.set(true);
      this.suppliersService.getById(id).subscribe({
        next: (supplier) => {
          this.form.reset({
            name: supplier.name,
            contactName: supplier.contactName ?? '',
            email: supplier.email ?? '',
            phone: supplier.phone ?? '',
            address: supplier.address ?? '',
            notes: supplier.notes ?? '',
            isActive: supplier.isActive,
          });
          this.loading.set(false);
        },
        error: () => {
          this.notifications.error('No se pudo cargar el proveedor.');
          this.loading.set(false);
        },
      });
    }
  }

  save(): void {
    // Mismo hueco que `invoice-form.ts`/`category-form.ts`: sin esto, un doble
    // clic dispara `save()` dos veces antes de que `[disabled]` se refleje.
    if (this.saving()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    const values = this.form.getRawValue();
    const id = this.editingId();
    const request = id
      ? this.suppliersService.update(id, values)
      : this.suppliersService.create(values);

    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.notifications.success(id ? 'Proveedor actualizado.' : 'Proveedor creado.');
        this.saving.set(false);
        void this.router.navigate(['/pos/proveedores']);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.notifications.error(getApiErrorMessage(error));
      },
    });
  }

  cancel(): void {
    void this.router.navigate(['/pos/proveedores']);
  }
}
