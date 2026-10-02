import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, Subject, of, throwError } from 'rxjs';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../../core/auth/auth.service';
import { NotificationService } from '../../../../core/notifications/notification.service';
import { CashMovement, CashSession, ExpenseCategory } from '../../../../shared/models';
import { CashMovementService } from '../../services/cash-movement.service';
import { CashSessionService } from '../../services/cash-session.service';
import { ExpenseForm } from './expense-form';

const TURNO = { id: 's1', openedBy: 'u1', closedAt: null } as CashSession;

/**
 * Traducciones reales de lo que esta pantalla rotula. El loader de pruebas es
 * vacío, así que sin esto `instant()` devuelve la llave: se registran las
 * mismas cadenas que `public/i18n/es.json` para poder afirmar sobre el texto
 * que de verdad ve el cajero (y de paso, que la llave existe).
 */
const ES = {
  common: { loading: 'Cargando…' },
  expenses: {
    amount: 'Monto',
    category: 'Categoría',
    reason: 'Detalle (opcional)',
    description: 'Descripción',
    save: 'Guardar gasto',
    cancel: 'Cancelar',
    saveEdit: 'Guardar corrección',
    cancelEdit: 'Cancelar corrección',
    edit: 'Corregir',
    editAria: 'Corregir el gasto de ${{amount}}',
    editingBanner: 'Corrigiendo el gasto de las {{time}}.',
    saved: 'Gasto registrado.',
    saveError: 'No se pudo registrar el gasto.',
    updated: 'Gasto corregido.',
    updateError: 'No se pudo corregir el gasto.',
    noSession: 'Abre tu turno de caja antes de registrar un gasto.',
    noAmount: 'Captura cuánto se gastó.',
    noCategory: 'Elige la categoría del gasto.',
    descriptionRequired: 'Describe en qué se gastó.',
    sessionEmpty: 'Sin gastos registrados en este turno.',
    sessionClosed: 'Abre tu turno para ver y registrar gastos.',
    categorySalary: 'Sueldo',
    categoryFood: 'Comida',
    categoryRent: 'Renta',
    categoryContingency: 'Imprevistos',
    categoryElectricity: 'Luz',
    categorySupplies: 'Insumos',
    categorySupplier: 'Proveedor',
    categoryOther: 'Otros',
  },
};

