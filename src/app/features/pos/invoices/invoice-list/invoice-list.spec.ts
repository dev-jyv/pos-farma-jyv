import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { TableLazyLoadEvent } from 'primeng/table';
import { Observable, of, throwError } from 'rxjs';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../../core/notifications/notification.service';
import { ApiListMeta } from '../../../../core/api/api.utils';
import { PurchaseInvoice } from '../../../../shared/models';
import { InvoiceService, ListInvoicesQuery } from '../../services/invoice.service';
import { SupplierService } from '../../services/supplier.service';
import { InvoiceList } from './invoice-list';

function invoice(overrides: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    id: 'inv-1',
    invoiceNumber: 'E2E-FOLIO-11149',
    invoiceDate: new Date('2026-09-03T00:00:00.000Z'),
    supplierId: 's1',
    supplierName: 'E2E-Proveedor-7841',
    totalAmount: 150,
    hasInvoice: true,
    ...overrides,
  };
}

function respuesta(items: PurchaseInvoice[], meta: Partial<ApiListMeta> = {}) {
  return of({
    items,
    meta: { page: 1, limit: 50, total: items.length, totalPages: 1, ...meta } as ApiListMeta,
  });
}

describe('InvoiceList', () => {
  let fixture: ComponentFixture<InvoiceList>;
  let component: InvoiceList;
  let list: Mock;
  let notifyError: Mock;

  const ultimaConsulta = (): ListInvoicesQuery => list.mock.calls.at(-1)![0];

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: SupplierService, useValue: { listActive: () => of([]) } },
        {
          provide: InvoiceService,
          useValue: { list: (query: ListInvoicesQuery) => list(query) as Observable<unknown> },
        },
      ],
    });

    fixture = TestBed.createComponent(InvoiceList);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    list = vi.fn(() => respuesta([invoice()]));
    await build();
  });

  it('pide la primera página de 50 al entrar', () => {
    expect(ultimaConsulta()).toMatchObject({ page: 1, limit: 50 });
  });

  it('el paginador conoce el total que reporta el servidor, no el de la página', async () => {
    list = vi.fn(() => respuesta([invoice()], { total: 137 }));
    await build();

    expect(component.totalRecords()).toBe(137);
  });

  describe('paginación contra el servidor', () => {
    it('avanzar de página pide la siguiente al servidor, no recorta en pantalla', () => {
      component.onLazyLoad({ first: 50, rows: 50 } as TableLazyLoadEvent);

      expect(ultimaConsulta()).toMatchObject({ page: 2, limit: 50 });
    });

    it('la tercera página se calcula desde el desplazamiento', () => {
      component.onLazyLoad({ first: 100, rows: 50 } as TableLazyLoadEvent);

      expect(ultimaConsulta()).toMatchObject({ page: 3 });
    });

    it('cambiar "por página" a 100 se respeta en la consulta', () => {
      component.onLazyLoad({ first: 0, rows: 100 } as TableLazyLoadEvent);

      expect(ultimaConsulta()).toMatchObject({ page: 1, limit: 100 });
    });

    it('con 100 por página, la segunda página empieza en el registro 100', () => {
      component.onLazyLoad({ first: 100, rows: 100 } as TableLazyLoadEvent);

      expect(ultimaConsulta()).toMatchObject({ page: 2, limit: 100 });
    });

    it('las opciones de tamaño no pasan del tope de la API', () => {
      expect(Math.max(...component.rowsPerPageOptions)).toBeLessThanOrEqual(100);
    });
  });

  describe('filtros', () => {
    it('filtrar por proveedor regresa a la primera página', () => {
      component.onLazyLoad({ first: 100, rows: 50 } as TableLazyLoadEvent);
      component.onSupplierChange('s9');

      expect(ultimaConsulta()).toMatchObject({ page: 1, supplierId: 's9' });
    });

    it('quitar el proveedor no manda un filtro vacío', () => {
      component.onSupplierChange(null);

      expect(ultimaConsulta().supplierId).toBeUndefined();
    });

    it('recargar conserva la página en la que está el usuario', () => {
      component.onLazyLoad({ first: 50, rows: 50 } as TableLazyLoadEvent);
      component.reload();

      expect(ultimaConsulta()).toMatchObject({ page: 2 });
    });
  });

  it('un fallo avisa y suelta el spinner', async () => {
    list = vi.fn(() => throwError(() => new Error('500')));
    await build();

    expect(notifyError).toHaveBeenCalled();
    expect(component.loading()).toBe(false);
  });
});
