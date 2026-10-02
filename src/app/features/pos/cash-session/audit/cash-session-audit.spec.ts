import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, Subject, of, throwError } from 'rxjs';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../../core/notifications/notification.service';
import { CashSession } from '../../../../shared/models';
import { CashSessionService } from '../../services/cash-session.service';
import { CashSessionAudit } from './cash-session-audit';

/** Las mismas cadenas que `public/i18n/es.json` para lo que rotula esta pantalla. */
const ES = {
  cashCut: {
    difference: 'Diferencia',
    expectedCash: 'Efectivo esperado',
    countedCash: 'Efectivo contado',
    audit: {
      title: 'Cortes de caja',
      review: 'Revisar',
      pending: 'Pendiente',
      approved: 'Aprobado',
      empty: 'Sin cortes de caja registrados.',
      loading: 'Cargando cortes…',
      status: 'Ajuste',
      filterAll: 'Todos',
      filterPending: 'Pendientes',
      reviewNote: 'Nota (opcional)',
      approve: 'Aprobar',
      reject: 'Rechazar',
      refresh: 'Refrescar',
      notSynced: 'Este corte todavía no se sincronizó con el servidor.',
    },
  },
};

function session(overrides: Partial<CashSession> = {}): CashSession {
  return {
    id: 'local-1',
    remoteId: 'remote-1',
    openedBy: 'u1',
    openingAmount: 500,
    expectedCashAmount: 700,
    countedCashAmount: 660,
    cashDifference: -40,
    summary: null,
    openedAt: new Date('2026-09-05T14:00:00.000Z'),
    closedAt: new Date('2026-09-05T22:00:00.000Z'),
    hasPendingAdjustment: true,
    adjustmentStatus: 'pending',
    ...overrides,
  };
}

