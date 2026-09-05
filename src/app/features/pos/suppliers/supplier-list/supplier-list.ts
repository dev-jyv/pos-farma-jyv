import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { NotificationService } from '../../../../core/notifications/notification.service';
import { Supplier } from '../../../../shared/models';
import { SupplierService } from '../../services/supplier.service';

@Component({
  selector: 'app-supplier-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, ButtonModule, DialogModule, InputTextModule, TableModule, TagModule, TooltipModule],
  templateUrl: './supplier-list.html',
})
export class SupplierList {
  private readonly suppliersService = inject(SupplierService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  readonly suppliers = signal<Supplier[]>([]);
  readonly loading = signal(false);
  readonly search = signal('');
  readonly totalRecords = signal(0);
  /**
   * 50 por página, igual que categorías y facturas: con 10 la lista quedaba
   * repartida en páginas de una pantalla escasa y encontrar un proveedor
   * obligaba a paginar. El tope de la API es 100 (`parsePagination`).
   */
  readonly rows = 50;
  readonly rowsPerPageOptions = [50, 100];
  /** Tamaño de página vigente: cambia si el usuario elige otro en el paginador. */
  private pageSize = this.rows;

  readonly deactivateTarget = signal<Supplier | null>(null);
  readonly deactivating = signal(false);

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

  private fetch(): void {
    this.loading.set(true);
    this.suppliersService
      .list({ search: this.search() || undefined, activeOnly: false, page: this.page, limit: this.pageSize })
      .subscribe({
        next: ({ items, meta }) => {
          this.suppliers.set(items);
          this.totalRecords.set(meta.total);
          this.loading.set(false);
        },
        error: () => {
          this.notifications.error('No se pudieron cargar los proveedores.');
          this.loading.set(false);
        },
      });
  }

  reload(): void {
    this.fetch();
  }

  create(): void {
    void this.router.navigate(['/pos/proveedores/nuevo']);
  }

  edit(supplier: Supplier): void {
    void this.router.navigate(['/pos/proveedores', supplier.id, 'editar']);
  }

  askDeactivate(supplier: Supplier): void {
    this.deactivateTarget.set(supplier);
  }

  cancelDeactivate(): void {
    this.deactivateTarget.set(null);
  }

  confirmDeactivate(): void {
    const supplier = this.deactivateTarget();
    if (!supplier) {
      return;
    }
    this.deactivating.set(true);
    this.suppliersService.deactivate(supplier.id).subscribe({
      next: () => {
        this.notifications.success('Proveedor desactivado.');
        this.deactivating.set(false);
        this.deactivateTarget.set(null);
        this.fetch();
      },
      error: (error: unknown) => {
        this.deactivating.set(false);
        this.notifications.error(error instanceof Error ? error.message : 'No se pudo desactivar el proveedor.');
      },
    });
  }
}
