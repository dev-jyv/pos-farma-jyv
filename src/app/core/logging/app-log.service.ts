import { ErrorHandler, Injectable } from '@angular/core';

type Level = 'info' | 'warn' | 'error';

/**
 * Bitácora del renderer hacia el archivo de log del proceso principal. Sin
 * Electron (navegador) cae a `console`. Nunca lanza: loguear no puede romper un cobro.
 * No pasar datos personales: solo ids, folios, llaves de idempotencia y códigos.
 */
@Injectable({ providedIn: 'root' })
export class AppLog {
  info(event: string, data?: Record<string, unknown>): void {
    this.write('info', event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.write('warn', event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.write('error', event, data);
  }

  private write(level: Level, event: string, data?: Record<string, unknown>): void {
    try {
      const api = window.electronAPI?.log;
      if (api) {
        void api.write(level, event, data).catch(() => undefined);
      } else {
        console[level === 'info' ? 'log' : level](`[${event}]`, data ?? '');
      }
    } catch {
      /* el log nunca rompe la operación */
    }
  }
}

/** Errores no capturados de Angular a la bitácora, sin perder la salida a consola. */
@Injectable()
export class LoggingErrorHandler implements ErrorHandler {
  private readonly log = new AppLog();

  handleError(error: unknown): void {
    const err = error as { message?: string; stack?: string } | undefined;
    this.log.error('unhandled-error', { message: err?.message ?? String(error), stack: err?.stack });
    console.error(error);
  }
}