describe('ExpenseForm', () => {
  let fixture: ComponentFixture<ExpenseForm>;
  let component: ExpenseForm;
  let create: (id: string, input: unknown) => Observable<CashMovement>;
  let updateExpense: (id: string, patch: unknown) => Observable<CashMovement>;
  let listForSession: () => Observable<CashMovement[]>;
  let notifyError: Mock;
  let notifySuccess: Mock;
  let navigate: Mock;
  /** Valor de `?corregir=<id>`; por defecto ausente. */
  let corregirParam: string | null;
  let refreshCurrent: Mock;

  async function build(session: CashSession | null = TURNO): Promise<void> {
    TestBed.resetTestingModule();
    refreshCurrent = vi.fn(() => of(session));
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: notifySuccess } },
        { provide: Router, useValue: { navigate } },
        // La pantalla lee `?corregir=<id>` para abrir ya cargado un gasto que el
        // servidor rechazó, desde el aviso de la barra.
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: { get: () => corregirParam } } },
        },
        { provide: AuthService, useValue: { user: () => ({ uid: 'u1' }), profile: () => ({ email: 'cajero@test.com' }) } },
        {
          provide: CashSessionService,
          useValue: {
            current: () => session,
            isOpen: () => session !== null,
            refreshCurrent,
          },
        },
        {
          provide: CashMovementService,
          useValue: {
            create: (id: string, input: unknown) => create(id, input),
            listForSession: () => listForSession(),
            updateExpense: (id: string, patch: unknown) => updateExpense(id, patch),
          },
        },
      ],
    });

    TestBed.inject(TranslateService).setTranslation('es', ES, true);

    fixture = TestBed.createComponent(ExpenseForm);
    component = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    notifySuccess = vi.fn();
    navigate = vi.fn().mockResolvedValue(true);
    corregirParam = null;
    create = vi.fn((): Observable<CashMovement> => of({ id: 'm1' } as CashMovement));
    updateExpense = vi.fn((): Observable<CashMovement> => of({ id: 'm1' } as CashMovement));
    listForSession = vi.fn(() => of([] as CashMovement[]));
    await build();
  });

  it('refresca el turno al entrar: la pantalla puede ser la primera de la sesión', () => {
    expect(refreshCurrent).toHaveBeenCalledWith('u1');
  });

  it('ofrece exactamente las 8 categorías del negocio', () => {
    expect(component.categoryOptions().map((option) => option.value)).toEqual([
      'salary',
      'food',
      'rent',
      'contingency',
      'electricity',
      'supplies',
      'supplier',
      'other',
    ]);
  });

  describe('descripción condicional', () => {
    it.each<ExpenseCategory>(['supplies', 'supplier', 'other'])(
      'la categoría "%s" exige describir en qué se gastó',
      (category) => {
        component.amount.set(100);
        component.category.set(category);

        expect(component.requiresDescription()).toBe(true);
        expect(component.canSubmit()).toBe(false);

        component.description.set('Cajas de guantes');
        expect(component.canSubmit()).toBe(true);
      },
    );

    it.each<ExpenseCategory>(['salary', 'food', 'rent', 'contingency', 'electricity'])(
      'la categoría "%s" no exige descripción',
      (category) => {
        component.amount.set(100);
        component.category.set(category);

        expect(component.requiresDescription()).toBe(false);
        expect(component.canSubmit()).toBe(true);
      },
    );

    it('una descripción en blanco no satisface el requisito', () => {
      component.amount.set(100);
      component.category.set('supplies');
      component.description.set('    ');

      expect(component.canSubmit()).toBe(false);
    });
  });

  describe('bloqueos', () => {
    it('sin turno abierto no deja registrar y lo dice', async () => {
      await build(null);
      component.amount.set(100);
      component.category.set('food');

      expect(component.blockers()).toContain('expenses.noSession');
      expect(component.canSubmit()).toBe(false);

      component.save();
      expect(create).not.toHaveBeenCalled();
    });

    it('sin monto no deja registrar', () => {
      component.category.set('food');
      expect(component.blockers()).toContain('expenses.noAmount');
      expect(component.canSubmit()).toBe(false);
    });

    it('monto cero o negativo no cuenta como gasto', () => {
      component.category.set('food');
      component.amount.set(0);
      expect(component.canSubmit()).toBe(false);

      component.amount.set(-50);
      expect(component.canSubmit()).toBe(false);
    });

    it('sin categoría no deja registrar', () => {
      component.amount.set(100);
      expect(component.blockers()).toContain('expenses.noCategory');
      expect(component.canSubmit()).toBe(false);
    });

    it('save() no hace nada si hay bloqueos, aunque se llame directo', () => {
      component.save();
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('registro', () => {
    it('siempre manda type "expense" — esta pantalla nunca crea depósitos ni retiros', () => {
      component.amount.set(250);
      component.category.set('rent');
      component.save();

      expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'expense' }));
    });

    it('arma el motivo con la etiqueta de la categoría y el detalle libre', () => {
      component.amount.set(250);
      component.category.set('supplier');
      component.description.set('Medicamento de patente');
      component.reason.set('  Farmacéutica del Norte  ');
      component.save();

      expect(create).toHaveBeenCalledWith('s1', {
        type: 'expense',
        amount: 250,
        reason: 'Proveedor: Farmacéutica del Norte',
        category: 'supplier',
        description: 'Medicamento de patente',
        createdBy: 'u1',
        createdByLabel: 'cajero@test.com',
      });
    });

    it('sin detalle libre, el motivo es la etiqueta de la categoría', () => {
      component.amount.set(100);
      component.category.set('food');
      component.save();

      expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ reason: 'Comida' }));
    });

    it('el gasto se atribuye al cajero de la sesión, no a texto capturado', () => {
      component.amount.set(100);
      component.category.set('food');
      component.save();

      expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ createdBy: 'u1' }));
    });

    it('tras guardar avisa, limpia el formulario y se queda en la pantalla', () => {
      component.amount.set(100);
      component.category.set('food');
      component.save();

      expect(notifySuccess).toHaveBeenCalled();
      // Se queda: el gasto recién capturado se confirma en la lista del turno.
      expect(navigate).not.toHaveBeenCalledWith(['/pos']);
      expect(component.amount()).toBeNull();
      expect(component.category()).toBeNull();
    });

    it('refresca la lista del turno para que el cajero vea el gasto asentado', () => {
      const antes = (listForSession as Mock).mock.calls.length;
      component.amount.set(100);
      component.category.set('food');
      component.save();

      expect((listForSession as Mock).mock.calls.length).toBeGreaterThan(antes);
    });

    it('la lista del turno solo muestra gastos, no depósitos ni retiros', async () => {
      listForSession = vi.fn(() =>
        of([
          { id: 'm1', type: 'expense', amount: 120, category: 'food' },
          { id: 'm2', type: 'withdrawal', amount: 500 },
          { id: 'm3', type: 'expense', amount: 80, category: 'rent' },
        ] as CashMovement[]),
      );
      await build();

      expect(component.sessionExpenses().map((expense) => expense.id)).toEqual(['m1', 'm3']);
      // El total es lo que este turno va a descontar en su corte.
      expect(component.expensesTotal()).toBe(200);
    });

    it('un fallo avisa, no navega y deja reintentar', () => {
      create = vi.fn(() => throwError(() => new Error('boom')));
      component.amount.set(100);
      component.category.set('food');
      component.save();

      expect(notifyError).toHaveBeenCalled();
      expect(component.saving()).toBe(false);
    });

    it('el aviso de éxito y el de fallo salen de i18n, no del código', () => {
      component.amount.set(100);
      component.category.set('food');
      component.save();
      expect(notifySuccess).toHaveBeenCalledWith('Gasto registrado.');

      create = vi.fn(() => throwError(() => new Error('boom')));
      component.amount.set(100);
      component.category.set('food');
      component.save();
      expect(notifyError).toHaveBeenCalledWith('No se pudo registrar el gasto.');
    });

    it('no permite un doble envío mientras el primero sigue en curso', () => {
      // Respuesta en vuelo: el segundo clic ocurre antes de que conteste el
      // IPC, que es cuando un doble envío duplicaría el gasto en el corte.
      const enVuelo = new Subject<CashMovement>();
      create = vi.fn(() => enVuelo.asObservable());
      component.amount.set(100);
      component.category.set('food');

      component.save();
      component.save();

      expect(create).toHaveBeenCalledTimes(1);
      enVuelo.next({ id: 'm1' } as CashMovement);
      enVuelo.complete();
    });
  });

  /**
   * Corregir un gasto ya asentado: el importe corregido cambia el efectivo
   * esperado del corte, así que este camino no puede quedarse sin probar.
   */
  describe('corrección de un gasto', () => {
    const GASTO: CashMovement = {
      id: 'm1',
      cashSessionId: 's1',
      type: 'expense',
      amount: 120,
      reason: 'Insumos: guantes',
      category: 'supplies',
      description: 'Cajas de guantes',
      createdBy: 'u1',
      createdAt: new Date('2026-09-05T15:00:00.000Z'),
    };

    beforeEach(async () => {
      listForSession = vi.fn(() => of([GASTO]));
      await build();
    });

    it('precarga el formulario con el gasto, mostrando solo el detalle libre', () => {
      component.edit(GASTO);

      expect(component.editing()?.id).toBe('m1');
      expect(component.amount()).toBe(120);
      expect(component.category()).toBe('supplies');
      expect(component.description()).toBe('Cajas de guantes');
      // El motivo se guarda como "Categoría: detalle"; al editar se muestra
      // solo lo que el cajero escribió.
      expect(component.reason()).toBe('guantes');
    });

    it('guarda la corrección con el patch, no crea un gasto nuevo', () => {
      component.edit(GASTO);
      component.amount.set(150);
      component.save();

      expect(updateExpense).toHaveBeenCalledWith('m1', {
        amount: 150,
        reason: 'Insumos: guantes',
        category: 'supplies',
        description: 'Cajas de guantes',
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('tras corregir limpia el formulario y recarga la lista del turno', () => {
      const antes = (listForSession as Mock).mock.calls.length;
      component.edit(GASTO);
      component.save();

      expect(notifySuccess).toHaveBeenCalledWith('Gasto corregido.');
      expect(component.editing()).toBeNull();
      expect(component.amount()).toBeNull();
      expect((listForSession as Mock).mock.calls.length).toBeGreaterThan(antes);
    });

    it('cancelar la corrección la abandona sin tocar el gasto ni salir de la pantalla', () => {
      component.edit(GASTO);
      component.cancelEdit();

      expect(component.editing()).toBeNull();
      expect(component.amount()).toBeNull();
      expect(updateExpense).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('un rechazo del backend se avisa y no borra lo capturado', () => {
      updateExpense = vi.fn(() => throwError(() => new Error('El turno ya está cerrado.')));
      component.edit(GASTO);
      component.amount.set(150);
      component.save();

      expect(notifyError).toHaveBeenCalledWith('El turno ya está cerrado.');
      expect(component.saving()).toBe(false);
      expect(component.amount()).toBe(150);
    });

    it('no manda dos correcciones del mismo gasto', () => {
      const enVuelo = new Subject<CashMovement>();
      updateExpense = vi.fn(() => enVuelo.asObservable());
      component.edit(GASTO);

      component.save();
      component.save();

      expect(updateExpense).toHaveBeenCalledTimes(1);
      enVuelo.next(GASTO);
      enVuelo.complete();
    });
  });

  /**
   * Lo que se ve y se pulsa. El mostrador opera esta pantalla con teclado, y un
   * botón que no dice a qué se refiere —o que se deja pulsar con el formulario
   * incompleto— acaba en un gasto mal capturado que descuadra el corte.
   */
  describe('DOM', () => {
    function host(): HTMLElement {
      return fixture.nativeElement as HTMLElement;
    }

    function guardar(): HTMLButtonElement {
      return host().querySelector<HTMLButtonElement>('[data-testid="expense-save"] button')!;
    }

    it('cada campo tiene su etiqueta asociada por `for`/`id`', () => {
      for (const id of ['expense-amount', 'expense-reason']) {
        expect(host().querySelector(`label[for="${id}"]`)).not.toBeNull();
        expect(host().querySelector(`#${id}`)).not.toBeNull();
      }
      // El `p-select` no admite `label for`, así que se nombra por `aria-labelledby`.
      expect(host().querySelector('#expense-category-label')).not.toBeNull();
      expect(host().querySelector('[aria-labelledby="expense-category-label"]')).not.toBeNull();
    });

    it('el importe arranca vacío: la pantalla no propone una cifra', () => {
      const monto = host().querySelector<HTMLInputElement>('#expense-amount');
      expect(monto).not.toBeNull();
      expect(monto!.value).toBe('');
    });

    it('los campos de texto tienen tope de longitud, para que el motivo no sea una novela', () => {
      expect(host().querySelector('#expense-reason')?.getAttribute('maxlength')).toBe('200');
    });

    it('el botón de guardar nace deshabilitado, con el formulario vacío', () => {
      expect(guardar().disabled).toBe(true);
    });

    it('se habilita solo cuando el gasto está completo', async () => {
      component.amount.set(100);
      component.category.set('food');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(guardar().disabled).toBe(false);
    });

    it('con una categoría que exige descripción vuelve a deshabilitarse y aparece el campo', async () => {
      component.amount.set(100);
      component.category.set('supplies');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(host().querySelector('#expense-description')).not.toBeNull();
      expect(guardar().disabled).toBe(true);

      component.description.set('Cajas de guantes');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(guardar().disabled).toBe(false);
    });

    it('los motivos del bloqueo se leen traducidos en pantalla', () => {
      const avisos = host().querySelector('[data-testid="expense-blockers"]');

      expect(avisos).not.toBeNull();
      expect(avisos!.textContent).toContain('Captura cuánto se gastó.');
      expect(avisos!.textContent).toContain('Elige la categoría del gasto.');
      // Nunca la llave cruda: eso es lo que veía el cajero si el rótulo no se
      // traducía en la plantilla.
      expect(avisos!.textContent).not.toContain('expenses.');
    });

    it('un doble clic sobre guardar registra el gasto una sola vez', async () => {
      const enVuelo = new Subject<CashMovement>();
      create = vi.fn(() => enVuelo.asObservable());
      component.amount.set(100);
      component.category.set('food');
      fixture.detectChanges();
      await fixture.whenStable();

      guardar().click();
      guardar().click();

      expect(create).toHaveBeenCalledTimes(1);
      enVuelo.next({ id: 'm1' } as CashMovement);
      enVuelo.complete();
    });

    it('el clic en guardar registra el gasto de verdad (no es un botón muerto)', async () => {
      component.amount.set(250);
      component.category.set('rent');
      fixture.detectChanges();
      await fixture.whenStable();

      guardar().click();

      expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ amount: 250 }));
    });

    it('sin turno abierto la lista lo dice en vez de fingir que no hay gastos', async () => {
      await build(null);

      expect(host().textContent).toContain('Abre tu turno para ver y registrar gastos.');
      expect(guardar().disabled).toBe(true);
    });

    it('con turno y sin gastos muestra su propio vacío', () => {
      expect(host().textContent).toContain('Sin gastos registrados en este turno.');
    });

    describe('con un gasto en la lista', () => {
      const GASTO = {
        id: 'm1',
        cashSessionId: 's1',
        type: 'expense',
        amount: 120,
        reason: 'Insumos: guantes',
        category: 'supplies',
        description: 'Cajas de guantes',
        createdBy: 'u1',
        createdAt: new Date('2026-09-05T15:00:00.000Z'),
      } as CashMovement;

      beforeEach(async () => {
        listForSession = vi.fn(() => of([GASTO]));
        await build();
      });

      it('pinta la categoría traducida y el importe', () => {
        const lista = host().querySelector('ul.divide-y');
        expect(lista!.textContent).toContain('Insumos');
        expect(lista!.textContent).toContain('120.00');
      });

      it('el botón de corregir tiene aria-label con el importe: es un icono suelto', () => {
        const corregir = host().querySelector('[data-testid="expense-edit"] button');
        expect(corregir?.getAttribute('aria-label')).toBe('Corregir el gasto de $120.00');
      });

      it('pulsarlo carga el gasto en el formulario y avisa que se está corrigiendo', async () => {
        host().querySelector<HTMLButtonElement>('[data-testid="expense-edit"] button')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(component.editing()?.id).toBe('m1');
        expect(host().querySelector('[data-testid="editing-banner"]')).not.toBeNull();
        expect(host().querySelector('[data-testid="expense-save"]')?.textContent).toContain(
          'Guardar corrección',
        );
      });
    });
  });
});
