import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { Subject, debounceTime, switchMap } from 'rxjs';

import { Product } from '../../../../shared/models';
import { ProductCatalogService } from '../../services/product-catalog.service';
import { ProductService } from '../../services/product.service';

/** Con una letra el catálogo local devuelve medio mostrador; no es búsqueda útil. */
const MIN_SEARCH_LENGTH = 2;

/**
 * Edición de catálogo — búsqueda 100% local (SQLite vía IPC, sin red). Lista
 * en vez de tabla paginada contra servidor: el catálogo local ya cabe en una
 * sola consulta instantánea, así que no hay nada que optimizar con paginado
 * remoto aquí.
 */
@Component({
  selector: 'app-product-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, ButtonModule, InputTextModule, TableModule, TagModule, DecimalPipe],
  templateUrl: './product-list.html',
})
export class ProductList {
  private readonly productService = inject(ProductService);
  private readonly catalogService = inject(ProductCatalogService);
  private readonly router = inject(Router);

  readonly search = signal('');
  readonly results = signal<Product[]>([]);
  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly pendingCount = this.catalogService.pendingCount;

  private readonly search$ = new Subject<string>();

  constructor() {
    this.search$
      .pipe(
        debounceTime(300),
        // Sin `distinctUntilChanged()` a propósito: repetir el mismo término
        // tras borrar y volver a teclear no debe descartarse como duplicado
        // (bug real ya encontrado en `sale.ts`/`stock-entry.ts` con este mismo
        // patrón). La búsqueda es local y cuesta prácticamente nada repetirla.
        switchMap((term) => this.productService.search(term)),
      )
      .subscribe((products) => {
        this.results.set(products);
        this.searching.set(false);
        this.searched.set(true);
      });
  }

  onSearchChange(term: string): void {
    this.search.set(term);
    this.searched.set(false);
    if (term.trim().length < MIN_SEARCH_LENGTH) {
      this.results.set([]);
      this.searching.set(false);
      return;
    }
    this.searching.set(true);
    this.search$.next(term);
  }

  create(): void {
    void this.router.navigate(['/pos/productos/nuevo']);
  }

  edit(product: Product): void {
    void this.router.navigate(['/pos/productos', product.id, 'editar']);
  }
}
