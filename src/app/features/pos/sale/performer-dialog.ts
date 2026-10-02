import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';

import { ServiceProvider } from '../../../shared/models';
import { ServiceCatalogService } from '../services/service-catalog.service';

/** `true` si el evento salió de un campo donde el cajero está escribiendo. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Quién realizó el procedimiento. Se pregunta **al agregar el servicio al
 * ticket**, no al cobrar: la comisión es parte de la partida, y el checkout ya
 * tiene demasiados campos que el cajero recorre con Tab.
 *
 * Lista numerada porque el mostrador se opera con teclado: 1–9 elige y cierra
 * en un tecleo. El diálogo llega con el último doctor del turno preseleccionado,
 * así que el caso normal —el mismo doctor toda la jornada— se resuelve con Enter.
 */
@Component({
  selector: 'app-performer-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, ButtonModule, DialogModule],
  templateUrl: './performer-dialog.html',
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class PerformerDialog {
  private readonly catalog = inject(ServiceCatalogService);

  readonly visible = input(false);
  /** Nombre del servicio que se está agregando, para que el diálogo diga de qué habla. */
  readonly serviceName = input('');
  /** Doctor sugerido: el último usado en el turno. */
  readonly suggestedProviderId = input<string | null>(null);

  readonly chosen = output<ServiceProvider>();
  readonly dismissed = output<void>();

  readonly providers = this.catalog.providers;

  /** El sugerido primero: es el que se elige con Enter. */
  readonly ordered = computed(() => {
    const sugerido = this.suggestedProviderId();
    const lista = this.providers();
    if (!sugerido) {
      return lista;
    }
    const preferido = lista.filter((provider) => provider.id === sugerido);
    return [...preferido, ...lista.filter((provider) => provider.id !== sugerido)];
  });

  choose(provider: ServiceProvider): void {
    this.chosen.emit(provider);
  }

  dismiss(): void {
    this.dismissed.emit();
  }

  /**
   * Atajos: 1–9 elige por posición, Enter toma el primero (el sugerido), Esc
   * cancela. Sin esto, agregar una consulta obligaría a soltar el teclado.
   */
  onKeydown(event: KeyboardEvent): void {
    if (!this.visible()) {
      return;
    }
    const lista = this.ordered();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dismiss();
      return;
    }
    // Elegir por número o con Enter solo cuando el foco NO está en un campo de
    // texto. Al agregar un servicio con el escáner (Enter sobre su código), la
    // venta devuelve el foco a la búsqueda con este diálogo ya abierto: el
    // siguiente código escaneado elegía un doctor por cada dígito y metía la
    // partida a nombre de quien tocara. Esc sí sigue cancelando desde donde sea.
    if (isTypingTarget(event.target)) {
      return;
    }
    if (event.key === 'Enter' && lista.length) {
      event.preventDefault();
      this.choose(lista[0]);
      return;
    }
    const posicion = Number(event.key);
    if (Number.isInteger(posicion) && posicion >= 1 && posicion <= Math.min(9, lista.length)) {
      event.preventDefault();
      this.choose(lista[posicion - 1]);
    }
  }
}
