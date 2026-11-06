import { Injectable, computed, signal } from '@angular/core';

/** Desde aquí la barra avisa y la caja usa la hora corregida a la vista (SPEC 65). */
export const CLOCK_SKEW_WARN_MS = 5 * 60_000;
/** Desde aquí no se abre ni se cierra turno hasta corregir el reloj (SPEC 65). */
export const CLOCK_SKEW_BLOCK_MS = 2 * 3_600_000;
/** Lecturas que entran a la mediana: una respuesta lenta no mueve el desfase sola. */
export const CLOCK_SKEW_SAMPLES = 5;

const SERVER_TIME_FORMAT = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Desfase del reloj de esta caja contra el del servidor (SPEC 65).
 *
 * Nada validaba el reloj local: adelantado, autocerraba el turno vivo sin arqueo;
 * atrasado, aplicaba promociones y cupones ya vencidos. El interceptor
 * (`clockSkewInterceptor`) entrega aquí el header `Date` de cada respuesta
 * exitosa de la API y la hora en que salió la petición; el desfase es
 * `servidor − (salida + rtt/2)`, suavizado con la mediana de las últimas 5.
 *
 * `now()` es la hora corregida: la usan la expiración del turno, la vigencia de
 * promociones y cupones y el `soldAt` de la venta. Sin medición (sin red desde
 * el arranque, o un backend que no expone `Date` por CORS) es el reloj local tal
 * cual y `measured()` es `false`: la barra lo dice ("sin verificar").
 *
 * Se mide en milisegundos UTC: el horario de verano no cuenta.
 */
@Injectable({ providedIn: 'root' })
export class ClockSkewService {
  private samples: number[] = [];

  /** `servidor − local` en ms; `null` mientras no hay ninguna lectura. */
  readonly skewMs = signal<number | null>(null);
  readonly measured = computed(() => this.skewMs() !== null);
  /** `|desfase| > 5 min`: la barra avisa. */
  readonly warning = computed(() => Math.abs(this.skewMs() ?? 0) > CLOCK_SKEW_WARN_MS);
  /** `|desfase| > 2 h`: abrir o cerrar turno pide corregir el reloj. */
  readonly blocked = computed(() => Math.abs(this.skewMs() ?? 0) > CLOCK_SKEW_BLOCK_MS);
  /** Minutos de desfase, sin signo, para el aviso. */
  readonly skewMinutes = computed(() => Math.round(Math.abs(this.skewMs() ?? 0) / 60_000));

  /**
   * Una lectura. `dateHeader` es el header `Date` (resolución de 1 s, en UTC);
   * se ignora si falta o no se puede leer, y también si las marcas de tiempo
   * locales no tienen sentido (el reloj se movió a media petición).
   */
  record(dateHeader: string | null, requestStartMs: number, responseAtMs: number): void {
    if (!dateHeader) {
      return;
    }
    const serverMs = Date.parse(dateHeader);
    const rtt = responseAtMs - requestStartMs;
    if (Number.isNaN(serverMs) || rtt < 0) {
      return;
    }
    this.samples = [...this.samples, serverMs - (requestStartMs + rtt / 2)].slice(
      -CLOCK_SKEW_SAMPLES,
    );
    this.skewMs.set(Math.round(median(this.samples)));
  }

  /** Hora corregida (ms UTC): `Date.now() + desfase`. Sin medición, el reloj local. */
  now(): number {
    return Date.now() + (this.skewMs() ?? 0);
  }

  nowDate(): Date {
    return new Date(this.now());
  }

  /** Hora del servidor en CDMX, para el mensaje que pide corregir el reloj. */
  serverTimeLabel(): string {
    return SERVER_TIME_FORMAT.format(this.nowDate());
  }

  /** Solo pruebas: vuelve al estado sin medición. */
  reset(): void {
    this.samples = [];
    this.skewMs.set(null);
  }
}
