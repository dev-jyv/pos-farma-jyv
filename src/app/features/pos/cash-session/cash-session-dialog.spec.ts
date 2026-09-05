import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CashSession, CashSessionSummary } from '../../../shared/models';
import { CashSessionService } from '../services/cash-session.service';
import { TicketPrintService } from '../ticket/ticket-print.service';
import { CashSessionDialog } from './cash-session-dialog';

const session = {
  id: 's1',
  openedBy: 'u1',
  openingAmount: 500,
  expectedCashAmount: null,
  countedCashAmount: null,
  cashDifference: null,
  summary: null,
  openedAt: new Date('2026-08-08T14:00:00'),
  closedAt: null,
} as CashSession;

/**
 * Traducciones reales de lo que rotula el corte. Con el loader vacío de
 * pruebas, el pipe devolvería la llave y ninguna aserción sobre el texto que ve
 * el cajero tendría valor.
 */
const ES = {
  common: { cancel: 'Cancelar' },
  cashCut: {
    openTitle: 'Abrir turno de caja',
    closeTitle: 'Cerrar turno de caja',
    openingAmount: 'Monto inicial en caja',
    countedCash: 'Efectivo contado',
    difference: 'Diferencia',
    open: 'Abrir turno',
    close: 'Cerrar turno',
    recount: 'Volver a contar',
    confirmAdjustmentClose: 'Cerrar de todos modos',
    print: 'Imprimir corte',
    done: 'Listo',
    openLater: 'Ahora no',
    adjustmentTitle: 'Diferencia detectada',
    adjustmentBody: 'Hay una diferencia de ${{amount}}.',
    expectedCash: 'Efectivo esperado',
    expectedCashTotal: 'Total esperado en cajón',
    loading: 'Cargando resumen…',
  },
};

function summary(overrides: Partial<CashSessionSummary> = {}): CashSessionSummary {
  return {
    salesCount: 3,
    voidedCount: 0,
    byMethod: {
      cash: { count: 2, total: 700 },
      card: { count: 1, total: 300 },
      transfer: { count: 0, total: 0 },
      mixed: { count: 0, total: 0 },
    },
    movements: {
      deposits: { count: 0, total: 0 },
      withdrawals: { count: 0, total: 0 },
      expenses: { count: 0, total: 0 },
    },
    grandTotal: 1000,
    cashInDrawer: 1200,
    ...overrides,
  };
}

