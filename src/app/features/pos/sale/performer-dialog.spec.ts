import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceProvider } from '../../../shared/models';
import { ServiceCatalogService } from '../services/service-catalog.service';
import { PerformerDialog } from './performer-dialog';

const DOCTORES: ServiceProvider[] = [
  { id: 'dr-1', name: 'Dra. Ruiz', license: '12345' },
  { id: 'dr-2', name: 'Dr. Zavala' },
  { id: 'dr-3', name: 'Dra. Herrera' },
];

const ES = {
  common: { cancel: 'Cancelar' },
  sale: {
    services: {
      choosePerformer: '¿Quién lo realizó?',
      noPerformers: 'No hay doctores registrados. Dalos de alta en el panel de administración.',
    },
  },
};

/**
 * Selector del doctor de un servicio. Se opera con teclado desde el mostrador
 * (1–9 elige, Enter toma el sugerido, Esc cancela) y es la única guarda de la
 * regla "un servicio que exige doctor no entra al ticket sin doctor": si aquí
 * se elige a quien no fue, la comisión se acredita mal y el corte lo arrastra.
 */
describe('PerformerDialog', () => {
  let fixture: ComponentFixture<PerformerDialog>;
  let component: PerformerDialog;
  let elegido: Mock;
  let descartado: Mock;

  async function build(
    doctores: ServiceProvider[] = DOCTORES,
    sugerido: string | null = null,
    visible = true,
  ): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        {
          provide: ServiceCatalogService,
          useValue: { providers: signal(doctores) },
        },
      ],
    });
    TestBed.inject(TranslateService).setTranslation('es', ES, true);

    fixture = TestBed.createComponent(PerformerDialog);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('visible', visible);
    fixture.componentRef.setInput('serviceName', 'Consulta general');
    fixture.componentRef.setInput('suggestedProviderId', sugerido);
    elegido = vi.fn();
    descartado = vi.fn();
    component.chosen.subscribe(elegido);
    component.dismissed.subscribe(descartado);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function opciones(): HTMLButtonElement[] {
    return [...host().querySelectorAll<HTMLButtonElement>('[data-testid="performer-option"]')];
  }

  /** Atajo desde donde el foco no es un campo de texto (el caso normal). */
  function teclear(key: string, target: EventTarget = document.body): void {
    const event = new KeyboardEvent('keydown', { key, bubbles: true });
    Object.defineProperty(event, 'target', { value: target });
    component.onKeydown(event);
  }

  beforeEach(() => build());

  describe('lista', () => {
    it('muestra de qué servicio habla', () => {
      expect(host().textContent).toContain('Consulta general');
    });

    it('numera a los doctores para que se elijan con una tecla', () => {
      const botones = opciones();

      expect(botones).toHaveLength(3);
      expect(botones[0].textContent).toContain('1');
      expect(botones[0].textContent).toContain('Dra. Ruiz');
      expect(botones[2].textContent).toContain('3');
    });

    it('cada opción tiene aria-label con el nombre del doctor', () => {
      expect(opciones()[0].getAttribute('aria-label')).toBe('Dra. Ruiz');
    });

    it('muestra la cédula cuando la hay: es lo que se asienta en el expediente', () => {
      expect(opciones()[0].textContent).toContain('12345');
    });

    it('el sugerido se pone primero y se marca como el de Enter', async () => {
      await build(DOCTORES, 'dr-3');

      const botones = opciones();
      expect(botones[0].textContent).toContain('Dra. Herrera');
      expect(botones[0].textContent).toContain('Enter');
      expect(component.ordered().map((doctor) => doctor.id)).toEqual(['dr-3', 'dr-1', 'dr-2']);
    });

    it('un sugerido que ya no está en el catálogo no rompe ni duplica la lista', async () => {
      await build(DOCTORES, 'dr-borrado');

      expect(component.ordered().map((doctor) => doctor.id)).toEqual(['dr-1', 'dr-2', 'dr-3']);
    });

    it('sin doctores dados de alta lo dice y no ofrece a nadie', async () => {
      await build([]);

      expect(opciones()).toHaveLength(0);
      expect(host().querySelector('[role="alert"]')?.textContent).toContain(
        'No hay doctores registrados',
      );
    });
  });

  describe('elegir con el ratón', () => {
    it('el clic sobre una opción emite ese doctor', () => {
      opciones()[1].click();

      expect(elegido).toHaveBeenCalledWith(expect.objectContaining({ id: 'dr-2' }));
    });

    it('cancelar no elige a nadie: el servicio no entra al ticket', () => {
      const cancelar = [...host().querySelectorAll<HTMLButtonElement>('button')].find((boton) =>
        boton.textContent?.includes('Cancelar'),
      );

      cancelar!.click();

      expect(descartado).toHaveBeenCalled();
      expect(elegido).not.toHaveBeenCalled();
    });
  });

  describe('atajos de teclado', () => {
    it.each([
      [1, 'dr-1'],
      [2, 'dr-2'],
      [3, 'dr-3'],
    ])('la tecla %s elige al doctor de esa posición', (tecla, id) => {
      teclear(String(tecla));

      expect(elegido).toHaveBeenCalledWith(expect.objectContaining({ id }));
    });

    it('Enter toma el primero, que es el sugerido', async () => {
      await build(DOCTORES, 'dr-2');

      teclear('Enter');

      expect(elegido).toHaveBeenCalledWith(expect.objectContaining({ id: 'dr-2' }));
    });

    it('Esc cancela', () => {
      teclear('Escape');

      expect(descartado).toHaveBeenCalled();
      expect(elegido).not.toHaveBeenCalled();
    });

    it('un número fuera de la lista no elige a nadie', () => {
      teclear('7');

      expect(elegido).not.toHaveBeenCalled();
    });

    it('Enter sin doctores no elige nada en vez de reventar', async () => {
      await build([]);

      teclear('Enter');

      expect(elegido).not.toHaveBeenCalled();
    });

    it('con el diálogo cerrado los atajos no hacen nada', async () => {
      await build(DOCTORES, null, false);

      teclear('1');
      teclear('Enter');
      teclear('Escape');

      expect(elegido).not.toHaveBeenCalled();
      expect(descartado).not.toHaveBeenCalled();
    });

    /**
     * Regresión: al agregar un servicio con el escáner (Enter sobre su código),
     * la venta devuelve el foco a la búsqueda con este diálogo ya abierto. Sin
     * el candado, cada dígito del siguiente código escaneado elegía un doctor y
     * metía la partida a nombre de quien tocara.
     */
    it('escribiendo en un campo de texto, los números NO eligen doctor', () => {
      const input = document.createElement('input');

      teclear('1', input);
      teclear('Enter', input);

      expect(elegido).not.toHaveBeenCalled();
    });

    it('pero Esc sigue cancelando desde el campo de texto', () => {
      teclear('Escape', document.createElement('input'));

      expect(descartado).toHaveBeenCalled();
    });

    it('tampoco elige desde un textarea ni desde un select', () => {
      teclear('1', document.createElement('textarea'));
      teclear('2', document.createElement('select'));

      expect(elegido).not.toHaveBeenCalled();
    });
  });
});
