import { TranslatePipe } from '@ngx-translate/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';

/** Mínimo del motivo; el mismo que exige el backend en `POST /sales/:id/void` (SPEC 62). */
export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 300;

/**
 * Pide un motivo antes de una acción que no se deshace (anular o descartar una
 * venta, SPEC 62). Opciones rápidas para lo frecuente y texto libre para lo
 * demás; sin motivo de al menos 5 caracteres el botón no se habilita.
 *
 * - Una opción rápida basta como motivo; si además se escribe algo, se agrega
 *   como detalle ("Cliente desistió: pagará con tarjeta").
 * - La opción `otherOption` ("Otro") no cuenta sola: exige el texto.
 *
 * Los textos llegan del llamador ya traducidos: el componente no sabe de qué
 * acción se trata.
 */
@Component({
  selector: 'app-reason-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, DialogModule, TranslatePipe],
  templateUrl: './reason-dialog.html',
})
export class ReasonDialog {
  readonly visible = input(false);
  readonly header = input('');
  /** Qué se va a hacer y con qué consecuencia, en una línea. */
  readonly description = input('');
  readonly quickReasons = input<readonly string[]>([]);
  /** Opción rápida que no vale sola ("Otro"): exige escribir el motivo. */
  readonly otherOption = input<string | null>(null);
  readonly reasonLabel = input('Motivo');
  readonly placeholder = input('');
  /** `null`: el texto por defecto del i18n (`common.reasonHint`). */
  readonly hint = input<string | null>(null);
  readonly minLength = REASON_MIN_LENGTH;
  readonly confirmLabel = input('Confirmar');
  readonly cancelLabel = input('Cancelar');
  /** La acción está viajando: bloquea el doble envío. */
  readonly busy = input(false);

  readonly confirmed = output<string>();
  readonly dismissed = output<void>();

  readonly selected = signal<string | null>(null);
  readonly text = signal('');
  readonly maxLength = REASON_MAX_LENGTH;

  /** Motivo final tal como se guardará. */
  readonly reason = computed(() => {
    const detalle = this.text().trim();
    const opcion = this.selected();
    if (opcion && opcion !== this.otherOption()) {
      return (detalle ? `${opcion}: ${detalle}` : opcion).slice(0, REASON_MAX_LENGTH);
    }
    return detalle.slice(0, REASON_MAX_LENGTH);
  });

  readonly valid = computed(() => this.reason().length >= REASON_MIN_LENGTH);

  constructor() {
    // Cada apertura empieza en blanco: el motivo de la anulación anterior no
    // puede quedarse puesto para la siguiente.
    effect(() => {
      if (this.visible()) {
        untracked(() => {
          this.selected.set(null);
          this.text.set('');
        });
      }
    });
  }

  choose(option: string): void {
    this.selected.update((actual) => (actual === option ? null : option));
  }

  onInput(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
  }

  confirm(): void {
    if (!this.valid() || this.busy()) {
      return;
    }
    this.confirmed.emit(this.reason());
  }

  dismiss(): void {
    if (this.busy()) {
      return;
    }
    this.dismissed.emit();
  }
}
