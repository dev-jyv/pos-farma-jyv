import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { Subject, debounceTime, distinctUntilChanged, finalize, switchMap } from 'rxjs';

import { getApiErrorMessage } from '../../../core/api/api.utils';
import { NotificationService } from '../../../core/notifications/notification.service';
import { Category, ControlledGroup, Product, PurchaseInvoice } from '../../../shared/models';
import { CONTROLLED_GROUPS, CONTROLLED_GROUP_RULES } from '../../../shared/utils/controlled';
import { roundMoney } from '../../../shared/utils/money';
import { CategoryService } from '../services/category.service';
import { ProductService } from '../services/product.service';
import {
  CreateStockEntryPayload,
  ProductFieldsPayload,
  StockEntryService,
} from '../services/stock-entry.service';

/** Igual que en la venta: con una letra el servidor recorre el catálogo entero. */
const MIN_SEARCH_LENGTH = 2;

/** Modo del formulario de producto. */
type ProductMode = 'none' | 'existing' | 'new';

/**
 * Entrada de stock desde la caja.
 *
 * Recibe mercancía contra una factura **ya registrada**: se elige la factura, se
 * busca el producto (o se da de alta si no existe), y se captura lote, caducidad
 * y piezas. Las piezas se **suman** al stock actual; el lote y la caducidad no
 * son opcionales porque de ellos dependen FEFO, el aviso de caducidad y el libro
 * de control.
 *
 * Subir facturas, hacer conteos o registrar salidas siguen siendo del panel de
 * administración: esta pantalla pide `stockEntry`, no `inventory:write`.
 */
