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
import { Category } from '../../../../shared/models';
import { CategoryService } from '../../services/category.service';

@Component({
  selector: 'app-category-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    TranslatePipe,
    ButtonModule,
    DialogModule,
    InputTextModule,
    TableModule,
    TagModule,
    TooltipModule,
  ],
  templateUrl: './category-list.html',
})
export class CategoryList {
  private readonly categoriesService = inject(CategoryService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  readonly categories = signal<Category[]>([]);
  readonly loading = signal(false);
  readonly search = signal('');
  readonly totalRecords = signal(0);
  /**
   * 50 por página: con 10 la lista completa quedaba repartida en páginas de una
   * pantalla escasa y buscar una categoría obligaba a paginar. El tope de la API
   * es 100 (`parsePagination`), así que 50 cabe con margen.
   */
  readonly rows = 50;
  readonly rowsPerPageOptions = [50, 100];
  /** Tamaño de página vigente: cambia si el usuario elige otro en el paginador. */
  private pageSize = this.rows;

  readonly deactivateTarget = signal<Category | null>(null);
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
    this.categoriesService
      .list({ search: this.search() || undefined, activeOnly: false, page: this.page, limit: this.pageSize })
      .subscribe({
        next: ({ items, meta }) => {
          this.categories.set(items);
          this.totalRecords.set(meta.total);
          this.loading.set(false);
        },
        error: () => {
          this.notifications.error('No se pudieron cargar las categorías.');
          this.loading.set(false);
        },
      });
  }

  reload(): void {
    this.fetch();
  }

  create(): void {
    void this.router.navigate(['/pos/categorias/nuevo']);
  }

  edit(category: Category): void {
    void this.router.navigate(['/pos/categorias', category.id, 'editar']);
  }

  askDeactivate(category: Category): void {
    this.deactivateTarget.set(category);
  }

  cancelDeactivate(): void {
    this.deactivateTarget.set(null);
  }

  confirmDeactivate(): void {
    const category = this.deactivateTarget();
    if (!category) {
      return;
    }
    this.deactivating.set(true);
    this.categoriesService.deactivate(category.id).subscribe({
      next: () => {
        this.notifications.success('Categoría desactivada.');
        this.deactivating.set(false);
        this.deactivateTarget.set(null);
        this.fetch();
      },
      error: (error: unknown) => {
        this.deactivating.set(false);
        this.notifications.error(error instanceof Error ? error.message : 'No se pudo desactivar la categoría.');
      },
    });
  }
}
