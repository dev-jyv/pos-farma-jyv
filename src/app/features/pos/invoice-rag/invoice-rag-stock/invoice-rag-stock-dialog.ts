import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { FormArray, FormsModule, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { Subscription, catchError, firstValueFrom, of } from 'rxjs';

import { getApiErrorMessage } from '../../../../core/api/api.utils';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { InvoiceRagDocument, Product, PurchaseInvoice, Supplier } from '../../../../shared/models';
import { InvoiceService } from '../../services/invoice.service';
import { ProductService } from '../../services/product.service';
import { StockEntryService } from '../../services/stock-entry.service';
import { SupplierService } from '../../services/supplier.service';
import { InvoiceRagService } from '../services/invoice-rag.service';
import {
  StockRowError,
  StockRowGroup,
  StockRowValue,
  buildStockRow,
  savesBarcode,
  stockRowErrors,
  toStockEntry,
} from './invoice-rag-stock-form';

const normalize = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

/**
 * Vista previa editable de lo que el documento suma al inventario. Cada concepto
 * se liga a un producto del catálogo por su código de barras (o a mano) y entra
 * como una entrada de stock contra una factura de compra registrada.
 */
@Component({
  selector: 'app-invoice-rag-stock-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    FormsModule,
    ReactiveFormsModule,
    TranslatePipe,
    AutoCompleteModule,
    ButtonModule,
    CheckboxModule,
    DialogModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
  ],
  templateUrl: './invoice-rag-stock-dialog.html',
})
export class InvoiceRagStockDialog {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly invoiceRag = inject(InvoiceRagService);
  private readonly products = inject(ProductService);
  private readonly stockEntries = inject(StockEntryService);
  private readonly invoiceService = inject(InvoiceService);
  private readonly supplierService = inject(SupplierService);
  private readonly notifications = inject(NotificationService);
  private rowsSubscription?: Subscription;

  readonly document = input.required<InvoiceRagDocument>();
  readonly visible = model(false);
  readonly applied = output<InvoiceRagDocument>();

  readonly today = new Date().toISOString().slice(0, 10);
  readonly loading = signal(false);
  readonly applying = signal(false);
  readonly rows = signal(new FormArray<StockRowGroup>([]));
  readonly rowValues = signal<StockRowValue[]>([]);
  readonly suggestions = signal<Product[]>([]);
  readonly savesBarcode = savesBarcode;

  readonly invoices = signal<PurchaseInvoice[]>([]);
  readonly invoicesError = signal<string | null>(null);
  readonly invoiceId = signal<string | null>(null);

  readonly registering = signal(false);
  readonly suppliers = signal<Supplier[]>([]);
  readonly supplierId = signal<string | null>(null);
  readonly creatingInvoice = signal(false);

  readonly data = computed(() => this.document().confirmed);
  readonly folio = computed(() => this.data()?.folio ?? null);
  readonly invoiceOptions = computed(() =>
    this.invoices().map((invoice) => ({
      value: invoice.id,
      label: `${invoice.invoiceNumber} · ${invoice.supplierName || '—'} · $${invoice.totalAmount.toFixed(2)}`,
    })),
  );
  readonly folioMatches = computed(() => {
    const selected = this.invoices().find((invoice) => invoice.id === this.invoiceId());
    return !!selected && !!this.folio() && normalize(selected.invoiceNumber) === normalize(this.folio());
  });
  readonly missingInvoiceData = computed(() => {
    const data = this.data();
    return !data?.folio || !data.issueDate || data.total === null;
  });

