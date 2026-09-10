import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, Subject, of, throwError } from 'rxjs';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../core/auth/auth.service';
import { CashOnHand } from '../../../core/electron/window.d';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashMovement, CashSession } from '../../../shared/models';
import { CashMovementService } from '../services/cash-movement.service';
import { CashSessionService } from '../services/cash-session.service';
import { CashBoxScreen } from './cash-box';

const TURNO = { id: 's1', openedBy: 'u1', closedAt: null } as CashSession;

/** Las mismas cadenas que `public/i18n/es.json` para esta pantalla. */
const ES = {
  cashBox: {
    balance: 'Saldo en caja',
    type: 'Tipo de movimiento',
    amount: 'Monto',
    reason: 'Motivo',
    save: 'Registrar movimiento',
    cancel: 'Cancelar',
    retry: 'Reintentar',
    history: 'Últimos movimientos',
    empty: 'Sin movimientos registrados en este equipo.',
    optionWithdrawal: 'Salida de efectivo',
    optionDeposit: 'Entrada de efectivo',
    noAmount: 'Captura el monto.',
    noReason: 'Escribe el motivo: un movimiento de efectivo sin causa no se puede auditar.',
    noUser: 'Vuelve a iniciar sesión para registrar el movimiento.',
    savedToShift: 'Movimiento registrado y aplicado al turno abierto.',
    savedToBox: 'Movimiento registrado en la caja de la farmacia.',
    saveError: 'No se pudo registrar el movimiento.',
    loadError: 'No se pudo leer el saldo de la caja.',
    appliesToShift: 'Hay un turno abierto: el movimiento se aplicará a ese turno.',
    noShift: 'Sin turno abierto: el movimiento queda en la caja de la farmacia.',
  },
};

function movement(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    id: 'm1',
    cashSessionId: null,
    type: 'withdrawal',
    amount: 200,
    reason: 'Depósito bancario',
    createdBy: 'u1',
    createdByLabel: 'admin@farmajyv.mx',
    createdAt: new Date('2026-09-04T10:00:00'),
  } as CashMovement;
}

