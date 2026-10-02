import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Subject, of, throwError } from 'rxjs';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { CashMovement, ExpenseCategory } from '../../../../shared/models';
import { CashMovementService } from '../../services/cash-movement.service';
import { ExpensesAudit } from './expenses-audit';

function expense(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    id: 'mov-1',
    cashSessionId: 's1',
    type: 'expense',
    amount: 120,
    reason: 'Insumos: guantes',
    category: 'supplies',
    description: 'Cajas de guantes',
    createdBy: 'u1',
    createdAt: new Date('2026-09-05T15:00:00.000Z'),
    ...overrides,
  };
}

describe('ExpensesAudit (solo admin)', () => {
  let fixture: ComponentFixture<ExpensesAudit>;
  let component: ExpensesAudit;
  let listMovementsAudit: Mock;
  let listForSession: Mock;

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        {
          provide: CashMovementService,
          useValue: {
            listMovementsAudit: (filters?: unknown) => listMovementsAudit(filters),
            listForSession,
          },
        },
      ],
    });

    fixture = TestBed.createComponent(ExpensesAudit);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    listForSession = vi.fn();
    listMovementsAudit = vi.fn(() =>
      of({ items: [expense()], meta: { page: 1, limit: 50, total: 1, totalPages: 1 } }),
    );
    await build();
  });

  it('lista solo gastos: la auditoría de gastos nunca muestra depósitos ni retiros', () => {
    expect(listMovementsAudit).toHaveBeenCalledWith({ type: 'expense', page: 1, limit: 50 });
    expect(component.movements()).toHaveLength(1);
  });

  it('mantiene el filtro de gastos al filtrar por categoría', () => {
    component.onCategoryChange('rent');
    expect(listMovementsAudit).toHaveBeenLastCalledWith({
      type: 'expense',
      category: 'rent',
      page: 1,
      limit: 50,
    });
  });

  it('la opción "todas" quita la categoría pero conserva el tipo', () => {
    component.onCategoryChange('rent');
    component.onCategoryChange('');
    expect(listMovementsAudit).toHaveBeenLastCalledWith({ type: 'expense', page: 1, limit: 50 });
  });

  it('ofrece las 8 categorías del negocio más el "todas"', () => {
    expect(component.categoryOptions()).toHaveLength(9);
    expect(component.categoryOptions()[0].value).toBe('');
  });

  /**
   * Los rótulos ya no están a fuego en español: la pantalla usa la llave de
   * i18n, así que con la app en inglés el filtro se ve en inglés.
   */
  it.each<[ExpenseCategory, string]>([
    ['salary', 'expenses.categorySalary'],
    ['food', 'expenses.categoryFood'],
    ['rent', 'expenses.categoryRent'],
    ['contingency', 'expenses.categoryContingency'],
    ['electricity', 'expenses.categoryElectricity'],
    ['supplies', 'expenses.categorySupplies'],
    ['supplier', 'expenses.categorySupplier'],
    ['other', 'expenses.categoryOther'],
  ])('la categoría "%s" se rotula con la llave "%s"', (category, key) => {
    expect(component.categoryKey(category)).toBe(key);
  });

  it('un gasto viejo sin categoría no rompe la tabla', () => {
    expect(component.categoryKey(null)).toBe('');
    expect(component.categoryKey(undefined)).toBe('');
  });

  describe('paginación', () => {
    /** El techo de 200 gastos desaparece: cada página es una consulta. */
    it('cambiar de página consulta la siguiente al servidor', async () => {
      listMovementsAudit = vi.fn(() =>
        of({ items: [expense()], meta: { page: 2, limit: 50, total: 130, totalPages: 3 } }),
      );
      await build();

      component.onPageChange({ first: 50 });
      await fixture.whenStable();

      expect(listMovementsAudit).toHaveBeenLastCalledWith({ type: 'expense', page: 2, limit: 50 });
      expect(component.total()).toBe(130);
    });

    it('cambiar de categoría vuelve a la primera página', async () => {
      component.onPageChange({ first: 100 });
      await fixture.whenStable();

      component.onCategoryChange('rent');
      await fixture.whenStable();

      expect(component.first()).toBe(0);
    });
  });

  it('un fallo del listado se muestra y no deja el spinner colgado', async () => {
    listMovementsAudit = vi.fn(() => throwError(() => new Error('500')));
    await build();

    expect(component.loadError()).toBeTruthy();
    expect(component.loading()).toBe(false);
  });

  it('no consulta el SQLite local: la auditoría es de todas las cajas', () => {
    expect(listForSession).not.toHaveBeenCalled();
  });

  /**
   * Lo que se ve en pantalla, no solo lo que dicen las señales: el admin audita
   * leyendo esta tabla, y una fila que no pinta el importe o un vacío que dice
   * "no hay gastos" cuando en realidad falló la consulta le hacen tomar la
   * decisión contraria.
   */
  describe('DOM', () => {
    function host(): HTMLElement {
      return fixture.nativeElement as HTMLElement;
    }

    it('pinta el gasto con su categoría traducida y su importe', () => {
      const translate = TestBed.inject(TranslateService);
      translate.setTranslation('es', { expenses: { categorySupplies: 'Insumos' } }, true);
      fixture.detectChanges();

      const fila = host().querySelector('tbody tr');
      expect(fila).not.toBeNull();
      expect(fila!.textContent).toContain('Insumos');
      expect(fila!.textContent).toContain('120.00');
    });

    it('el filtro de categoría tiene nombre accesible propio', () => {
      const etiqueta = host().querySelector('#expenses-audit-category-label');
      expect(etiqueta).not.toBeNull();
      expect(host().querySelector('[aria-labelledby="expenses-audit-category-label"]')).not.toBeNull();
    });

    it('el botón de refrescar tiene aria-label: es un icono sin texto', () => {
      expect(host().querySelector('button[aria-label]')).not.toBeNull();
    });

    it('refrescar vuelve a consultar el listado', () => {
      const antes = listMovementsAudit.mock.calls.length;
      const refrescar = host().querySelector<HTMLButtonElement>('button[aria-label]');

      refrescar!.click();

      expect(listMovementsAudit.mock.calls.length).toBeGreaterThan(antes);
    });

    it('sin gastos muestra el mensaje vacío, no una tabla en blanco', async () => {
      listMovementsAudit = vi.fn(() =>
        of({ items: [] as CashMovement[], meta: { page: 1, limit: 50, total: 0, totalPages: 0 } }),
      );
      await build();
      fixture.detectChanges();

      expect(host().querySelector('tbody tr')?.textContent?.trim().length).toBeGreaterThan(0);
      expect(host().querySelectorAll('tbody tr')).toHaveLength(1);
    });

    /**
     * El vacío de la tabla y "todavía estoy cargando" se leen igual. Sin este
     * paso, la primera pintada decía "sin gastos registrados" antes de que
     * llegara la respuesta.
     */
    it('mientras carga por primera vez no dice "sin gastos": muestra el cargando', async () => {
      const enVuelo = new Subject<{ items: CashMovement[]; meta: null }>();
      listMovementsAudit = vi.fn(() => enVuelo.asObservable());
      await build();
      fixture.detectChanges();

      expect(component.initialLoading()).toBe(true);
      expect(host().querySelector('[data-testid="expenses-audit-loading"]')).not.toBeNull();

      enVuelo.next({ items: [], meta: null });
      enVuelo.complete();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.initialLoading()).toBe(false);
      expect(host().querySelector('[data-testid="expenses-audit-loading"]')).toBeNull();
    });

    it('un fallo apaga el cargando y muestra la banda de error en el DOM', async () => {
      listMovementsAudit = vi.fn(() => throwError(() => new Error('500')));
      await build();
      fixture.detectChanges();

      expect(host().querySelector('[data-testid="expenses-audit-loading"]')).toBeNull();
      expect(host().querySelector('[role="alert"]')?.textContent).toBeTruthy();
    });
  });
});
