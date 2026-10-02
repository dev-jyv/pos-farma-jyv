import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { finalize } from 'rxjs';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { Category, ControlledGroup, Product, ProductFieldsPayload } from '../../../../shared/models';
import { CONTROLLED_GROUPS, CONTROLLED_GROUP_RULES } from '../../../../shared/utils/controlled';
import { roundMoney } from '../../../../shared/utils/money';
import { CategoryService } from '../../services/category.service';
import { ProductCatalogService } from '../../services/product-catalog.service';
import { DEFAULT_UNIT, buildUnitOptions } from '../../../../shared/utils/units';

/**
 * Alta/edición de producto — local-first: guarda directo en SQLite (sin red en
 * el instante de la acción) y sube a Firestore en el siguiente sync
 * (`ProductCatalogService.flushQueue()`, orquestado por `SyncScheduler`).
 *
 * Mismo formulario para las dos rutas (`/pos/productos/nuevo` y
 * `/pos/productos/:id/editar`): sin `id` en la ruta es alta, con `id` es
 * edición y se precarga desde el catálogo local.
 */
@Component({
  selector: 'app-product-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    TranslatePipe,
    ButtonModule,
    CheckboxModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
  ],
  templateUrl: './product-form.html',
})
export class ProductForm {
  private readonly catalogService = inject(ProductCatalogService);
  private readonly categoriesService = inject(CategoryService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly editingId = signal<string | null>(null);
  private existing: Product | null = null;
  readonly loading = signal(false);
  readonly saving = signal(false);

  readonly categoryOptions = signal<Category[]>([]);

  readonly name = signal('');
  readonly sku = signal('');
  readonly barcode = signal('');
  readonly activeIngredient = signal('');
  readonly concentration = signal('');
  readonly categoryId = signal<string | null>(null);
  readonly unit = signal<string>(DEFAULT_UNIT);
  readonly salePrice = signal<number | null>(null);
  readonly minStock = signal<number | null>(0);
  readonly controlledGroup = signal<ControlledGroup | null>(null);
  readonly hasIva = signal(false);
  readonly hasIvaZero = signal(false);
  readonly hasIeps = signal(false);
  /** Porcentaje capturado en pantalla; al backend viaja como fracción. */
  readonly iepsPercent = signal<number | null>(null);
  readonly requiresPrescription = signal(false);
  readonly isActive = signal(true);

  /** Lista cerrada; conserva la unidad ya guardada si viniera de fuera del catálogo. */
  readonly unitOptions = computed(() => buildUnitOptions(this.unit()));
  readonly controlledOptions = [
    { label: 'Sin grupo (venta libre)', value: null },
    ...CONTROLLED_GROUPS.map((group) => ({
      label: CONTROLLED_GROUP_RULES[group].label,
      value: group as ControlledGroup | null,
    })),
  ];

  readonly isEditing = computed(() => this.editingId() !== null);

  readonly blockers = computed<string[]>(() => {
    const reasons: string[] = [];
    if (!this.name().trim()) {
      reasons.push('El nombre del producto es requerido.');
    }
    if (!this.sku().trim()) {
      reasons.push('El SKU es requerido.');
    }
    if (!this.categoryId()) {
      reasons.push('Elige la categoría del producto.');
    }
    if (!this.unit().trim()) {
      reasons.push('Captura la unidad (pieza, caja…).');
    }
    if ((this.salePrice() ?? 0) <= 0) {
      reasons.push('Captura el precio de venta.');
    }
    if (this.hasIva() && this.hasIvaZero()) {
      reasons.push('Un producto no puede tener IVA e IVA cero a la vez.');
    }
    if (this.hasIeps() && !(this.iepsPercent() ?? 0)) {
      reasons.push('Captura la tasa de IEPS.');
    }
    if (this.barcode().trim() && !/^\d{8,14}$/.test(this.barcode().trim())) {
      reasons.push('El código de barras debe tener entre 8 y 14 dígitos.');
    }
    return reasons;
  });

  readonly canSubmit = computed(() => !this.saving() && !this.loading() && this.blockers().length === 0);

  constructor() {
    this.loadCategories();
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.editingId.set(id);
      this.loading.set(true);
      this.catalogService.getById(id).subscribe({
        next: (product) => {
          this.loading.set(false);
          if (!product) {
            this.notifications.error('No se encontró el producto en el catálogo local.');
            void this.router.navigate(['/pos/productos']);
            return;
          }
          this.fillForm(product);
        },
        error: (error: unknown) => {
          this.loading.set(false);
          this.notifications.error(getApiErrorMessage(error));
        },
      });
    }
  }

  loadCategories(): void {
    this.categoriesService.options().subscribe((categories) => this.categoryOptions.set(categories));
  }

  private fillForm(product: Product): void {
    this.existing = product;
    this.name.set(product.name);
    this.sku.set(product.sku);
    this.barcode.set(product.barcode ?? '');
    this.activeIngredient.set(product.activeIngredient ?? '');
    this.concentration.set(product.concentration ?? '');
    this.categoryId.set(product.categoryId ?? null);
    this.unit.set(product.unit ?? DEFAULT_UNIT);
    this.salePrice.set(product.salePrice);
    this.minStock.set(product.minStock ?? 0);
    this.controlledGroup.set(product.controlledGroup ?? null);
    this.hasIva.set(product.hasIva === true);
    this.hasIvaZero.set(product.hasIvaZero === true);
    this.hasIeps.set(product.hasIeps === true);
    this.iepsPercent.set(product.iepsRate ? roundMoney(product.iepsRate * 100) : null);
    this.requiresPrescription.set(product.requiresPrescription === true);
    this.isActive.set(product.isActive !== false);
  }