describe('CashBoxScreen', () => {
  let fixture: ComponentFixture<CashBoxScreen>;
  let component: CashBoxScreen;
  let createCalls: { cashSessionId: string | null; input: Record<string, unknown> }[];
  let create: () => Observable<CashMovement>;
  let balance: () => Observable<CashOnHand>;
  let listPageLocal: (page: number) => Observable<{ items: CashMovement[]; total: number }>;
  let listPageCalls: Array<{ page: number; pageSize: number }>;
  let notifyError: Mock;
  let notifySuccess: Mock;

  async function build(session: CashSession | null = TURNO): Promise<void> {
    // La caja de la farmacia es solo de admin: pregunta por el turno abierto del
    // equipo (de quien sea), no por el del usuario en pantalla.
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      cashSessions: { getOpenLocalAnyUser: () => Promise.resolve(session) },
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: notifySuccess } },
        { provide: Router, useValue: { navigate: vi.fn().mockResolvedValue(true) } },
        {
          provide: AuthService,
          useValue: { user: () => ({ uid: 'u1' }), profile: () => ({ email: 'admin@farmajyv.mx' }) },
        },
        {
          provide: CashSessionService,
          useValue: {
            current: () => session,
            isOpen: () => session !== null,
            refreshCurrent: () => of(session),
            cashOnHandDetail: () => balance(),
          },
        },
        {
          provide: CashMovementService,
          // Cierres: cada prueba reemplaza el doble sin reconstruir el TestBed.
          useValue: {
            create: (cashSessionId: string | null, input: Record<string, unknown>) => {
              createCalls.push({ cashSessionId, input });
              return create();
            },
            listPageLocal: (page: number, pageSize: number) => {
              listPageCalls.push({ page, pageSize });
              return listPageLocal(page);
            },
          },
        },
      ],
    });

    TestBed.inject(TranslateService).setTranslation('es', ES, true);

    fixture = TestBed.createComponent(CashBoxScreen);
    component = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function guardar(): HTMLButtonElement {
    return host().querySelector<HTMLButtonElement>('[data-testid="cash-box-save"] button')!;
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    notifySuccess = vi.fn();
    createCalls = [];
    create = () => of(movement());
    balance = () =>
      of({
        amount: 500,
        lastClosedAt: new Date('2026-09-04T09:00:00'),
        countedAtLastClose: 700,
        movementsSinceClose: -200,
      });
    listPageCalls = [];
    listPageLocal = () => of({ items: [movement()], total: 1 });
    await build();
  });

  describe('paginación del historial', () => {
    /**
     * El historial de caja crece toda la vida del equipo: se pagina contra
     * SQLite, no recortando en pantalla un lote que igual se trajo entero.
     */
    it('pide la primera página de 50 al cargar', () => {
      expect(listPageCalls).toEqual([{ page: 0, pageSize: 50 }]);
      expect(component.total()).toBe(1);
    });

    it('cambiar de página consulta la siguiente, no filtra en memoria', async () => {
      listPageCalls = [];
      listPageLocal = () => of({ items: [movement()], total: 120 });

      component.onPageChange({ first: 50 });
      await fixture.whenStable();

      expect(listPageCalls).toEqual([{ page: 1, pageSize: 50 }]);
      expect(component.first()).toBe(50);
    });

    it('registrar un movimiento devuelve a la primera página', async () => {
      component.onPageChange({ first: 100 });
      await fixture.whenStable();
      listPageCalls = [];

      component.amount.set(50);
      component.reason.set('Pago a proveedor');
      component.save();
      await fixture.whenStable();

      expect(component.first()).toBe(0);
      expect(listPageCalls).toEqual([{ page: 0, pageSize: 50 }]);
    });

    /**
     * Sin esto, quedarse en una página que ya no existe (el total encogió)
     * dejaba la tabla vacía sin decir por qué.
     */
    it('reencuadra cuando la página visible quedó fuera de rango', async () => {
      listPageLocal = (page: number) =>
        of({ items: page === 0 ? [movement()] : [], total: 3 });

      component.onPageChange({ first: 100 });
      await fixture.whenStable();

      expect(component.first()).toBe(0);
    });
  });

  describe('carga', () => {
    it('muestra el saldo y el historial locales', () => {
      expect(component.balance().amount).toBe(500);
      expect(component.movements()).toHaveLength(1);
      expect(component.loadError()).toBeNull();
    });

    /**
     * El saldo es el efectivo que DEBE haber —lo contado en el último corte más
     * o menos lo movido después—, no la suma de todos los movimientos: los de un
     * turno ya entraron al conteo de su corte, y volver a restarlos los contaba
     * dos veces. Con un solo gasto de $100 dentro de un corte, la pantalla
     * llegaba a mostrar −$100 con la caja llena.
     */
    it('el saldo sale del último corte, no de sumar todos los movimientos', () => {
      expect(component.balance().countedAtLastClose).toBe(700);
      expect(component.balance().movementsSinceClose).toBe(-200);
      expect(component.balance().amount).toBe(500);
    });

    /**
     * Un saldo en ceros por un fallo de lectura se lee como "no hay efectivo",
     * que es justo la conclusión contraria a la real.
     */
    it('si la lectura falla avisa en vez de mostrar un saldo en ceros creíble', async () => {
      balance = () => throwError(() => new Error('IPC caído'));
      await build();

      expect(component.loadError()).toBe('No se pudo leer el saldo de la caja.');
      expect(component.movements()).toEqual([]);
    });
  });

  /**
   * Lo que se ve y se pulsa. Esta pantalla mueve efectivo sin venta de por
   * medio: un botón que se deja pulsar sin motivo, o un saldo en ceros por un
   * fallo de lectura, terminan en un arqueo que nadie puede explicar.
   */
  describe('DOM', () => {
    it('cada campo tiene su nombre accesible', () => {
      expect(host().querySelector('label[for="cash-box-amount"]')).not.toBeNull();
      expect(host().querySelector('#cash-box-amount')).not.toBeNull();
      expect(host().querySelector('label[for="cash-box-reason"]')).not.toBeNull();
      expect(host().querySelector('#cash-box-reason')).not.toBeNull();
      expect(host().querySelector('#cash-box-type-label')).not.toBeNull();
      expect(host().querySelector('[aria-labelledby="cash-box-type-label"]')).not.toBeNull();
    });

    it('el motivo tiene tope de longitud y el monto no admite negativos', () => {
      expect(host().querySelector('#cash-box-reason')?.getAttribute('maxlength')).toBe('200');
      expect(host().querySelector('#cash-box-amount')?.getAttribute('aria-valuemin')).toBe('0');
    });

    it('pinta el saldo que debe haber en el cajón', () => {
      expect(host().textContent).toContain('500.00');
    });

    it('el botón de guardar nace deshabilitado y los bloqueos se leen traducidos', () => {
      expect(guardar().disabled).toBe(true);

      const avisos = host().querySelector('[data-testid="cash-box-blockers"]');
      expect(avisos!.textContent).toContain('Captura el monto.');
      expect(avisos!.textContent).toContain('un movimiento de efectivo sin causa no se puede auditar');
      expect(avisos!.textContent).not.toContain('cashBox.');
    });

    it('con monto pero sin motivo sigue deshabilitado', async () => {
      component.amount.set(200);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(guardar().disabled).toBe(true);
    });

    it('con monto y motivo se habilita, y el clic registra el movimiento', async () => {
      component.amount.set(200);
      component.reason.set('Depósito bancario');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(guardar().disabled).toBe(false);
      guardar().click();

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].input).toMatchObject({ amount: 200, reason: 'Depósito bancario' });
    });

    it('un doble clic no registra el movimiento dos veces', async () => {
      const enVuelo = new Subject<CashMovement>();
      create = () => enVuelo.asObservable();
      component.amount.set(200);
      component.reason.set('Depósito bancario');
      fixture.detectChanges();
      await fixture.whenStable();

      guardar().click();
      guardar().click();

      expect(createCalls).toHaveLength(1);
      enVuelo.complete();
    });

    it('avisa en pantalla si el movimiento va a entrar al turno abierto', () => {
      expect(host().textContent).toContain('el movimiento se aplicará a ese turno');
    });

    it('y avisa lo contrario cuando no hay turno', async () => {
      await build(null);

      expect(host().textContent).toContain('queda en la caja de la farmacia');
    });

    it('sin movimientos la tabla muestra su mensaje vacío', async () => {
      listPageLocal = () => of({ items: [], total: 0 });
      await build();

      expect(host().textContent).toContain('Sin movimientos registrados en este equipo.');
    });

    it('un fallo de lectura se pinta como alerta con su botón de reintentar', async () => {
      balance = () => throwError(() => new Error('IPC caído'));
      await build();

      const alerta = host().querySelector('[data-testid="cash-box-error"]');
      expect(alerta?.textContent).toContain('No se pudo leer el saldo de la caja.');
      expect(host().querySelector('[data-testid="cash-box-retry"]')).not.toBeNull();
    });

    it('reintentar vuelve a leer el saldo y limpia el aviso', async () => {
      balance = () => throwError(() => new Error('IPC caído'));
      await build();

      balance = () =>
        of({ amount: 900, lastClosedAt: null, countedAtLastClose: null, movementsSinceClose: 0 });
      host().querySelector<HTMLButtonElement>('[data-testid="cash-box-retry"]')!.click();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.loadError()).toBeNull();
      expect(component.balance().amount).toBe(900);
      expect(host().querySelector('[data-testid="cash-box-error"]')).toBeNull();
    });
  });

  describe('validación', () => {
    it('arranca en salida, sin monto ni motivo', () => {
      expect(component.type()).toBe('withdrawal');
      expect(component.amount()).toBeNull();
      expect(component.canSubmit()).toBe(false);
    });

    it('sin monto no registra nada', () => {
      component.reason.set('Depósito bancario');
      component.save();

      expect(createCalls).toHaveLength(0);
    });

    it('sin motivo no registra nada: un retiro sin causa no se puede auditar', () => {
      component.amount.set(200);
      component.save();

      expect(createCalls).toHaveLength(0);
    });
  });

  describe('registro', () => {
    beforeEach(() => {
      component.amount.set(200);
      component.reason.set('  Depósito bancario  ');
    });

    it('con turno abierto lo aplica a ese turno', () => {
      component.save();

      expect(createCalls[0].cashSessionId).toBe('s1');
      expect(createCalls[0].input).toMatchObject({
        type: 'withdrawal',
        amount: 200,
        reason: 'Depósito bancario',
        createdBy: 'u1',
        createdByLabel: 'admin@farmajyv.mx',
      });
      expect(notifySuccess).toHaveBeenCalled();
    });

    /**
     * Es el caso que motivó el módulo: el dueño saca efectivo con la caja
     * cerrada. Va sin turno y no entra a ningún corte.
     */
    it('sin turno abierto lo registra en la caja de la farmacia', async () => {
      await build(null);
      component.amount.set(200);
      component.reason.set('Depósito bancario');

      component.save();

      expect(createCalls[0].cashSessionId).toBeNull();
    });

    it('tras guardar limpia el formulario y recarga el saldo', () => {
      let balanceReads = 0;
      balance = () => {
        balanceReads += 1;
        return of({
          amount: 300,
          lastClosedAt: new Date('2026-09-04T09:00:00'),
          countedAtLastClose: 700,
          movementsSinceClose: -400,
        });
      };

      component.save();

      expect(component.amount()).toBeNull();
      expect(component.reason()).toBe('');
      expect(balanceReads).toBe(1);
      expect(component.balance().amount).toBe(300);
    });

    it('un fallo avisa y deja reintentar', () => {
      create = () => throwError(() => new Error('IPC caído'));

      component.save();

      expect(notifyError).toHaveBeenCalledWith('No se pudo registrar el movimiento.');
      expect(component.saving()).toBe(false);
      // El formulario conserva lo capturado: reescribirlo a mano sería el castigo
      // por un fallo que no fue del usuario.
      expect(component.amount()).toBe(200);
    });
  });
});
