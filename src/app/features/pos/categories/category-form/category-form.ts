import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { CategoryService } from '../../services/category.service';

@Component({
  selector: 'app-category-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, TranslatePipe, ButtonModule, CheckboxModule, InputTextModule, ProgressSpinnerModule],
  templateUrl: './category-form.html',
})
export class CategoryForm {
  private readonly fb = inject(FormBuilder);
  private readonly categoriesService = inject(CategoryService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly editingId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);

  readonly form = this.fb.nonNullable.group({
    // Límites alineados a `backend-farma-jyv/functions/src/schemas/inventory.ts`:
    // el backend ya rechazaba estos campos por longitud, pero el formulario no
    // avisaba hasta el 400 de vuelta.
    name: ['', [Validators.required, Validators.maxLength(120)]],
    description: ['', Validators.maxLength(300)],
    isActive: [true],
  });

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.editingId.set(id);
      this.loading.set(true);
      this.categoriesService.getById(id).subscribe({
        next: (category) => {
          this.form.reset({
            name: category.name,
            description: category.description ?? '',
            isActive: category.isActive ?? true,
          });
          this.loading.set(false);
        },
        error: () => {
          this.notifications.error('No se pudo cargar la categoría.');
          this.loading.set(false);
        },
      });
    }
  }

  save(): void {
    // El `[disabled]` del botón llega un tick después del clic; sin esta
    // guardia un doble clic dispara `save()` dos veces (ver bug real en
    // `invoice-form.ts`, mismo patrón, encontrado por E2E).
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
      ? this.categoriesService.update(id, values)
      : this.categoriesService.create(values);

    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.notifications.success(id ? 'Categoría actualizada.' : 'Categoría creada.');
        this.saving.set(false);
        void this.router.navigate(['/pos/categorias']);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.notifications.error(getApiErrorMessage(error));
      },
    });
  }

  cancel(): void {
    void this.router.navigate(['/pos/categorias']);
  }
}