  save(): void {
    // Mismo patrón que factura/categoría/proveedor: el `[disabled]` del botón
    // llega un tick después del clic, así que un doble clic real puede llamar
    // `save()` dos veces antes de que se refleje.
    if (this.saving() || !this.canSubmit()) {
      return;
    }
    this.saving.set(true);

    const id = this.editingId();
    const request = id
      ? this.catalogService.update(id, this.changesOrFull())
      : this.catalogService.create(this.productFields());

    request.pipe(finalize(() => this.saving.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        // Con la llave y no con el texto: en inglés esto se veía en español.
        // `instant()` alcanza porque el aviso se arma en el momento de mostrarlo.
        this.notifications.success(this.translate.instant(id ? 'products.updated' : 'products.created'));
        void this.router.navigate(['/pos/productos']);
      },
      error: (error: unknown) => this.notifications.error(getApiErrorMessage(error)),
    });
  }

  cancel(): void {
    void this.router.navigate(['/pos/productos']);
  }

  private productFields(): ProductFieldsPayload {
    return {
      name: this.name().trim(),
      sku: this.sku().trim(),
      categoryId: this.categoryId()!,
      unit: this.unit().trim(),
      salePrice: roundMoney(this.salePrice() ?? 0),
      minStock: Math.max(0, Math.floor(this.minStock() ?? 0)),
      hasIva: this.hasIva(),
      hasIvaZero: this.hasIvaZero(),
      hasIeps: this.hasIeps(),
      requiresPrescription: this.requiresPrescription(),
      isActive: this.isActive(),
      ...(this.barcode().trim() ? { barcode: this.barcode().trim() } : {}),
      ...(this.activeIngredient().trim()
        ? { activeIngredient: this.activeIngredient().trim() }
        : {}),
      ...(this.concentration().trim() ? { concentration: this.concentration().trim() } : {}),
      // El backend espera fracción: 8 % viaja como 0.08.
      ...(this.hasIeps() && this.iepsPercent()
        ? { iepsRate: Math.round(this.iepsPercent()! * 100) / 10_000 }
        : {}),
      ...(this.controlledGroup() ? { controlledGroup: this.controlledGroup()! } : {}),
    };
  }

  /**
   * En edición, solo lo que de verdad cambió respecto al catálogo local — igual
   * criterio que `stock-entry.ts`: un `PATCH` completo dejaría un renglón de
   * auditoría por campo que nadie tocó. Si no hay `existing` (no debería pasar
   * en modo edición), se manda todo como respaldo.
   */
  private changesOrFull(): Partial<ProductFieldsPayload> {
    const fields = this.productFields();
    const existing = this.existing;
    if (!existing) {
      return fields;
    }
    const changes: Partial<ProductFieldsPayload> = {};
    if (fields.name !== existing.name) changes.name = fields.name;
    if (fields.sku !== existing.sku) changes.sku = fields.sku;
    if (fields.salePrice !== existing.salePrice) changes.salePrice = fields.salePrice;
    if (fields.categoryId !== (existing.categoryId ?? null)) changes.categoryId = fields.categoryId;
    if (fields.unit !== (existing.unit ?? DEFAULT_UNIT)) changes.unit = fields.unit;
    if (fields.minStock !== (existing.minStock ?? 0)) changes.minStock = fields.minStock;
    if (fields.barcode !== existing.barcode && (fields.barcode || existing.barcode)) {
      changes.barcode = fields.barcode ?? '';
    }
    if (
      fields.activeIngredient !== existing.activeIngredient &&
      (fields.activeIngredient || existing.activeIngredient)
    ) {
      changes.activeIngredient = fields.activeIngredient ?? '';
    }
    if (
      fields.concentration !== existing.concentration &&
      (fields.concentration || existing.concentration)
    ) {
      changes.concentration = fields.concentration ?? '';
    }
    if (fields.hasIva !== (existing.hasIva === true)) changes.hasIva = fields.hasIva;
    if (fields.hasIvaZero !== (existing.hasIvaZero === true)) changes.hasIvaZero = fields.hasIvaZero;
    if (fields.hasIeps !== (existing.hasIeps === true)) {
      changes.hasIeps = fields.hasIeps;
      if (fields.hasIeps) {
        changes.iepsRate = fields.iepsRate;
      }
    } else if (fields.hasIeps && fields.iepsRate !== existing.iepsRate) {
      changes.hasIeps = true;
      changes.iepsRate = fields.iepsRate;
    }
    if ((fields.controlledGroup ?? null) !== (existing.controlledGroup ?? null)) {
      changes.controlledGroup = fields.controlledGroup;
    }
    if (fields.requiresPrescription !== (existing.requiresPrescription === true)) {
      changes.requiresPrescription = fields.requiresPrescription;
    }
    if (fields.isActive !== (existing.isActive !== false)) {
      changes.isActive = fields.isActive;
    }
    return changes;
  }
}
