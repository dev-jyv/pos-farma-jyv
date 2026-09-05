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
  readonly rows = 10;

  readonly deactivateTarget = signal<Supplier | null>(null);
  readonly deactivating = signal(false);

  private readonly search$ = new Subject<string>();
  private page = 1;

  constructor() {
    this.search$.pipe(debounceTime(400), distinctUntilChanged()).subscribe(() => {
      this.page = 1;
      this.fetch();
    });
    this.fetch();
  }

  onLazyLoad(event: TableLazyLoadEvent): void {
    const first = event.first ?? 0;
    const rows = event.rows ?? this.rows;
    this.page = Math.floor(first / rows) + 1;
    this.fetch();
  }

  onSearch(term: string): void {
    this.search.set(term);
    this.search$.next(term.trim());
  }

  private fetch(): void {
    this.loading.set(true);
    this.suppliersService
      .list({ search: this.search() || undefined, activeOnly: false, page: this.page, limit: this.rows })
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
