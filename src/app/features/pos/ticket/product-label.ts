import { CurrencyPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Product } from '../../../shared/models';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-product-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe],
  templateUrl: './product-label.html',
  styleUrl: './product-label.css',
})
export class ProductLabel {
  readonly product = input.required<Product>();

  readonly pharmacy = environment.pharmacy;
}
