import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandlerFn,
  HttpInterceptorFn,
  HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { Auth, signOut } from 'firebase/auth';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';

import { FIREBASE_AUTH } from '../firebase/firebase.providers';
import { environment } from '../../../environments/environment';
import { NotificationService } from '../notifications/notification.service';
import { getApiErrorMessage } from './api.utils';

let isLoggingOut = false;

function handleUnauthorized(
  next: HttpHandlerFn,
  req: HttpRequest<unknown>,
  auth: Auth,
  router: Router,
  notifications: NotificationService,
): Observable<HttpEvent<unknown>> {
  return next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }
      if (isLoggingOut) {
        return throwError(() => error);
      }
      isLoggingOut = true;
      // El backend distingue "sesión expiró a las 24:00" de "usuario no autorizado";
      // repetir su mensaje evita que el cajero lo lea como una falla del POS.
      notifications.sessionExpired(getApiErrorMessage(error));
      return from(signOut(auth)).pipe(
        switchMap(() => from(router.navigate(['/login']))),
        switchMap(() => {
          isLoggingOut = false;
          return throwError(() => error);
        }),
        catchError((logoutError) => {
          isLoggingOut = false;
          return throwError(() => logoutError);
        }),
      );
    }),
  );
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(environment.apiUrl) || req.url.includes('/health')) {
    return next(req);
  }

  const auth = inject(FIREBASE_AUTH);
  const router = inject(Router);
  const notifications = inject(NotificationService);

  const isAuthMe = req.url.includes('/auth/me');

  return from(auth.authStateReady()).pipe(
    switchMap(() => {
      const user = auth.currentUser;
      if (!user) {
        return next(req);
      }

      return from(user.getIdToken()).pipe(
        switchMap((token) => {
          const authedReq = req.clone({
            setHeaders: { Authorization: `Bearer ${token}` },
          });
          return isAuthMe
            ? next(authedReq)
            : handleUnauthorized(next, authedReq, auth, router, notifications);
        }),
      );
    }),
  );
};
