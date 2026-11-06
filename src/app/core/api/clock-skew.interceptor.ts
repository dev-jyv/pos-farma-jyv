import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import { ClockSkewService } from '../time/clock-skew.service';

/**
 * Mide el desfase del reloj con cada respuesta **exitosa** de la API (SPEC 65).
 *
 * Va después de `authInterceptor` a propósito: la hora de salida se toma justo
 * antes de mandar la petición, no antes de pedir el token de Firebase, que
 * inflaría el rtt y movería la mitad de esa espera al desfase.
 *
 * El header `Date` lo pone el servidor en toda respuesta; desde el renderer de
 * Electron (`file://`) es cross-origin, así que solo se ve si el backend lo
 * expone (`Access-Control-Expose-Headers: Date`). Si no, no hay medición y la
 * caja sigue con su reloj local.
 */
export const clockSkewInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(environment.apiUrl)) {
    return next(req);
  }
  const clock = inject(ClockSkewService);
  const startedAt = Date.now();
  return next(req).pipe(
    tap((event) => {
      if (event instanceof HttpResponse) {
        clock.record(event.headers.get('Date'), startedAt, Date.now());
      }
    }),
  );
};
