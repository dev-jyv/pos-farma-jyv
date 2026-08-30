import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { signOut } from 'firebase/auth';
import { catchError, from, map, of, switchMap } from 'rxjs';

import { FIREBASE_AUTH } from '../firebase/firebase.providers';
import { NotificationService } from '../notifications/notification.service';
import { PermissionArea, PermissionLevel, hasPermission } from '../../shared/models';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = () => {
  const auth = inject(FIREBASE_AUTH);
  const router = inject(Router);

  return from(auth.authStateReady()).pipe(
    map(() => auth.currentUser !== null || router.createUrlTree(['/login'])),
  );
};

export const guestGuard: CanActivateFn = () => {
  const auth = inject(FIREBASE_AUTH);
  const authService = inject(AuthService);
  const router = inject(Router);

  return from(auth.authStateReady()).pipe(
    switchMap(() => {
      if (!auth.currentUser) {
        return of(true);
      }
      return authService.fetchRole().pipe(
        switchMap((role) => {
          if (!role) {
            return from(signOut(auth)).pipe(map(() => true as const));
          }
          return of(router.createUrlTree(['/pos']));
        }),
        catchError(() => from(signOut(auth)).pipe(map(() => true as const))),
      );
    }),
  );
};

/**
 * Resguarda una pantalla por permiso del backend.
 *
 * Filtrar el enlace del menú (`NAV_ITEMS`) esconde la pantalla, no la cierra:
 * escribir la URL a mano la abría igual. Este guard es la puerta; el filtro del
 * menú solo evita ofrecer un camino que terminaría en 403.
 *
 * Se consulta `fetchProfile()` y no la señal `profile`, porque en la primera
 * navegación —al recargar la app dentro de la pantalla— el perfil todavía no ha
 * llegado y cualquier lectura síncrona negaría el acceso a quien sí lo tiene.
 *
 * Al denegar se manda a `/pos`, que es la única pantalla sin guard: es el destino
 * seguro para cualquier rol y evita el rebote infinito entre dos rutas cerradas.
 */
export function permissionGuard(
  area: PermissionArea,
  level: PermissionLevel = 'write',
): CanActivateFn {
  return () => {
    const authService = inject(AuthService);
    const notifications = inject(NotificationService);
    const router = inject(Router);

    return authService.fetchProfile().pipe(
      map((profile) => {
        if (hasPermission(profile, area, level)) {
          return true;
        }
        notifications.error('Tu rol no tiene acceso a esta pantalla.');
        return router.createUrlTree(['/pos']);
      }),
      catchError(() => of(router.createUrlTree(['/pos']))),
    );
  };
}
