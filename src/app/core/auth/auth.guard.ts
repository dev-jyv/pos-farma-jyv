import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { signOut } from 'firebase/auth';
import { catchError, from, map, of, switchMap } from 'rxjs';

import { FIREBASE_AUTH } from '../firebase/firebase.providers';
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
