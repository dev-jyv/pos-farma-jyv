import { DestroyRef, Injectable, inject } from '@angular/core';

import { AppLog } from '../logging/app-log.service';

/** Espera tras el último cambio: agrupa varias ventas seguidas en un solo envío. */
export const AUTO_PUSH_DEBOUNCE_MS = 7_000;
/** Tope de espera: con ventas continuas el envío no se pospone para siempre. */
export const AUTO_PUSH_MAX_WAIT_MS = 30_000;
/** Espera creciente entre reintentos sin avance (con ±20 % de variación). */
export const AUTO_PUSH_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
/** Tras tantos intentos sin avance se calla hasta `AUTO_PUSH_PAUSE_MS`; el horario fijo sigue. */
export const AUTO_PUSH_MAX_FAILURES = AUTO_PUSH_BACKOFF_MS.length;
export const AUTO_PUSH_PAUSE_MS = 15 * 60_000;

/**
 * Lo único que el envío automático sabe hacer: **subir** lo pendiente y contarlo.
 * A propósito no incluye ningún `pull`: bajar el catálogo tras cada venta
 * multiplicaría las lecturas de Firestore por el número de cajas (cada venta
 * cambia el `updatedAt` del producto). El pull solo ocurre en el horario fijo o
 * con el botón "Sincronizar".
 */
export interface PushOnlyFlusher {
  flush: () => Promise<void>;
  countPending: () => Promise<number>;
  /**
   * Contador monotónico de ventas que el servidor dejó `DEFERRED` (SPEC 48:
   * se le acabó el presupuesto de tiempo del lote). Si sube durante un envío sin
   * avance, ese envío no cuenta como intento fallido: no hubo rechazo.
   */
  deferredCount?: () => number;
}

/**
 * Sube en segundo plano lo que cambió (venta, alta de producto, entrada de
 * stock) sin esperar a los 3 horarios fijos.
 *
 * - **Debounce** de 7 s (máx. 30 s): N ventas seguidas salen en un solo
 *   `POST /sales/bulk`, no una petición por venta.
 * - **Un envío a la vez**: si llega un cambio durante uno en curso, se reagenda
 *   después, nunca se encima.
 * - **Sin red**: no intenta; queda en la cola local y sube al volver la
 *   conexión o en el siguiente horario.
 * - **Backoff** exponencial con variación si el servidor no confirma nada, y
 *   pausa de 15 min tras 5 intentos sin avance. Un rechazo definitivo no
 *   reintenta en bucle: sale de la cola (queda en "Rechazados").
 * - **El backoff y la pausa solo frenan los reintentos**, nunca un cambio nuevo:
 *   `notifyChange()` siempre programa un envío tras el debounce. Basta un
 *   pendiente que se cuenta pero nunca avanza (una entrada esperando a un
 *   producto rechazado) para encadenar backoff y pausa; cuando la pausa se
 *   tragaba el aviso, la entrada recién capturada no subía hasta el horario fijo.
 */
@Injectable({ providedIn: 'root' })
export class AutoPushService {
  private readonly log = inject(AppLog);

  private flusher: PushOnlyFlusher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstChangeAt: number | null = null;
  private pausedUntil = 0;
  private failures = 0;
  private running = false;
  private dirtyDuringRun = false;

  constructor() {
    const onOnline = (): void => this.notifyChange();
    window.addEventListener('online', onOnline);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', onOnline);
      this.clearTimer();
    });
  }

  /** `SyncScheduler` se registra aquí; sin esto no hay envío automático. */
  register(flusher: PushOnlyFlusher): void {
    this.flusher = flusher;
  }

  /** Avisa que hay algo nuevo en la cola local. Barato: solo (re)arma un temporizador. */
  notifyChange(): void {
    if (!this.flusher || !window.electronAPI) {
      return;
    }
    const now = Date.now();
    if (this.running) {
      this.dirtyDuringRun = true;
      return;
    }
    if (!navigator.onLine) {
      return;
    }
    // Sin mirar la pausa ni el backoff: esos frenan los reintentos de lo que ya
    // estaba en cola, no lo que el cajero acaba de capturar.
    this.firstChangeAt ??= now;
    const debounce = Math.min(
      AUTO_PUSH_DEBOUNCE_MS,
      Math.max(0, this.firstChangeAt + AUTO_PUSH_MAX_WAIT_MS - now),
    );
    this.arm(debounce);
  }

  private arm(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    this.timer = null;
    this.firstChangeAt = null;
    const flusher = this.flusher;
    if (!flusher || this.running) {
      return;
    }
    if (!navigator.onLine) {
      return;
    }
    this.running = true;
    this.dirtyDuringRun = false;
    const wasPaused = Date.now() < this.pausedUntil;
    try {
      const before = await flusher.countPending();
      if (before === 0) {
        this.resetFailures();
        return;
      }
      let after = before;
      const deferredBefore = flusher.deferredCount?.() ?? 0;
      let deferred = false;
      try {
        await flusher.flush();
        deferred = (flusher.deferredCount?.() ?? 0) > deferredBefore;
        after = await flusher.countPending();
      } catch (error) {
        this.log.warn('auto-push-error', { message: (error as Error)?.message });
      }
      this.log.info('auto-push', { before, after, deferred });
      this.afterAttempt(before, after, wasPaused, deferred);
    } catch (error) {
      this.log.warn('auto-push-error', { message: (error as Error)?.message });
    } finally {
      this.running = false;
      if (this.dirtyDuringRun) {
        this.dirtyDuringRun = false;
        this.notifyChange();
      }
    }
  }

  private afterAttempt(before: number, after: number, wasPaused: boolean, deferred = false): void {
    if (after === 0) {
      this.resetFailures();
      return;
    }
    // Entraron cambios nuevos durante el envío: el conteo no dice si hubo avance.
    if (this.dirtyDuringRun) {
      return;
    }
    if (after < before) {
      // Avanzó pero queda cola: se sigue sin espera creciente.
      this.resetFailures();
      this.arm(AUTO_PUSH_DEBOUNCE_MS);
      return;
    }
    if (deferred) {
      // El servidor difirió el lote (SPEC 48): pendiente, no fallo. Se reintenta
      // con la espera del escalón actual, sin subirlo ni entrar en pausa.
      const base = AUTO_PUSH_BACKOFF_MS[Math.max(0, this.failures - 1)];
      this.log.info('auto-push-deferred', { pending: after });
      this.arm(Math.round(base * (0.8 + Math.random() * 0.4)));
      return;
    }
    if (wasPaused) {
      // Un cambio nuevo dentro de la pausa no avanzó: sigue la pausa tal cual,
      // sin escalar ni armar reintentos.
      return;
    }
    this.failures += 1;
    if (this.failures >= AUTO_PUSH_MAX_FAILURES) {
      this.pausedUntil = Date.now() + AUTO_PUSH_PAUSE_MS;
      this.failures = 0;
      this.log.warn('auto-push-paused', { pending: after, minutes: AUTO_PUSH_PAUSE_MS / 60_000 });
      return;
    }
    const base = AUTO_PUSH_BACKOFF_MS[this.failures - 1];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.log.warn('auto-push-backoff', { failures: this.failures, delayMs: delay, pending: after });
    this.arm(delay);
  }

  private resetFailures(): void {
    this.failures = 0;
    this.pausedUntil = 0;
  }
}
