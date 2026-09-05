import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import {
  ControlledLedgerEntry,
  ControlledLedgerPage,
  ControlledLedgerService,
} from '../services/controlled-ledger.service';
import { ControlledLedger } from './controlled-ledger';

function entry(overrides: Partial<ControlledLedgerEntry> = {}): ControlledLedgerEntry {
  return {
    id: 'e1',
    type: 'sale',
    saleId: 'v1',
    saleFolio: 'V-000001',
    referenceFolio: null,
    productId: 'p1',
    productName: 'Clonazepam',
    controlledGroup: 'II',
    quantity: 2,
    lotNumbers: ['L1'],
    prescription: null,
    prescriptionRetained: true,
    customerName: null,
    userId: 'u1',
    createdAt: new Date('2026-08-08T10:00:00'),
    ...overrides,
  };
}

describe('ControlledLedger', () => {
  let fixture: ComponentFixture<ControlledLedger>;
  let component: ControlledLedger;
  let page: ControlledLedgerPage;
  let list: () => Observable<ControlledLedgerPage>;
  let listCalls: Array<Record<string, unknown>>;
  let exportCsv: () => Observable<Blob>;
  let can: (area: string, level?: string) => boolean;
  let notifyError: ReturnType<typeof vi.fn>;

  async function build(): Promise<void> {
    listCalls = [];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
        {
          provide: ControlledLedgerService,
          useValue: {
            list: (filters: Record<string, unknown>) => {
              listCalls.push(filters);
              return list();
            },
            exportCsv: () => exportCsv(),
          },
        },
        { provide: AuthService, useValue: { can: (area: string, level?: string) => can(area, level) } },
      ],
    });

    fixture = TestBed.createComponent(ControlledLedger);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    listCalls = [];
    page = { entries: [entry()], meta: { page: 1, limit: 100, total: 1, totalPages: 1 } };
    list = () => of(page);
    exportCsv = () => of(new Blob(['folio'], { type: 'text/csv' }));
    can = () => true;
    await build();
  });

  describe('permisos', () => {
    it('con permiso de inventario carga el libro al resolverse el rol', () => {
      expect(component.entries()).toHaveLength(1);
      expect(listCalls).toHaveLength(1);
    });

    it('sin permiso no consulta ni deja exportar', async () => {
      can = () => false;
      await build();

      expect(listCalls).toHaveLength(0);
      component.exportCsv();
      expect(component.exporting()).toBe(false);
    });
  });

  describe('rango', () => {
    it('un rango invertido se rechaza antes de pegar al servidor', () => {
      component.from.set('2026-08-31');
      component.to.set('2026-08-01');

      expect(component.rangeError()).not.toBeNull();
      const before = listCalls.length;
      component.reload();

      expect(listCalls).toHaveLength(before);
      expect(notifyError).toHaveBeenCalled();
    });

    it('los extremos viajan con el offset de la zona de la farmacia', () => {
      const filters = listCalls[0];
      expect(String(filters['from'])).toMatch(/T00:00:00/);
      expect(String(filters['to'])).toMatch(/T23:59:59/);
    });

    it('el periodo impreso solo se sella cuando la consulta tuvo éxito', () => {
      const appliedBefore = component.appliedFrom();
      list = () => throwError(() => new Error('500'));

      component.from.set('2026-01-01');
      component.reload();

      expect(component.appliedFrom()).toBe(appliedBefore);
      expect(component.entries()).toEqual([]);
      expect(component.loadError()).toBe('500');
    });

    it('los campos modificados marcan el periodo como no aplicado', () => {
      expect(component.rangeDirty()).toBe(false);
      component.from.set('2026-01-01');
      expect(component.rangeDirty()).toBe(true);
    });

    it('un rango rápido consulta de inmediato', () => {
      component.selectQuickRange(6);

      expect(component.activeRangeDays()).toBe(6);
      expect(listCalls).toHaveLength(2);
    });
  });

  describe('resumen', () => {
    it('la cantidad neta resta los reingresos por anulación', async () => {
      page = {
        entries: [entry(), entry({ id: 'e2', type: 'void', quantity: -2 })],
        meta: null,
      };
      await build();

      expect(component.netQuantity()).toBe(0);
    });

    it('agrupa por grupo COFEPRIS y cuenta aparte los renglones sin grupo', async () => {
      page = {
        entries: [entry(), entry({ id: 'e2', controlledGroup: 'I', quantity: 3 }), entry({ id: 'e3', controlledGroup: null })],
        meta: null,
      };
      await build();

      expect(component.byGroup().map((row) => [row.group, row.movements, row.quantity])).toEqual([
        ['I', 1, 3],
        ['II', 1, 2],
      ]);
      expect(component.ungrouped()).toHaveLength(1);
    });

    it('detecta que el servidor tiene más renglones de los que trajo', async () => {
      page = { entries: [entry()], meta: { page: 1, limit: 100, total: 240, totalPages: 3 } };
      await build();

      expect(component.truncated()).toBe(true);
    });
  });

  describe('impresión y exportación', () => {
    it('no se imprime una hoja con error o rango inválido', () => {
      const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);

      component.loadError.set('500');
      component.print();
      expect(printSpy).not.toHaveBeenCalled();

      component.loadError.set(null);
      component.print();
      expect(printSpy).toHaveBeenCalled();

      printSpy.mockRestore();
    });

    it('exporta el CSV del periodo completo', () => {
      const createObjectURL = vi.fn(() => 'blob:csv');
      const revokeObjectURL = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

      component.exportCsv();

      expect(createObjectURL).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalled();
      expect(component.exporting()).toBe(false);
    });

    it('un fallo al exportar se avisa y libera el botón', () => {
      exportCsv = () => throwError(() => new Error('500'));

      component.exportCsv();

      expect(component.exporting()).toBe(false);
      expect(notifyError).toHaveBeenCalled();
    });
  });

  it('groupLabel nombra "Sin grupo" en vez de inventar uno', () => {
    expect(component.groupLabel(null)).toBe('Sin grupo');
    expect(component.groupLabel('II')).not.toBe('Sin grupo');
  });
});
