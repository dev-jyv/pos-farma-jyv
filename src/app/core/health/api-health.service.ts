import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, map, of } from 'rxjs';

import { environment } from '../../../environments/environment';

const POLL_INTERVAL_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class ApiHealthService {
  private readonly http = inject(HttpClient);

  readonly browserOnline = signal(navigator.onLine);
  readonly apiOk = signal(true);
  readonly degraded = computed(() => !this.browserOnline() || !this.apiOk());

  constructor() {
    window.addEventListener('online', () => {
      this.browserOnline.set(true);
      this.checkNow();
    });
    window.addEventListener('offline', () => this.browserOnline.set(false));
    this.checkNow();
    setInterval(() => this.checkNow(), POLL_INTERVAL_MS);
  }

  checkNow(): void {
    this.http
      .get(`${environment.apiUrl}/health`)
      .pipe(
        map(() => true),
        catchError(() => of(false)),
      )
      .subscribe((ok) => this.apiOk.set(ok));
  }
}
