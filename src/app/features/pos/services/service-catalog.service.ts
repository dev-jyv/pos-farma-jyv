import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, finalize, forkJoin, from, map, of, tap } from 'rxjs';

import { SERVICES_SYNCED_EVENT } from '../../../core/sync/sync-events';
import { PharmacyService, ServiceProvider } from '../../../shared/models';

/**
 * Catálogo de servicios y de doctores en la caja: **100 % local y solo lectura**.
 *
 * A diferencia de `ProductCatalogService`, aquí no hay cola de push ni alta
 * local: estos catálogos los administra el admin web y llegan por pull
 * (`SyncScheduler`). Por eso tampoco hay `remoteId` — el `id` local ya es el de
 * Firestore, y eso es lo que permite congelar el `serviceId` en el payload de
 * una venta sabiendo que el backend lo va a reconocer.
 *
 * El catálogo se cachea en una señal porque son decenas de servicios (no miles
 * de productos): caben en memoria y el mostrador los quiere ver de inmediato,
 * sin el mínimo de caracteres que sí necesita la búsqueda de medicamentos.
 */
@Injectable({ providedIn: 'root' })
export class ServiceCatalogService {
  /** Catálogo activo, cargado una vez por turno. */
  readonly services = signal<PharmacyService[]>([]);
  readonly providers = signal<ServiceProvider[]>([]);
  readonly loading = signal(false);

  /** `true` si la farmacia tiene servicios: si no, la UI no ofrece la pestaña. */
  readonly hasServices = signal(false);

  /** Cada `refresh()` toma un número: solo el último escribe, uno viejo que termina tarde se descarta. */
  private refreshSeq = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      const onSynced = () => this.refresh().subscribe();
      window.addEventListener(SERVICES_SYNCED_EVENT, onSynced);
      // Sin esto cada instancia (cada TestBed) dejaba un listener vivo en `window`.
      inject(DestroyRef).onDestroy(() => window.removeEventListener(SERVICES_SYNCED_EVENT, onSynced));
    }
  }

  /**
   * Carga (o recarga) los dos catálogos. Best-effort: sin Electron o con la
   * base ocupada, la caja sigue vendiendo medicamentos con normalidad.
   *
   * Una lectura que falla **conserva lo que ya había**: el sync escribe en la
   * misma SQLite, y una base ocupada devolvía `[]` que borraba el catálogo (y la
   * pestaña de servicios) hasta la siguiente carga.
   */
  refresh(): Observable<PharmacyService[]> {
    const api = window.electronAPI;
    if (!api) {
      return of([]);
    }
    const seq = ++this.refreshSeq;
    this.loading.set(true);
    const providers$ = from(api.pharmacyServices.listProviders()).pipe(
      map((providers): ServiceProvider[] | null => providers),
      catchError(() => of(null)),
    );
    const services$ = from(api.pharmacyServices.list()).pipe(
      map((services): PharmacyService[] | null => services),
      catchError(() => of(null)),
    );
    return forkJoin([providers$, services$]).pipe(
      tap(([providers, services]) => {
        if (seq !== this.refreshSeq) {
          return;
        }
        if (providers) {
          this.providers.set(providers);
        }
        if (services) {
          this.services.set(services);
          this.hasServices.set(services.length > 0);
        }
      }),
      map(([, services]) => services ?? this.services()),
      finalize(() => {
        if (seq === this.refreshSeq) {
          this.loading.set(false);
        }
      }),
    );
  }

  /**
   * Filtra el catálogo ya cacheado, sin ir a la base: el cajero teclea y la
   * lista responde en el mismo tick.
   */
  search(term: string): PharmacyService[] {
    const texto = term.trim().toLowerCase();
    if (!texto) {
      return this.services();
    }
    return this.services().filter(
      (service) =>
        service.name.toLowerCase().includes(texto) || service.code.toLowerCase().includes(texto),
    );
  }

  /**
   * Coincidencia exacta por código, para el escáner: el `Enter` de la búsqueda
   * resuelve primero contra productos y solo cae aquí si no hubo medicamento.
   */
  findByCode(code: string): PharmacyService | null {
    const texto = code.trim().toLowerCase();
    return this.services().find((service) => service.code.toLowerCase() === texto) ?? null;
  }

  providerById(id: string): ServiceProvider | null {
    return this.providers().find((provider) => provider.id === id) ?? null;
  }
}
