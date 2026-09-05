import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject, catchError, map, of, switchMap } from 'rxjs';

import { environment } from '../../../environments/environment';

/**
 * Sin polling: el POS es local-first, así que no hay nada que vigilar cada
 * pocos segundos. `checkNow()` corre al abrir la app y lo dispara quien de
 * verdad necesita saber si hay red — `SyncScheduler` antes de cada sync — no
 * un timer propio.
 */
@Injectable({ providedIn: 'root' })
export class ApiHealthService {
  private readonly http = inject(HttpClient);

  readonly browserOnline = signal(navigator.onLine);
  readonly apiOk = signal(true);
  readonly degraded = computed(() => !this.browserOnline() || !this.apiOk());

  /**
   * `switchMap` cancela la llamada anterior si `checkNow()` se dispara dos
   * veces casi seguidas (evento `online` + un sync arrancando al mismo
   * tiempo): sin esto, una respuesta vieja y más lenta podía resolver después
   * de una más nueva y dejar `apiOk` desactualizado hasta el siguiente check.
   */
  private readonly check$ = new Subject<void>();

  constructor() {
    this.check$
      .pipe(
        switchMap(() =>
          this.http.get(`${environment.apiUrl}/health`).pipe(
            map(() => true),
            catchError(() => of(false)),
          ),
        ),
      )
      .subscribe((ok) => this.apiOk.set(ok));

    window.addEventListener('online', () => {
      this.browserOnline.set(true);
      this.checkNow();
    });
    window.addEventListener('offline', () => this.browserOnline.set(false));
    this.checkNow();
  }

  checkNow(): void {
    this.check$.next();
  }
}
