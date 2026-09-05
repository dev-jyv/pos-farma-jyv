import { Injectable, signal } from '@angular/core';
import { Observable, catchError, from, of, tap } from 'rxjs';

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

  /**
   * Carga (o recarga) los dos catálogos. Best-effort: sin Electron o con la
   * base ocupada, la caja sigue vendiendo medicamentos con normalidad.
   */
  refresh(): Observable<PharmacyService[]> {
    const api = window.electronAPI;
    if (!api) {
      return of([]);
    }
    this.loading.set(true);
    from(api.pharmacyServices.listProviders())
      .pipe(catchError(() => of([] as ServiceProvider[])))
      .subscribe((providers) => this.providers.set(providers));

    return from(api.pharmacyServices.list()).pipe(
      catchError(() => of([] as PharmacyService[])),
      tap((services) => {
        this.services.set(services);
        this.hasServices.set(services.length > 0);
        this.loading.set(false);
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
