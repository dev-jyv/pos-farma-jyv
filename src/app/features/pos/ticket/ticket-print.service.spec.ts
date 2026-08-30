import { TestBed } from '@angular/core/testing';
import { providePrimeNG } from 'primeng/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CashSession, CashSessionSummary, Product, Sale } from '../../../shared/models';
import { TicketPrintService } from './ticket-print.service';

function sale(): Sale {
  return {
    id: 'v1',
    folio: 'V-000001',
    items: [],
    subtotal: 100,
    discountTotal: 0,
    total: 100,
    taxSummary: null,
    paymentMethod: 'cash',
    amountReceived: 100,
    change: 0,
    cashAmount: 100,
    cardAmount: null,
    cardPaymentReference: null,
    cashierId: 'u1',
    cashSessionId: 's1',
    customerId: null,
    customerName: null,
    prescription: null,
    prescriptionRetained: false,
    controlledGroups: [],
    billing: null,
    invoiceStatus: null,
    voidedAt: null,
    createdAt: new Date('2026-08-08T15:00:00'),
  } as Sale;
}

const summary: CashSessionSummary = {
  salesCount: 1,
  voidedCount: 0,
  byMethod: {
    cash: { count: 1, total: 100 },
    card: { count: 0, total: 0 },
    transfer: { count: 0, total: 0 },
    mixed: { count: 0, total: 0 },
  },
  movements: {
    deposits: { count: 0, total: 0 },
    withdrawals: { count: 0, total: 0 },
    expenses: { count: 0, total: 0 },
  },
  grandTotal: 100,
  cashInDrawer: 600,
};

const session = {
  id: 's1',
  openedBy: 'u1',
  openingAmount: 500,
  expectedCashAmount: 600,
  countedCashAmount: 600,
  cashDifference: 0,
  summary,
  openedAt: new Date('2026-08-08T14:00:00'),
  closedAt: new Date('2026-08-08T22:00:00'),
} as CashSession;

/** Cede el turno para que corran el `setTimeout(100)` y el cleanup de la impresión. */
async function flushPrint(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1700));
}

describe('TicketPrintService', () => {
  let service: TicketPrintService;
  let printSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [providePrimeNG({})] });
    service = TestBed.inject(TicketPrintService);
    printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
  });

  afterEach(() => {
    printSpy.mockRestore();
    document.querySelectorAll('.pos-print-root').forEach((node) => node.remove());
  });

  it('monta el ticket de venta fuera de la app y manda imprimir', async () => {
    service.printSale(sale(), 'caja@farmajyv.mx');

    const host = document.querySelector('.pos-print-root');
    expect(host).not.toBeNull();
    expect(host?.textContent).toContain('V-000001');

    await flushPrint();
    expect(printSpy).toHaveBeenCalled();
  });

  it('desmonta el host al terminar: dos impresiones no dejan dos tickets pegados', async () => {
    service.printSale(sale());
    await flushPrint();

    expect(document.querySelectorAll('.pos-print-root')).toHaveLength(0);
  });

  it('imprime el corte de caja con lo contado y lo esperado', async () => {
    service.printCashCut({
      session,
      summary,
      expectedCashAmount: 600,
      countedCashAmount: 600,
      cashDifference: 0,
    });

    const host = document.querySelector('.pos-print-root');
    expect(host?.textContent).toBeTruthy();

    await flushPrint();
    expect(printSpy).toHaveBeenCalled();
  });

  it('imprime la etiqueta de un producto', async () => {
    service.printProductLabel({ id: 'p1', name: 'Paracetamol', salePrice: 50 } as Product);

    expect(document.querySelector('.pos-print-root')?.textContent).toContain('Paracetamol');

    await flushPrint();
    expect(printSpy).toHaveBeenCalled();
  });

  it('el evento `afterprint` limpia sin esperar al temporizador', async () => {
    service.printSale(sale());
    await Promise.resolve();
    window.dispatchEvent(new Event('afterprint'));

    expect(document.querySelectorAll('.pos-print-root')).toHaveLength(0);
  });
});