describe('CashSessionDialog (local-first)', () => {
  let fixture: ComponentFixture<CashSessionDialog>;
  let component: CashSessionDialog;
  let openLocal: (userId: string, label: string | undefined, amount: number) => Observable<CashSession>;
  let closeLocal: (id: string, counted: number, closedBy: string, closedByLabel?: string) => Observable<CashSession>;
  let liveSummary: () => Observable<{
    summary: CashSessionSummary;
    expectedCashAmount: number;
    expectedServicesCashAmount: number;
  }>;
  let cashOnHand: () => Observable<number>;
  let printCashCut: ReturnType<typeof vi.fn>;
  let notifyError: ReturnType<typeof vi.fn>;

  const authStub = {
    user: () => ({ uid: 'u1' }),
    profile: () => ({ email: 'cajero@test.com' }),
  };

  async function build(currentSession: CashSession | null): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
        { provide: AuthService, useValue: authStub },
        {
          provide: CashSessionService,
          // Envueltos en cierres: cada prueba puede reemplazar el doble antes de
          // llamar al componente sin volver a construir el TestBed.
          useValue: {
            openLocal: (userId: string, label: string | undefined, amount: number) => openLocal(userId, label, amount),
            closeLocal: (id: string, counted: number, closedBy: string, closedByLabel?: string) =>
              closeLocal(id, counted, closedBy, closedByLabel),
            liveSummary: () => liveSummary(),
            cashOnHand: () => cashOnHand(),
          },
        },
        { provide: TicketPrintService, useValue: { printCashCut } },
      ],
    });

    TestBed.inject(TranslateService).setTranslation('es', ES, true);

    fixture = TestBed.createComponent(CashSessionDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('session', currentSession);
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** El diálogo se monta en su propio DOM (`appendTo` por defecto). */
  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function boton(testid: string): HTMLButtonElement | null {
    return host().querySelector<HTMLButtonElement>(`[data-testid="${testid}"] button`);
  }

  beforeEach(() => {
    notifyError = vi.fn();
    printCashCut = vi.fn();
    openLocal = vi.fn(() => of(session));
    closeLocal = vi.fn(() =>
      of({
        ...session,
        countedCashAmount: 1200,
        expectedCashAmount: 1200,
        cashDifference: 0,
        summary: summary(),
        hasPendingAdjustment: false,
        closedAt: new Date(),
      }),
    );
    liveSummary = () => of({ summary: summary(), expectedCashAmount: 1200, expectedServicesCashAmount: 0 });
    cashOnHand = () => of(0);
  });

  describe('apertura', () => {
    beforeEach(() => build(null));

    it('sin turno el diálogo abre en modo apertura', () => {
      expect(component.mode()).toBe('open');
      expect(component.openingAmount()).toBe(0);
    });

    /**
     * El modo apertura se cierra al paso a propósito: sin turno el cajero no
     * puede vender. El admin sí entra sin abrir caja, y para él la misma
     * pantalla sería una puerta tapiada.
     */
    describe('salir sin abrir turno', () => {
      it('por defecto no se puede', () => {
        expect(component.canDismiss()).toBe(false);
      });

      it('con `dismissible` sí, y no abre ningún turno al salir', async () => {
        fixture.componentRef.setInput('dismissible', true);
        await fixture.whenStable();
        const closed = vi.fn();
        component.closed.subscribe(closed);

        expect(component.canDismiss()).toBe(true);
        component.cancel();

        expect(closed).toHaveBeenCalled();
        expect(openLocal).not.toHaveBeenCalled();
      });

      it('el corte y el resultado siempre se pueden cerrar, con o sin la bandera', async () => {
        await build(session);
        expect(component.mode()).toBe('close');
        expect(component.canDismiss()).toBe(true);
      });
    });

    /**
     * El dinero no desaparece al cerrar el turno: sigue en el cajón. Teclearlo
     * a mano cada mañana es la vía rápida a un fondo mal capturado y un arqueo
     * que no cuadra.
     */
    describe('fondo precargado con el efectivo que quedó en caja', () => {
      it('precarga el monto heredado del cierre anterior', async () => {
        cashOnHand = () => of(780);
        await build(null);

        expect(component.cashOnHand()).toBe(780);
        expect(component.openingAmount()).toBe(780);
      });

      it('el cajero puede corregirlo: es una precarga, no un candado', async () => {
        cashOnHand = () => of(780);
        await build(null);

        component.openingAmount.set(800);
        expect(component.openingAmount()).toBe(800);

        component.confirmOpen();
        expect(openLocal).toHaveBeenCalledWith('u1', 'cajero@test.com', 800);
      });

      it('sin cierres previos abre en $0.00, sin inventar un fondo', async () => {
        cashOnHand = () => of(0);
        await build(null);

        expect(component.openingAmount()).toBe(0);
      });

      it('si la consulta falla, deja capturar el fondo a mano en vez de bloquear', async () => {
        cashOnHand = () => throwError(() => new Error('SQLite ocupada'));
        await build(null);

        expect(component.cashOnHandLoading()).toBe(false);
        // El fallo se absorbe: sin manejador de error escapaba del `subscribe`
        // como excepción no controlada, aunque la prueba pasara igual.
        expect(component.cashOnHand()).toBe(0);
        component.openingAmount.set(500);
        component.confirmOpen();
        expect(openLocal).toHaveBeenCalledWith('u1', 'cajero@test.com', 500);
      });

      it('el modo cierre no consulta el efectivo heredado: ese turno ya tiene fondo', async () => {
        const consultado = vi.fn(() => of(780));
        cashOnHand = consultado;
        await build(session);

        expect(consultado).not.toHaveBeenCalled();
      });
    });

    it('abre el turno local con el fondo capturado, con el cajero de la sesión', () => {
      component.openingAmount.set(500);
      component.confirmOpen();

      expect(openLocal).toHaveBeenCalledWith('u1', 'cajero@test.com', 500);
      expect(component.submitting()).toBe(false);
    });

    it('un fallo al abrir se avisa y deja reintentar', () => {
      openLocal = vi.fn(() => throwError(() => new Error('500')));
      component.confirmOpen();

      expect(notifyError).toHaveBeenCalled();
      expect(component.submitting()).toBe(false);
    });
  });

  describe('cierre', () => {
    beforeEach(() => build(session));

    it('precarga el efectivo esperado, calculado en vivo y sin red', () => {
      expect(component.mode()).toBe('close');
      expect(component.expectedCash()).toBe(1200);
      expect(component.countedCashAmount()).toBe(1200);
    });

    /**
     * El botón cierra al primer clic. Se probó con un paso previo de
     * confirmación y en caja estorbaba: cerrar con el monto precargado —o en
     * $0.00— son cierres válidos, y la diferencia ya es el control real.
     */
    describe('el botón cierra al primer clic', () => {
      it('sin tocar el monto precargado, cierra directo', () => {
        component.requestClose();

        expect(closeLocal).toHaveBeenCalledWith('s1', 1200, 'u1', 'cajero@test.com');
        expect(component.mode()).toBe('result');
      });

      it('cerrar en $0.00 es válido: solo pide confirmar la diferencia', () => {
        component.setCountedCash(0);
        component.requestClose();

        expect(component.difference()).toBe(-1200);
        expect(component.confirmingDifference()).toBe(true);

        component.confirmClose();
        expect(closeLocal).toHaveBeenCalledWith('s1', 0, 'u1', 'cajero@test.com');
      });

      it('un turno sin ventas ni fondo cierra en $0.00 sin ningún paso extra', async () => {
        liveSummary = () => of({ summary: summary({ cashInDrawer: 0 }), expectedCashAmount: 0, expectedServicesCashAmount: 0 });
        await build(session);

        component.requestClose();

        expect(component.confirmingDifference()).toBe(false);
        expect(closeLocal).toHaveBeenCalledWith('s1', 0, 'u1', 'cajero@test.com');
      });
    });

    /**
     * El modo se fija al abrir el diálogo. `CashSessionService.current` pasa a
     * `null` en cuanto el cierre se escribe en local: si el modo se derivara de
     * ahí, el diálogo saltaba a "Abrir turno" al terminar el corte.
     */
    describe('el diálogo no salta a "abrir turno" al cerrar', () => {
      it('sigue en modo cierre aunque el turno actual ya sea null', async () => {
        fixture.componentRef.setInput('session', null);
        await fixture.whenStable();

        expect(component.mode()).toBe('close');
      });

      it('tras cerrar queda en el resultado, no en apertura', () => {
        component.setCountedCash(1200);
        component.requestClose();

        expect(component.mode()).toBe('result');
      });

      it('el fondo inicial del corte sale del turno con el que se abrió el diálogo', async () => {
        fixture.componentRef.setInput('session', null);
        await fixture.whenStable();

        expect(component.sessionAtOpen()?.openingAmount).toBe(500);
      });
    });

    it('con el conteo confirmado y sin diferencia cierra directo, sin pasar por confirmación', () => {
      component.setCountedCash(1200);
      component.requestClose();

      expect(component.confirmingDifference()).toBe(false);
      expect(closeLocal).toHaveBeenCalledWith('s1', 1200, 'u1', 'cajero@test.com');
      expect(component.mode()).toBe('result');
    });

    it('con faltante muestra el paso de confirmación in-dialog, sin cerrar todavía', () => {
      component.setCountedCash(1100);
      expect(component.difference()).toBe(-100);

      component.requestClose();

      expect(component.confirmingDifference()).toBe(true);
      expect(closeLocal).not.toHaveBeenCalled();
    });

    it('al confirmar la diferencia, el turno se cierra igual (nunca bloquea)', () => {
      component.setCountedCash(1100);
      component.requestClose();
      component.confirmClose();

      expect(closeLocal).toHaveBeenCalledWith('s1', 1100, 'u1', 'cajero@test.com');
      expect(component.confirmingDifference()).toBe(false);
    });

    it('"volver a contar" regresa al conteo sin cerrar', () => {
      component.setCountedCash(1100);
      component.requestClose();
      component.cancelDifferenceConfirm();

      expect(component.confirmingDifference()).toBe(false);
      expect(closeLocal).not.toHaveBeenCalled();
    });

    it('un fallo al cerrar avisa y no deja el turno como cerrado', () => {
      closeLocal = vi.fn(() => throwError(() => new Error('500')));
      component.setCountedCash(1200);

      component.requestClose();

      expect(notifyError).toHaveBeenCalled();
      expect(component.mode()).toBe('close');
    });

    it('un fallo al cargar el resumen en vivo avisa en vez de mostrar un esperado en ceros', async () => {
      liveSummary = () => throwError(() => new Error('500'));
      await build(session);

      expect(notifyError).toHaveBeenCalled();
      expect(component.summaryLoading()).toBe(false);
    });
  });

  describe('resultado del corte', () => {
    beforeEach(async () => {
      await build(session);
      component.setCountedCash(1200);
      component.requestClose();
    });

    it('imprime el corte con lo contado y lo esperado', () => {
      component.printCut();

      expect(printCashCut).toHaveBeenCalledWith(
        expect.objectContaining({ expectedCashAmount: 1200, countedCashAmount: 1200, cashDifference: 0 }),
      );
    });

    it('terminar cierra el diálogo y limpia el resultado', () => {
      const closed = vi.fn();
      component.closed.subscribe(closed);

      component.finish();

      expect(component.closeResult()).toBeNull();
      expect(closed).toHaveBeenCalled();
    });

    it('cancelar en modo resultado equivale a terminar', () => {
      const closed = vi.fn();
      component.closed.subscribe(closed);

      component.cancel();

      expect(component.closeResult()).toBeNull();
      expect(closed).toHaveBeenCalled();
    });
  });

  describe('ajuste pendiente', () => {
    it('un cierre con diferencia que queda pendiente lo muestra en el resultado', async () => {
      closeLocal = vi.fn(() =>
        of({
          ...session,
          countedCashAmount: 1100,
          expectedCashAmount: 1200,
          cashDifference: -100,
          summary: summary(),
          hasPendingAdjustment: true,
          closedAt: new Date(),
        }),
      );
      await build(session);
      component.setCountedCash(1100);
      component.requestClose();
      component.confirmClose();

      expect(component.closeResult()?.session.hasPendingAdjustment).toBe(true);
    });
  });

  /**
   * Servicios: bloque aparte en el corte, pero **un solo conteo** — es el mismo
   * cajón físico, así que la diferencia se mide contra la suma de los dos
   * esperados.
   */
  describe('bloque de servicios en el corte', () => {
    const servicios = {
      count: 2,
      voidedCount: 0,
      byMethod: {
        cash: { count: 1, total: 200 },
        card: { count: 1, total: 300 },
        transfer: { count: 0, total: 0 },
        mixed: { count: 0, total: 0 },
      },
      total: 500,
      commissionTotal: 120,
      cashInDrawer: 200,
    };

    async function conServicios(): Promise<void> {
      liveSummary = () =>
        of({
          summary: summary({ services: servicios }),
          expectedCashAmount: 1200,
          expectedServicesCashAmount: 200,
        });
      await build(session);
    }

    it('muestra los dos esperados y su suma', async () => {
      await conServicios();

      expect(component.expectedCash()).toBe(1200);
      expect(component.expectedServicesCash()).toBe(200);
      expect(component.expectedTotalCash()).toBe(1400);
    });

    it('precarga el conteo con el total del cajón, no solo con farmacia', async () => {
      await conServicios();

      expect(component.countedCashAmount()).toBe(1400);
      expect(component.difference()).toBe(0);
    });

    it('la diferencia se mide contra la suma: contar solo farmacia acusa el faltante', async () => {
      await conServicios();

      component.setCountedCash(1200);

      expect(component.difference()).toBe(-200);
    });

    it('cierra con la diferencia calculada sobre el total', async () => {
      await conServicios();
      component.setCountedCash(1400);
      component.requestClose();

      expect(closeLocal).toHaveBeenCalledWith('s1', 1400, 'u1', 'cajero@test.com');
      expect(component.mode()).toBe('result');
    });

    it('un turno sin servicios no arrastra el bloque ni el esperado', async () => {
      // Se reconstruye explícitamente con el doble por defecto: si se apoyara
      // en el estado del `beforeEach`, la prueba dependería del orden.
      liveSummary = () =>
        of({ summary: summary(), expectedCashAmount: 1200, expectedServicesCashAmount: 0 });
      await build(session);

      expect(component.summary()?.services).toBeUndefined();
      expect(component.expectedServicesCash()).toBe(0);
      expect(component.expectedTotalCash()).toBe(1200);
    });

    /**
     * Todo turno cerrado antes de esta funcionalidad tiene su resumen
     * congelado sin el bloque: leerlo no puede reventar.
     */
    it('un resumen viejo sin el bloque se pinta igual', async () => {
      liveSummary = () =>
        of({ summary: summary(), expectedCashAmount: 800, expectedServicesCashAmount: 0 });
      await build(session);

      expect(component.expectedTotalCash()).toBe(800);
      expect(component.countedCashAmount()).toBe(800);
    });
  });

  /**
   * Ni el fondo inicial ni el conteo pueden ser negativos: un cajón no tiene
   * menos de $0.00. El `p-inputnumber` deja teclear el signo, y un conteo en
   * −$1,200 fabricaba una diferencia de −$2,400 y la mandaba al ajuste
   * pendiente como si faltara ese dinero.
   */
  describe('montos negativos', () => {
    it('el conteo negativo se recorta a cero', async () => {
      await build(session);

      component.setCountedCash(-500);

      expect(component.countedCashAmount()).toBe(0);
      expect(component.difference()).toBe(-1200);
    });

    it('el fondo inicial negativo se recorta a cero', async () => {
      await build(null);

      component.setOpeningAmount(-300);
      component.confirmOpen();

      expect(openLocal).toHaveBeenCalledWith('u1', 'cajero@test.com', 0);
    });

    it('los campos declaran el mínimo en el DOM, para que ni se teclee', async () => {
      await build(null);
      expect(host().querySelector('#openingAmount')?.getAttribute('aria-valuemin')).toBe('0');

      await build(session);
      expect(host().querySelector('#countedCash')?.getAttribute('aria-valuemin')).toBe('0');
    });
  });

  /**
   * Lo que se pulsa y se ve. El corte es la pantalla con la que el cajero
   * termina su jornada: un botón que no responde al primer clic, o que dispara
   * dos cierres, se paga en dinero real.
   */
  describe('DOM', () => {
    describe('apertura', () => {
      beforeEach(() => build(null));

      it('el campo del fondo tiene etiqueta asociada', () => {
        expect(host().querySelector('label[for="openingAmount"]')?.textContent).toContain(
          'Monto inicial en caja',
        );
        expect(host().querySelector('#openingAmount')).not.toBeNull();
      });

      it('sin permiso de salirse no ofrece el botón de "ahora no"', () => {
        expect(boton('cut-open-later')).toBeNull();
        expect(boton('cut-open')).not.toBeNull();
      });

      it('al admin sí se le ofrece salir sin abrir turno', async () => {
        fixture.componentRef.setInput('dismissible', true);
        await fixture.whenStable();
        fixture.detectChanges();

        expect(boton('cut-open-later')).not.toBeNull();
      });

      it('el clic en "abrir turno" abre el turno de verdad', () => {
        component.setOpeningAmount(500);
        fixture.detectChanges();

        boton('cut-open')!.click();

        expect(openLocal).toHaveBeenCalledWith('u1', 'cajero@test.com', 500);
      });

      it('un doble clic no abre dos turnos', () => {
        const enVuelo = new Subject<CashSession>();
        openLocal = vi.fn(() => enVuelo.asObservable());

        boton('cut-open')!.click();
        boton('cut-open')!.click();

        expect(openLocal).toHaveBeenCalledTimes(1);
        enVuelo.next(session);
        enVuelo.complete();
      });

      it('mientras se abre, el botón queda deshabilitado en el DOM', async () => {
        const enVuelo = new Subject<CashSession>();
        openLocal = vi.fn(() => enVuelo.asObservable());

        boton('cut-open')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(boton('cut-open')!.disabled).toBe(true);
        enVuelo.next(session);
        enVuelo.complete();
      });
    });

    describe('cierre', () => {
      beforeEach(() => build(session));

      it('el campo del conteo tiene etiqueta y llega precargado con lo esperado', () => {
        expect(host().querySelector('label[for="countedCash"]')?.textContent).toContain(
          'Efectivo contado',
        );
        expect(host().querySelector<HTMLInputElement>('#countedCash')!.value).toContain('1,200');
      });

      it('la diferencia se pinta, y en cero no propone confirmación', () => {
        expect(host().textContent).toContain('Diferencia');
        expect(boton('cut-close')).not.toBeNull();
        expect(boton('cut-confirm-adjustment')).toBeNull();
      });

      it('el clic en "cerrar turno" cierra el turno', () => {
        boton('cut-close')!.click();

        expect(closeLocal).toHaveBeenCalledWith('s1', 1200, 'u1', 'cajero@test.com');
      });

      /**
       * El doble clic llega en el mismo tick, antes de que el `[loading]` del
       * botón lo deshabilite: sin candado en `requestClose()` se escribían dos
       * cierres del mismo turno, y por tanto dos cortes.
       */
      it('un doble clic no cierra dos veces', () => {
        const enVuelo = new Subject<CashSession>();
        closeLocal = vi.fn(() => enVuelo.asObservable());

        boton('cut-close')!.click();
        boton('cut-close')!.click();

        expect(closeLocal).toHaveBeenCalledTimes(1);
        enVuelo.complete();
      });

      it('tampoco desde el paso de confirmación de la diferencia', async () => {
        const enVuelo = new Subject<CashSession>();
        closeLocal = vi.fn(() => enVuelo.asObservable());
        component.setCountedCash(1100);
        fixture.detectChanges();
        boton('cut-close')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        boton('cut-confirm-adjustment')!.click();
        boton('cut-confirm-adjustment')!.click();

        expect(closeLocal).toHaveBeenCalledTimes(1);
        enVuelo.complete();
      });

      it('con diferencia, el paso de confirmación reemplaza los botones y explica el ajuste', async () => {
        component.setCountedCash(1100);
        fixture.detectChanges();

        boton('cut-close')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(closeLocal).not.toHaveBeenCalled();
        expect(host().textContent).toContain('Diferencia detectada');
        expect(boton('cut-confirm-adjustment')).not.toBeNull();
        expect(boton('cut-recount')).not.toBeNull();
        // El campo del conteo se retira: en ese paso ya no se recuenta.
        expect(host().querySelector('#countedCash')).toBeNull();
      });

      it('"cerrar de todos modos" cierra igual: el cierre nunca se bloquea', async () => {
        component.setCountedCash(1100);
        fixture.detectChanges();
        boton('cut-close')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        boton('cut-confirm-adjustment')!.click();

        expect(closeLocal).toHaveBeenCalledWith('s1', 1100, 'u1', 'cajero@test.com');
      });

      it('"volver a contar" devuelve el campo del conteo sin cerrar', async () => {
        component.setCountedCash(1100);
        fixture.detectChanges();
        boton('cut-close')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        boton('cut-recount')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(closeLocal).not.toHaveBeenCalled();
        expect(host().querySelector('#countedCash')).not.toBeNull();
      });

      it('mientras se carga el resumen no muestra un esperado en ceros', async () => {
        const enVuelo = new Subject<{
          summary: CashSessionSummary;
          expectedCashAmount: number;
          expectedServicesCashAmount: number;
        }>();
        liveSummary = () => enVuelo.asObservable();
        await build(session);

        expect(host().textContent).toContain('Cargando resumen…');
        expect(host().querySelector('#countedCash')).toBeNull();

        enVuelo.next({ summary: summary(), expectedCashAmount: 1200, expectedServicesCashAmount: 0 });
        enVuelo.complete();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(host().textContent).not.toContain('Cargando resumen…');
      });

      it('un fallo del resumen apaga el "cargando" en vez de dejarlo encendido', async () => {
        liveSummary = () => throwError(() => new Error('500'));
        await build(session);

        expect(host().textContent).not.toContain('Cargando resumen…');
        expect(notifyError).toHaveBeenCalled();
      });
    });

    describe('resultado', () => {
      beforeEach(async () => {
        await build(session);
        boton('cut-close')!.click();
        fixture.detectChanges();
        await fixture.whenStable();
      });

      it('ofrece imprimir y terminar, y ya no el cierre', () => {
        expect(boton('cut-print')).not.toBeNull();
        expect(boton('cut-done')).not.toBeNull();
        expect(boton('cut-close')).toBeNull();
      });

      it('imprimir manda el corte a la impresora', () => {
        boton('cut-print')!.click();

        expect(printCashCut).toHaveBeenCalled();
      });

      it('terminar avisa que el turno quedó cerrado', () => {
        const cerrado = vi.fn();
        component.shiftClosed.subscribe(cerrado);

        boton('cut-done')!.click();

        expect(cerrado).toHaveBeenCalled();
      });
    });
  });
});