@Component({
  selector: 'app-stock-entry',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    FormsModule,
    TranslatePipe,
    ButtonModule,
    CheckboxModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
  ],
  templateUrl: './stock-entry.html',
  host: {
    // F9 guarda, igual que F9 cobra en la venta.
    '(document:keydown.f9)': 'submitFromHotkey($event)',
  },
})
export class StockEntryScreen {
  private readonly stockEntries = inject(StockEntryService);
  private readonly products = inject(ProductService);
  private readonly categories = inject(CategoryService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly search$ = new Subject<string>();

  readonly invoices = signal<PurchaseInvoice[]>([]);
  readonly invoicesLoading = signal(false);
  readonly invoicesError = signal<string | null>(null);
  readonly selectedInvoiceId = signal<string | null>(null);

  readonly categoryOptions = signal<Category[]>([]);
  readonly categoriesError = signal<string | null>(null);

  readonly searchTerm = signal('');
  readonly results = signal<Product[]>([]);
  readonly searching = signal(false);
  /** `true` cuando la última búsqueda terminó sin resultados. */
  readonly searched = signal(false);

  readonly mode = signal<ProductMode>('none');
  /** Producto del catálogo elegido; `null` cuando se está dando de alta uno nuevo. */
  readonly selectedProduct = signal<Product | null>(null);

  // Campos del producto. Uno por campo, como el resto del POS.
  readonly name = signal('');
  readonly sku = signal('');
  readonly barcode = signal('');
  readonly activeIngredient = signal('');
  readonly concentration = signal('');
  readonly categoryId = signal<string | null>(null);
  readonly unit = signal('pieza');
  readonly salePrice = signal<number | null>(null);
  readonly minStock = signal<number | null>(0);
  readonly controlledGroup = signal<ControlledGroup | null>(null);
  readonly hasIva = signal(false);
  readonly hasIvaZero = signal(false);
  readonly hasIeps = signal(false);
  /** Porcentaje capturado por el cajero; al backend viaja como fracción. */
  readonly iepsPercent = signal<number | null>(null);

  // Datos de la partida que entra.
  readonly lotNumber = signal('');
  readonly expiryDate = signal('');
  readonly quantity = signal<number | null>(null);
  readonly costPrice = signal<number | null>(null);

  readonly submitting = signal(false);
  /** Resultado del último guardado, para confirmar en pantalla lo que quedó. */
  readonly lastResult = signal<{ name: string; added: number; stock: number } | null>(null);

  readonly unitOptions = ['pieza', 'caja', 'frasco', 'ampolleta', 'sobre', 'tubo', 'kit'];
  readonly controlledOptions = [
    { label: 'Sin grupo (venta libre)', value: null },
    ...CONTROLLED_GROUPS.map((group) => ({
      label: CONTROLLED_GROUP_RULES[group].label,
      value: group as ControlledGroup | null,
    })),
  ];

  readonly invoiceOptions = computed(() =>
    this.invoices().map((invoice) => ({
      value: invoice.id,
      label: `${invoice.invoiceNumber} · ${invoice.supplierName || 'Sin proveedor'} · $${invoice.totalAmount.toFixed(2)}`,
    })),
  );
  readonly selectedInvoice = computed(
    () => this.invoices().find((invoice) => invoice.id === this.selectedInvoiceId()) ?? null,
  );

  readonly editingProduct = computed(() => this.mode() !== 'none');
  readonly isNewProduct = computed(() => this.mode() === 'new');

  /** Stock que tiene hoy el producto elegido; 0 para uno nuevo. */
  readonly currentStock = computed(() => this.selectedProduct()?.stock ?? 0);
  readonly resultingStock = computed(() => this.currentStock() + Math.max(0, this.quantity() ?? 0));

  /** Hoy en la zona del equipo; el backend rechaza caducidades pasadas. */
  private readonly today = new Date().toISOString().slice(0, 10);
  readonly minExpiryDate = this.today;

  /**
   * Por qué no se puede guardar todavía, en el orden en que el cajero lo
   * resuelve. Misma regla que el cobro: nunca un botón apagado sin motivo.
   */
  readonly blockers = computed<string[]>(() => {
    const reasons: string[] = [];
    if (!this.selectedInvoiceId()) {
      reasons.push('Elige la factura de la mercancía.');
    }
    if (this.mode() === 'none') {
      reasons.push('Busca el producto o da de alta uno nuevo.');
    } else {
      reasons.push(...this.productBlockers());
    }
    if (!this.lotNumber().trim()) {
      reasons.push('Captura el número de lote.');
    }
    if (!this.expiryDate()) {
      reasons.push('Captura la fecha de caducidad.');
    } else if (this.expiryDate() < this.today) {
      reasons.push('La caducidad no puede estar en el pasado.');
    }
    if ((this.quantity() ?? 0) < 1) {
      reasons.push('Captura cuántas piezas entran.');
    }
    return reasons;
  });

  readonly canSubmit = computed(() => !this.submitting() && this.blockers().length === 0);

  constructor() {
    this.loadInvoices();
    this.loadCategories();

    this.search$
      .pipe(
        debounceTime(400),
        distinctUntilChanged(),
        switchMap((term) => this.products.search(term)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((products) => {
        this.results.set(products);
        this.searching.set(false);
        this.searched.set(true);
      });
  }

  loadInvoices(): void {
    this.invoicesLoading.set(true);
    this.invoicesError.set(null);
    this.stockEntries
      .listRecentInvoices()
      .pipe(finalize(() => this.invoicesLoading.set(false)))
      .subscribe({
        next: (invoices) => {
          this.invoices.set(invoices);
          if (invoices.length === 0) {
            this.invoicesError.set(
              'No hay facturas registradas. Se dan de alta desde el panel de administración antes de recibir la mercancía.',
            );
          }
        },
        // Banda persistente: un selector vacío parecería "no hay facturas".
        error: (error: unknown) => this.invoicesError.set(getApiErrorMessage(error)),
      });
  }

  loadCategories(): void {
    this.categoriesError.set(null);
    this.categories.list().subscribe({
      next: (categories) => this.categoryOptions.set(categories),
      error: (error: unknown) => this.categoriesError.set(getApiErrorMessage(error)),
    });
  }

  onSearchChange(term: string): void {
    this.searchTerm.set(term);
    this.searched.set(false);
    if (term.trim().length < MIN_SEARCH_LENGTH) {
      this.results.set([]);
      this.searching.set(false);
      return;
    }
    this.searching.set(true);
    this.search$.next(term);
  }

  /** Llena el formulario con el producto del catálogo. */
  selectProduct(product: Product): void {
    this.selectedProduct.set(product);
    this.mode.set('existing');
    this.results.set([]);
    this.searchTerm.set(product.name);

    this.name.set(product.name);
    this.sku.set(product.sku);
    this.barcode.set(product.barcode ?? '');
    this.activeIngredient.set(product.activeIngredient ?? '');
    this.concentration.set(product.concentration ?? '');
    this.categoryId.set(product.categoryId ?? null);
    this.unit.set(product.unit ?? 'pieza');
    this.salePrice.set(product.salePrice);
    this.minStock.set(product.minStock ?? 0);
    this.controlledGroup.set(product.controlledGroup ?? null);
    this.hasIva.set(product.hasIva === true);
    this.hasIvaZero.set(product.hasIvaZero === true);
    this.hasIeps.set(product.hasIeps === true);
    this.iepsPercent.set(product.iepsRate ? roundMoney(product.iepsRate * 100) : null);
  }

  /** Abre el formulario vacío para dar de alta el producto buscado. */
  startNewProduct(): void {
    this.resetProductFields();
    this.selectedProduct.set(null);
    this.mode.set('new');
    this.results.set([]);
    // Lo tecleado suele ser el nombre; si parece código, va al SKU.
    const term = this.searchTerm().trim();
    if (/^[0-9A-Z_-]+$/.test(term)) {
      this.sku.set(term);
    } else {
      this.name.set(term);
    }
  }

  /** Vuelve al buscador sin perder la factura elegida. */
  clearProduct(): void {
    this.mode.set('none');
    this.selectedProduct.set(null);
    this.resetProductFields();
    this.searchTerm.set('');
    this.results.set([]);
    this.searched.set(false);
  }

  submitFromHotkey(event: Event): void {
    event.preventDefault();
    if (this.canSubmit()) {
      this.submit();
      return;
    }
    const [firstBlocker] = this.blockers();
    if (firstBlocker) {
      this.notifications.error(firstBlocker);
    }
  }

  submit(): void {
    if (!this.canSubmit()) {
      return;
    }

    const payload: CreateStockEntryPayload = {
      invoiceId: this.selectedInvoiceId()!,
      lotNumber: this.lotNumber().trim(),
      expiryDate: this.expiryDate(),
      quantity: Math.floor(this.quantity()!),
      ...(this.costPrice() ? { costPrice: roundMoney(this.costPrice()!) } : {}),
    };

    const existing = this.selectedProduct();
    if (existing) {
      payload.productId = existing.id;
      const changes = this.productChanges(existing);
      if (Object.keys(changes).length > 0) {
        payload.productUpdate = changes;
      }
    } else {
      payload.product = this.productFields();
    }

    const added = payload.quantity;
    this.submitting.set(true);
    this.stockEntries
      .create(payload)
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: (result) => {
          this.lastResult.set({ name: result.product.name, added, stock: result.stock });
          // El stock que acaba de entrar debe verse en la próxima venta.
          this.products.invalidate();
          this.notifications.success(
            `${result.product.name}: +${added} piezas. Stock: ${result.stock}.`,
          );
          this.resetAfterSave();
        },
        error: (error: unknown) => this.notifications.error(getApiErrorMessage(error)),
      });
  }

  /** Campos del producto tal como los espera el backend. */
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
   * Solo lo que el cajero cambió respecto al catálogo. Mandar el producto
   * completo dejaría una actualización (y un renglón de auditoría) en cada
   * entrada, aunque nadie hubiera tocado nada.
   */
  private productChanges(existing: Product): Partial<ProductFieldsPayload> {
    const fields = this.productFields();
    const changes: Partial<ProductFieldsPayload> = {};

    if (fields.name !== existing.name) changes.name = fields.name;
    if (fields.sku !== existing.sku) changes.sku = fields.sku;
    if (fields.salePrice !== existing.salePrice) changes.salePrice = fields.salePrice;
    if (fields.categoryId !== (existing.categoryId ?? null)) changes.categoryId = fields.categoryId;
    if (fields.unit !== (existing.unit ?? 'pieza')) changes.unit = fields.unit;
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
      // El backend exige la tasa junto con la bandera.
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

    return changes;
  }

  /** Motivos que impiden guardar por los campos del producto. */
  private productBlockers(): string[] {
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
  }

  /**
   * Deja lista la siguiente partida **conservando la factura**: una factura trae
   * varios productos y se capturan uno tras otro.
   */
  private resetAfterSave(): void {
    this.clearProduct();
    this.lotNumber.set('');
    this.expiryDate.set('');
    this.quantity.set(null);
    this.costPrice.set(null);
  }

  private resetProductFields(): void {
    this.name.set('');
    this.sku.set('');
    this.barcode.set('');
    this.activeIngredient.set('');
    this.concentration.set('');
    this.categoryId.set(null);
    this.unit.set('pieza');
    this.salePrice.set(null);
    this.minStock.set(0);
    this.controlledGroup.set(null);
    this.hasIva.set(false);
    this.hasIvaZero.set(false);
    this.hasIeps.set(false);
    this.iepsPercent.set(null);
  }
}
