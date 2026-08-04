import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  Auth,
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { Observable, catchError, finalize, map, of, shareReplay, switchMap } from 'rxjs';

import { FIREBASE_AUTH } from '../firebase/firebase.providers';
import { unwrapEntity } from '../api/api.utils';
import { NotificationService } from '../notifications/notification.service';
import { getSessionExpiryMs, isSessionExpired } from '../../shared/utils/session-expiry';
import {
  PermissionArea,
  PermissionLevel,
  StaffProfile,
  StaffRole,
  hasPermission,
  parseStaffProfile,
} from '../../shared/models';
import { environment } from '../../../environments/environment';

function authState(auth: Auth): Observable<User | null> {
  return new Observable((subscriber) => onAuthStateChanged(auth, (user) => subscriber.next(user)));
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(FIREBASE_AUTH);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);
  private readonly apiUrl = environment.apiUrl;
  private profileRequest$: Observable<StaffProfile | null> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  readonly user = toSignal(authState(this.auth), { initialValue: null as User | null });

  /**
   * Perfil del backend: rol (documento de `roles`) + permisos efectivos. El rol ya
   * no es un enum cerrado, así que la UI debe preguntar por permiso (`can`) y no
   * comparar slugs — salvo las reglas que el backend sí ata a `admin` (anulación).
   */
  readonly profile = toSignal(
    authState(this.auth).pipe(
      switchMap((user) => (user ? this.fetchProfile() : of(null as StaffProfile | null))),
    ),
    { initialValue: null as StaffProfile | null },
  );

  readonly role = computed<StaffRole | null>(() => this.profile()?.role.slug ?? null);
  readonly roleName = computed(() => this.profile()?.role.name ?? '');
  readonly permissions = computed(() => this.profile()?.permissions ?? []);

  readonly isAuthenticated = computed(() => this.user() !== null);
  /** `assertCanVoidSale` en el backend exige exactamente el slug `admin`. */
  readonly isAdmin = computed(() => this.role() === 'admin');
  readonly canSell = computed(() => this.can('sales', 'write'));

  /** Instante en que el backend deja de aceptar el token vigente. */
  readonly sessionExpiresAt = signal<Date | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearExpiryTimer());

    // El backend rechaza cualquier token emitido antes de la medianoche local; en
    // vez de esperar el 401 a media venta, el POS programa el cierre de sesión y
    // avisa con un mensaje que explica el motivo real.
    effect(() => {
      const user = this.user();
      this.clearExpiryTimer();
      if (!user) {
        this.sessionExpiresAt.set(null);
        return;
      }
      void this.scheduleSessionExpiry(user);
    });
  }

  can(area: PermissionArea, level: PermissionLevel = 'write'): boolean {
    return hasPermission(this.profile(), area, level);
  }

  /** Cierra la sesión avisando el motivo; el ticket queda en `localStorage`. */
  async endExpiredSession(detail?: string): Promise<void> {
    this.clearExpiryTimer();
    this.notifications.sessionExpired(detail);
    await this.logout();
    await this.router.navigate(['/login']);
  }

  private async scheduleSessionExpiry(user: User): Promise<void> {
    const authTimeMs = await this.getAuthTimeMs(user);
    if (authTimeMs === null) {
      return;
    }
    const expiresAtMs = getSessionExpiryMs(authTimeMs);
    this.sessionExpiresAt.set(new Date(expiresAtMs));

    if (isSessionExpired(authTimeMs)) {
      await this.endExpiredSession();
      return;
    }
    // `setTimeout` satura arriba de ~24.8 días; el turno nunca llega ahí, pero se
    // acota por seguridad para no disparar de inmediato por overflow.
    const delay = Math.min(expiresAtMs - Date.now(), 2_147_483_000);
    this.expiryTimer = setTimeout(() => void this.endExpiredSession(), delay);
  }

  private async getAuthTimeMs(user: User): Promise<number | null> {
    try {
      const token = await user.getIdTokenResult();
      const authTime = new Date(token.authTime).getTime();
      return Number.isNaN(authTime) ? null : authTime;
    } catch {
      return null;
    }
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  fetchProfile(): Observable<StaffProfile | null> {
    if (!this.profileRequest$) {
      this.profileRequest$ = this.http.get<unknown>(`${this.apiUrl}/auth/me`).pipe(
        map((response) => parseStaffProfile(unwrapEntity<unknown>(response))),
        catchError(() => of(null as StaffProfile | null)),
        shareReplay(1),
        finalize(() => {
          this.profileRequest$ = null;
        }),
      );
    }
    return this.profileRequest$;
  }

  /** Compatibilidad: los guards solo necesitan saber si hay rol utilizable. */
  fetchRole(): Observable<StaffRole | null> {
    return this.fetchProfile().pipe(map((profile) => profile?.role.slug ?? null));
  }

  async login(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(this.auth, email, password);
  }

  async logout(): Promise<void> {
    await signOut(this.auth);
  }

  getLoginErrorMessage(error: unknown): string {
    const code = this.getErrorCode(error);
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return 'auth.login.error';
      case 'auth/too-many-requests':
        return 'auth.login.error';
      default:
        return 'auth.login.error';
    }
  }

  private getErrorCode(error: unknown): string | null {
    if (error && typeof error === 'object' && 'code' in error) {
      return String((error as { code: unknown }).code);
    }
    return null;
  }
}