describe('CashSessionAudit (solo admin)', () => {
  let fixture: ComponentFixture<CashSessionAudit>;
  let component: CashSessionAudit;
  let listAudit: Mock;
  let reviewAdjustment: Mock;
  let listLocal: Mock;
  let notifyError: Mock;
  let notifySuccess: Mock;

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: notifySuccess } },
        {
          provide: CashSessionService,
          useValue: {
            listAudit: (filters?: unknown) =>
              listAudit(filters) as Observable<{ items: CashSession[]; meta: null }>,
            reviewAdjustment: (id: string, decision: string, note?: string) =>
              reviewAdjustment(id, decision, note) as Observable<CashSession>,
            listLocal,
          },
        },
      ],
    });

    // El loader de pruebas es vacío: sin esto el pipe devuelve la llave y
    // ninguna aserción sobre el texto que lee el admin significaría nada.
    TestBed.inject(TranslateService).setTranslation('es', ES, true);

    fixture = TestBed.createComponent(CashSessionAudit);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    notifySuccess = vi.fn();
    listLocal = vi.fn();
    listAudit = vi.fn(() => of({ items: [session()], meta: { page: 1, limit: 50, total: 1, totalPages: 1 } }));
    reviewAdjustment = vi.fn(() => of(session({ adjustmentStatus: 'approved' })));
    await build();
  });

  it('arranca mostrando los ajustes pendientes, que es el trabajo del admin', () => {
    expect(listAudit).toHaveBeenCalledWith({ adjustmentStatus: 'pending', page: 1, limit: 50 });
    expect(component.sessions()).toHaveLength(1);
  });

  it('lee del backend (todas las cajas), nunca del SQLite de este equipo', () => {
    expect(listLocal).not.toHaveBeenCalled();
  });

  it('el filtro "todos" quita el estado en vez de mandar cadena vacía', () => {
    component.onStatusChange('');
    expect(listAudit).toHaveBeenLastCalledWith({ page: 1, limit: 50 });
  });

  it.each(['pending', 'approved', 'rejected'] as const)('filtra por estado "%s"', (status) => {
    component.onStatusChange(status);
    expect(listAudit).toHaveBeenLastCalledWith({ adjustmentStatus: status, page: 1, limit: 50 });
  });

  describe('datos del corte', () => {
    /**
     * El backend serializa `Timestamp` como `{_seconds}`. Sin mapeo, `| date`
     * dejaba las columnas de apertura y cierre en blanco: parecía que el turno
     * no registraba horas.
     */
    it('mapea las fechas a Date reales', () => {
      const [corte] = component.sessions();
      expect(corte.openedAt).toBeInstanceOf(Date);
    });

    it('marca como "sin revisar" un corte con diferencia y sin estado de ajuste', () => {
      expect(component.hasDifference({ cashDifference: 455 })).toBe(true);
      expect(component.hasDifference({ cashDifference: 0 })).toBe(false);
      // Debajo de un centavo no es faltante: mismo umbral que el backend.
      expect(component.hasDifference({ cashDifference: 0.004 })).toBe(false);
    });

    it('el loader inicial se apaga con la primera respuesta', () => {
      expect(component.initialLoading()).toBe(false);
      expect(component.loaded()).toBe(true);
    });
  });

  describe('paginación', () => {
    /**
     * Antes se pedían 200 cortes y la tabla los repartía en páginas: pasado ese
     * tope, los cortes viejos no existían para el admin. Ahora cada página es
     * una consulta y el `meta` dice cuántos hay de verdad.
     */
    it('el total sale del `meta`, no de los renglones recibidos', () => {
      expect(component.total()).toBe(1);
    });

    it('cambiar de página consulta la siguiente al servidor', async () => {
      listAudit = vi.fn(() =>
        of({ items: [session()], meta: { page: 2, limit: 50, total: 120, totalPages: 3 } }),
      );
      await build();

      component.onPageChange({ first: 50 });
      await fixture.whenStable();

      expect(listAudit).toHaveBeenLastCalledWith({ adjustmentStatus: 'pending', page: 2, limit: 50 });
      expect(component.first()).toBe(50);
      expect(component.total()).toBe(120);
    });

    it('cambiar de filtro vuelve a la primera página', async () => {
      component.onPageChange({ first: 100 });
      await fixture.whenStable();

      component.onStatusChange('approved');
      await fixture.whenStable();

      expect(component.first()).toBe(0);
      expect(listAudit).toHaveBeenLastCalledWith({ adjustmentStatus: 'approved', page: 1, limit: 50 });
    });
  });

  it('un fallo del listado se muestra como banda persistente, no deja la tabla mintiendo', async () => {
    listAudit = vi.fn(() => throwError(() => new Error('500')));
    await build();

    expect(component.loadError()).toBeTruthy();
    expect(component.loading()).toBe(false);
  });

  describe('revisión del ajuste', () => {
    it('aprueba mandando el remoteId, la decisión y la nota', () => {
      component.openReview(session());
      component.reviewNote.set('  Faltante autorizado  ');
      component.decide('approved');

      expect(reviewAdjustment).toHaveBeenCalledWith('remote-1', 'approved', 'Faltante autorizado');
      expect(notifySuccess).toHaveBeenCalled();
      expect(component.reviewing()).toBeNull();
    });

    it('rechaza con la misma mecánica', () => {
      component.openReview(session());
      component.decide('rejected');

      expect(reviewAdjustment).toHaveBeenCalledWith('remote-1', 'rejected', undefined);
    });

    it('una nota en blanco viaja como ausente, no como cadena vacía', () => {
      component.openReview(session());
      component.reviewNote.set('   ');
      component.decide('approved');

      expect(reviewAdjustment).toHaveBeenCalledWith('remote-1', 'approved', undefined);
    });

    it('no revisa un turno que nunca sincronizó: el backend no lo conoce', () => {
      component.openReview(session({ remoteId: null }));
      component.decide('approved');

      expect(reviewAdjustment).not.toHaveBeenCalled();
    });

    /**
     * `decide()` ya salía en silencio con un corte sin `remoteId`, pero los dos
     * botones seguían habilitados: el admin los pulsaba, no pasaba nada y no
     * había forma de saber por qué.
     */
    it('con un corte sin sincronizar los botones se deshabilitan y se explica', async () => {
      component.openReview(session({ remoteId: null }));
      fixture.detectChanges();
      await fixture.whenStable();

      const host = fixture.nativeElement as HTMLElement;
      expect(component.canDecide()).toBe(false);
      expect(host.querySelector<HTMLButtonElement>('[data-testid="review-approve"] button')!.disabled).toBe(true);
      expect(host.querySelector<HTMLButtonElement>('[data-testid="review-reject"] button')!.disabled).toBe(true);
      expect(host.querySelector('[data-testid="review-not-synced"]')).not.toBeNull();
    });

    it('con un corte sincronizado los botones sí se pueden pulsar', async () => {
      component.openReview(session());
      fixture.detectChanges();
      await fixture.whenStable();

      const host = fixture.nativeElement as HTMLElement;
      expect(component.canDecide()).toBe(true);
      expect(host.querySelector<HTMLButtonElement>('[data-testid="review-approve"] button')!.disabled).toBe(false);
      expect(host.querySelector('[data-testid="review-not-synced"]')).toBeNull();
    });

    it('no manda dos decisiones sobre el mismo ajuste (doble aprobación)', () => {
      // La respuesta queda en vuelo a propósito: el segundo clic ocurre antes
      // de que el backend conteste, que es justo cuando el doble envío duele.
      const enVuelo = new Subject<CashSession>();
      reviewAdjustment = vi.fn(() => enVuelo.asObservable());
      component.openReview(session());

      component.decide('approved');
      component.decide('approved');

      expect(reviewAdjustment).toHaveBeenCalledTimes(1);
      enVuelo.next(session({ adjustmentStatus: 'approved' }));
      enVuelo.complete();
    });

    it('un rechazo del backend (ya revisado / sin permiso) se avisa y no cierra el diálogo en falso', () => {
      reviewAdjustment = vi.fn(() => throwError(() => new Error('403')));
      component.openReview(session());
      component.decide('approved');

      expect(notifyError).toHaveBeenCalled();
      expect(component.reviewSaving()).toBe(false);
      expect(component.reviewing()).not.toBeNull();
    });

    it('al abrir la revisión limpia la nota de la revisión anterior', () => {
      component.openReview(session());
      component.reviewNote.set('nota vieja');
      component.closeReview();
      component.openReview(session({ id: 'local-2' }));

      expect(component.reviewNote()).toBe('');
    });

    it('tras decidir vuelve a consultar el listado para reflejar el nuevo estado', () => {
      const llamadasIniciales = listAudit.mock.calls.length;
      component.openReview(session());
      component.decide('approved');

      expect(listAudit.mock.calls.length).toBeGreaterThan(llamadasIniciales);
    });
  });

  /**
   * Lo que ve y pulsa el admin. Esta pantalla es la única que resuelve un
   * faltante de caja: una fila mal pintada o un botón que no reacciona cambian
   * la decisión sobre dinero de alguien.
   */
  describe('DOM', () => {
    function host(): HTMLElement {
      return fixture.nativeElement as HTMLElement;
    }

    beforeEach(() => fixture.detectChanges());

    it('pinta el corte con su diferencia y su estado', () => {
      const fila = host().querySelector('tbody tr');

      expect(fila).not.toBeNull();
      expect(fila!.textContent).toContain('-40.00');
      expect(fila!.textContent).toContain('Pendiente');
    });

    it('el corte pendiente ofrece el botón de revisar, y pulsarlo abre el diálogo', async () => {
      const revisar = [...host().querySelectorAll<HTMLButtonElement>('tbody button')].find(
        (boton) => boton.textContent?.includes('Revisar'),
      );
      expect(revisar).toBeDefined();

      revisar!.click();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(component.reviewing()).not.toBeNull();
      expect(host().querySelector('#review-note')).not.toBeNull();
    });

    it('un corte ya resuelto no ofrece revisarlo otra vez', async () => {
      listAudit = vi.fn(() =>
        of({
          items: [session({ adjustmentStatus: 'approved', hasPendingAdjustment: false })],
          meta: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      );
      await build();
      fixture.detectChanges();

      const revisar = [...host().querySelectorAll<HTMLButtonElement>('tbody button')].find(
        (boton) => boton.textContent?.includes('Revisar'),
      );
      expect(revisar).toBeUndefined();
    });

    it('la nota de la revisión tiene etiqueta y tope de longitud', async () => {
      component.openReview(session());
      fixture.detectChanges();
      await fixture.whenStable();

      expect(host().querySelector('label[for="review-note"]')).not.toBeNull();
      expect(host().querySelector('#review-note')?.getAttribute('maxlength')).toBe('300');
    });

    it('el filtro y el refrescar tienen nombre accesible', () => {
      expect(host().querySelector('#cash-audit-status-label')).not.toBeNull();
      expect(host().querySelector('[aria-labelledby="cash-audit-status-label"]')).not.toBeNull();
      expect(host().querySelector('button[aria-label]')).not.toBeNull();
    });

    it('sin cortes muestra el mensaje vacío', async () => {
      listAudit = vi.fn(() => of({ items: [], meta: { page: 1, limit: 50, total: 0, totalPages: 0 } }));
      await build();
      fixture.detectChanges();

      expect(host().textContent).toContain('Sin cortes de caja registrados.');
    });

    it('mientras carga por primera vez no dice "sin cortes"', async () => {
      const enVuelo = new Subject<{ items: CashSession[]; meta: null }>();
      listAudit = vi.fn(() => enVuelo.asObservable());
      await build();
      fixture.detectChanges();

      expect(component.initialLoading()).toBe(true);
      expect(host().textContent).not.toContain('Sin cortes de caja registrados.');

      enVuelo.next({ items: [], meta: null });
      enVuelo.complete();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.initialLoading()).toBe(false);
    });

    it('un fallo se pinta como alerta y apaga el cargando', async () => {
      listAudit = vi.fn(() => throwError(() => new Error('500')));
      await build();
      fixture.detectChanges();

      expect(host().querySelector('[role="alert"]')?.textContent).toBeTruthy();
      expect(component.initialLoading()).toBe(false);
    });
  });
});
