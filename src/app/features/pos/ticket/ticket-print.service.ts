import {
  ApplicationRef,
  ComponentRef,
  EnvironmentInjector,
  Injectable,
  Type,
  createComponent,
  inject,
} from '@angular/core';

import { CashSession, CashSessionSummary, Product, Sale } from '../../../shared/models';
import { ProductLabel } from './product-label';
import { CashCutTicket, SaleTicket } from './sale-ticket';

@Injectable({ providedIn: 'root' })
export class TicketPrintService {
  private readonly appRef = inject(ApplicationRef);
  private readonly environmentInjector = inject(EnvironmentInjector);

  printSale(sale: Sale, cashierLabel = ''): void {
    this.printHost(SaleTicket, (ref) => {
      ref.setInput('sale', sale);
      ref.setInput('cashierLabel', cashierLabel);
    });
  }

  printCashCut(params: {
    session: CashSession;
    summary: CashSessionSummary;
    expectedCashAmount: number;
    countedCashAmount: number;
    cashDifference: number;
  }): void {
    this.printHost(CashCutTicket, (ref) => {
      ref.setInput('openedAt', params.session.openedAt);
      ref.setInput('closedAt', params.session.closedAt);
      ref.setInput('openingAmount', params.session.openingAmount);
      ref.setInput('expectedCashAmount', params.expectedCashAmount);
      ref.setInput('countedCashAmount', params.countedCashAmount);
      ref.setInput('cashDifference', params.cashDifference);
      ref.setInput('summary', params.summary);
    });
  }

  printProductLabel(product: Product): void {
    this.printHost(ProductLabel, (ref) => {
      ref.setInput('product', product);
    });
  }

  private printHost<T>(component: Type<T>, bind: (ref: ComponentRef<T>) => void): void {
    const host = document.createElement('div');
    host.className = 'pos-print-root';
    document.body.appendChild(host);

    const ref = createComponent(component, {
      environmentInjector: this.environmentInjector,
      hostElement: host,
    });
    bind(ref);
    this.appRef.attachView(ref.hostView);
    ref.changeDetectorRef.detectChanges();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      this.appRef.detachView(ref.hostView);
      ref.destroy();
      host.remove();
      window.removeEventListener('afterprint', cleanup);
    };

    window.addEventListener('afterprint', cleanup);
    // Un frame + breve pausa: el host ya está en el DOM y el diálogo de cobro
    // (si venía de ahí) ya empezó a cerrarse.
    window.setTimeout(() => {
      window.print();
      setTimeout(cleanup, 1500);
    }, 100);
  }
}