  readonly rowErrors = computed(() => this.rowValues().map((row) => stockRowErrors(row, this.today)));
  readonly included = computed(() => this.rowValues().filter((row) => row.include));
  readonly totalPieces = computed(() => this.included().reduce((sum, row) => sum + (row.quantity ?? 0), 0));
  readonly blockers = computed(() => {
    const reasons: string[] = [];
    if (!this.invoiceId()) reasons.push('invoiceRag.stock.blockerInvoice');
    if (this.included().length === 0) reasons.push('invoiceRag.stock.blockerNoRows');
    if (this.rowErrors().some((errors) => errors.length > 0)) reasons.push('invoiceRag.stock.blockerIncomplete');
    return reasons;
  });
  readonly canApply = computed(() => !this.applying() && !this.loading() && this.blockers().length === 0);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.rowsSubscription?.unsubscribe());
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.registering.set(false);
    try {
      const items = this.data()?.items ?? [];
      const matches = await Promise.all(items.map((item) => this.findByBarcode(item.barcode)));
      this.setRows(new FormArray(items.map((item, i) => buildStockRow(this.fb, item, matches[i], this.today))));
      await this.loadInvoices();
    } finally {
      this.loading.set(false);
    }
  }

  searchProducts(event: AutoCompleteCompleteEvent): void {
    this.products.search(event.query).subscribe((products) => this.suggestions.set(products));
  }

  hasError(index: number, field: StockRowError): boolean {
    return this.rowErrors()[index]?.includes(field) ?? false;
  }

  async startRegister(): Promise<void> {
    this.registering.set(true);
    if (this.suppliers().length > 0) {
      return;
    }
    try {
      const suppliers = await firstValueFrom(this.supplierService.listActive());
      this.suppliers.set(suppliers);
      const issuer = normalize(this.data()?.issuer.name);
      const match = issuer
        ? suppliers.find((s) => normalize(s.name).includes(issuer) || issuer.includes(normalize(s.name)))
        : undefined;
      this.supplierId.set(match?.id ?? null);
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    }
  }

  async registerInvoice(): Promise<void> {
    const data = this.data();
    const supplierId = this.supplierId();
    if (!data?.folio || !data.issueDate || data.total === null || !supplierId || this.creatingInvoice()) {
      return;
    }
    this.creatingInvoice.set(true);
    try {
      const invoice = await firstValueFrom(
        this.invoiceService.create({
          supplierId,
          invoiceNumber: data.folio,
          invoiceDate: data.issueDate,
          totalAmount: data.total,
          hasInvoice: data.documentType === 'invoice',
        }),
      );
      const supplierName = this.suppliers().find((s) => s.id === supplierId)?.name ?? '';
      this.invoices.update((list) => [{ ...invoice, supplierName: invoice.supplierName || supplierName }, ...list]);
      this.invoiceId.set(invoice.id);
      this.registering.set(false);
      this.notifications.success(`Factura ${invoice.invoiceNumber} registrada.`);
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    } finally {
      this.creatingInvoice.set(false);
    }
  }

  async apply(): Promise<void> {
    const invoiceId = this.invoiceId();
    if (!invoiceId || !this.canApply()) {
      return;
    }
    this.applying.set(true);
    try {
      const entries = this.included().map((row) => toStockEntry(row, invoiceId));
      const document = await this.invoiceRag.applyStock(this.document().id, entries);
      this.notifications.success(
        `Inventario actualizado: ${entries.length} productos, +${this.totalPieces()} piezas.`,
      );
      this.applied.emit(document);
      this.visible.set(false);
    } catch (error) {
      this.notifications.error(getApiErrorMessage(error));
    } finally {
      this.applying.set(false);
    }
  }

  private findByBarcode(barcode: string | null | undefined): Promise<Product | null> {
    return barcode
      ? firstValueFrom(this.products.getByBarcode(barcode).pipe(catchError(() => of(null))))
      : Promise.resolve(null);
  }

  private setRows(rows: FormArray<StockRowGroup>): void {
    this.rowsSubscription?.unsubscribe();
    this.rows.set(rows);
    this.rowValues.set(rows.getRawValue());
    this.rowsSubscription = rows.valueChanges.subscribe(() => this.rowValues.set(rows.getRawValue()));
  }

  private async loadInvoices(): Promise<void> {
    this.invoicesError.set(null);
    try {
      const invoices = await firstValueFrom(this.stockEntries.listRecentInvoices(30));
      this.invoices.set(invoices);
      const folio = normalize(this.folio());
      this.invoiceId.set(invoices.find((invoice) => folio && normalize(invoice.invoiceNumber) === folio)?.id ?? null);
    } catch (error) {
      this.invoicesError.set(getApiErrorMessage(error));
    }
  }
}
