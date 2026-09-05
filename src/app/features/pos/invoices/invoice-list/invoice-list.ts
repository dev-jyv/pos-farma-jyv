import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { NotificationService } from '../../../../core/notifications/notification.service';
import { PurchaseInvoice, Supplier } from '../../../../shared/models';
import { InvoiceService } from '../../services/invoice.service';
import { SupplierService } from '../../services/supplier.service';

@Component({
  selector: 'app-invoice-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    TranslatePipe,
    ButtonModule,
    InputTextModule,
    SelectModule,
    TableModule,
    TagModule,
    TooltipModule,
  ],
  templateUrl: './invoice-list.html',
})
export class InvoiceList {
  private readonly invoicesService = inject(InvoiceService);
  private readonly suppliersService = inject(SupplierService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  readonly invoices = signal<PurchaseInvoice[]>([]);
  readonly suppliers = signal<Supplier[]>([]);
  readonly loading = signal(false);
  readonly search = signal('');
  readonly supplierId = signal<string | null>(null);
  readonly totalRecords = signal(0);
  /**
   * 50 por página: el mostrador consulta las facturas recientes, y con 10 el
   * paginador aparecía casi de inmediato para algo que se lee de un vistazo.
   * El backend acota a 100, así que ese es el tope de las opciones.
   */
  readonly rows = 50;
  readonly rowsPerPageOptions = [50, 100];
  /** Tamaño de página vigente: cambia si el usuario elige otro en el paginador. */
  private pageSize = this.rows;

  private readonly search$ = new Subject<string>();
  private page = 1;

  constructor() {
    // `search$` es un Subject: nunca completa, así que sin `takeUntilDestroyed`
    // la suscripción sobrevivía al componente. Cada visita a la pantalla dejaba
    // una viva, y al teclear todas disparaban su propio `fetch()` contra la API.
    this.search$
      .pipe(debounceTime(400), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(() => {
      this.page = 1;
      this.fetch();
    });
    this.suppliersService.listActive().subscribe((suppliers) => this.suppliers.set(suppliers));
    this.fetch();
  }

  onLazyLoad(event: TableLazyLoadEvent): void {
    const first = event.first ?? 0;
    // El tamaño lo manda la tabla: si no se guarda, cambiar "por página" pedía
    // otra vez 50 al servidor y el paginador mostraba un total que no cuadraba.
    this.pageSize = event.rows ?? this.rows;
    this.page = Math.floor(first / this.pageSize) + 1;
    this.fetch();
  }

  onSearch(term: string): void {
    this.search.set(term);
    this.search$.next(term.trim());
  }

  onSupplierChange(supplierId: string | null): void {
    this.supplierId.set(supplierId);
    this.page = 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.invoicesService
      .list({
        search: this.search() || undefined,
        supplierId: this.supplierId() ?? undefined,
        page: this.page,
        limit: this.pageSize,
      })
      .subscribe({
        next: ({ items, meta }) => {
          this.invoices.set(items);
          this.totalRecords.set(meta.total);
          this.loading.set(false);
        },
        error: () => {
          this.notifications.error('No se pudieron cargar las facturas.');
          this.loading.set(false);
        },
      });
  }

  reload(): void {
    this.fetch();
  }

  create(): void {
    void this.router.navigate(['/pos/facturas/nuevo']);
  }

  viewDetail(invoice: PurchaseInvoice): void {
    void this.router.navigate(['/pos/facturas', invoice.id]);
  }
}
