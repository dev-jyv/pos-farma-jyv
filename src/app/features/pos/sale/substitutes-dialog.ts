import { CurrencyPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';

import { Product } from '../../../shared/models';

@Component({
  selector: 'app-substitutes-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, TranslatePipe, ButtonModule, DialogModule],
  template: `
    <p-dialog
      [visible]="visible()"
      (visibleChange)="closed.emit()"
      [modal]="true"
      [style]="{ width: '28rem' }"
      [header]="'sale.substitutes.title' | translate"
    >
      <p class="mb-3 text-sm text-slate-600">
        {{ 'sale.substitutes.noStockFor' | translate }}
        <span class="font-semibold text-slate-900">{{ sourceName() }}</span>.
        @if (ingredient()) {
          {{ 'sale.substitutes.ingredient' | translate }} <span class="font-medium">{{ ingredient() }}</span>
        }
      </p>
      @if (alternatives().length === 0) {
        <p class="py-6 text-center text-sm text-slate-500">{{ 'sale.substitutes.empty' | translate }}</p>
      } @else {
        <ul class="space-y-2">
          @for (product of alternatives(); track product.id) {
            <li class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2">
              <div class="min-w-0">
                <div class="truncate text-sm font-semibold capitalize text-slate-900">{{ product.name }}</div>
                <div class="text-xs text-slate-500">
                  {{ 'sale.substitutes.stock' | translate: { stock: product.stock } }} · {{ product.salePrice | currency: 'MXN':'symbol-narrow':'1.2-2' }}
                </div>
              </div>
              <p-button icon="pi pi-plus" size="small" (onClick)="selected.emit(product)" />
            </li>
          }
        </ul>
      }
      <ng-template #footer>
        <p-button [label]="'common.close' | translate" severity="secondary" (onClick)="closed.emit()" />
      </ng-template>
    </p-dialog>
  `,
})
export class SubstitutesDialog {
  readonly visible = input(false);
  readonly sourceName = input('');
  readonly ingredient = input('');
  readonly alternatives = input<Product[]>([]);

  readonly closed = output<void>();
  readonly selected = output<Product>();
}
