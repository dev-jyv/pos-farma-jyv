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
import { Observable, catchError, finalize, map, of, shareReplay, switchMap, tap } from 'rxjs';

import { FIREBASE_AUTH } from '../firebase/firebase.providers';
import { unwrapEntity } from '../api/api.utils';
import { CashSessionService } from '../../features/pos/services/cash-session.service';
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

/**
 * Vida de la caché del perfil. Corto frente a un turno de caja: si un
 * administrador cambia un rol a media jornada, la caja lo toma sola en minutos
 * sin obligar a cerrar sesión.
 */
const PROFILE_TTL_MS = 5 * 60 * 1000;

function authState(auth: Auth): Observable<User | null> {
  return new Observable((subscriber) => onAuthStateChanged(auth, (user) => subscriber.next(user)));
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(FIREBASE_AUTH);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);
  /**
   * A propósito, `CashSessionService` NO inyecta `AuthService` de vuelta (lo
   * necesita `endExpiredSession()` para el auto-cierre a las 24h) — Angular no
   * resuelve un ciclo entre dos `providedIn: 'root'` que se inyectan mutuamente.
   */
  private readonly cashSessionService = inject(CashSessionService);
  private readonly apiUrl = environment.apiUrl;
  private profileRequest$: Observable<StaffProfile | null> | null = null;
  /** Último perfil resuelto, con el `uid` al que pertenece y cuándo se resolvió. */
  private profileCache: { uid: string; profile: StaffProfile; at: number } | null = null;
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
  /**
   * Operar la caja es `pos:write`, no `sales:write`: el backend separó vender de
   * administrar lo vendido (anular, devolver, reembolsar) justamente para que
   * habilitar el mostrador no reparta también el poder de cancelar.
   */
  readonly canSell = computed(() => this.can('pos', 'write'));

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
      // Cerrar sesión (o entrar con otro usuario) invalida el perfil cacheado.
      if (this.profileCache && this.profileCache.uid !== (user?.uid ?? '')) {
        this.refreshProfile();
      }
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

  /**
   * Cierra la sesión avisando el motivo; el ticket queda en `localStorage`.
   *
   * **El turno de caja NO se cierra aquí.** Antes se cerraba solo a las 24:00, y
   * eso dejaba el peor escenario posible: el turno quedaba cerrado en local con
   * sus gastos y ventas todavía en cola, y como el cierre viajaba en el mismo
   * ciclo, cualquier rezagado llegaba al servidor con el turno ya cerrado y
   * moría en 400. Además nadie estaba presente para ver el error.
   *
   * Ahora el turno sobrevive a la medianoche y se liquida al entrar la siguiente
   * sesión (`SyncScheduler.settleStaleShift`), en orden y con la pantalla
   * bloqueada: primero suben movimientos y ventas, después el cierre, y solo
   * entonces se ofrece abrir el turno nuevo.
   */
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

  /**
   * Perfil del backend, cacheado por sesión.
   *
   * `shareReplay(1)` solo deduplica las peticiones **en vuelo**: el `finalize`
   * limpia la referencia al completar, así que cada `permissionGuard` disparaba
   * un `GET /auth/me` nuevo y navegar entre pantallas costaba un viaje de red por
   * cambio de ruta. La caché lo reduce a uno por sesión (o por `PROFILE_TTL_MS`),
   * que es lo que tarda en cambiar un rol.
   *
   * La caché se ata al `uid`: cambiar de usuario en el mismo equipo nunca puede
   * servir el perfil del anterior. `refreshProfile()` la invalida a mano, y el
   * backend sigue siendo la autoridad —un permiso revocado responde 403 aunque
   * la caché diga otra cosa.
   */
  fetchProfile(): Observable<StaffProfile | null> {
    const uid = this.auth.currentUser?.uid ?? '';
    const cached = this.profileCache;
    if (cached && cached.uid === uid && Date.now() - cached.at < PROFILE_TTL_MS) {
      return of(cached.profile);
    }

    if (!this.profileRequest$) {
      this.profileRequest$ = this.http.get<unknown>(`${this.apiUrl}/auth/me`).pipe(
        map((response) => parseStaffProfile(unwrapEntity<unknown>(response))),
        catchError(() => of(null as StaffProfile | null)),
        tap((profile) => {
          // Un fallo no se cachea: la siguiente navegación debe volver a intentar.
          if (profile) {
            this.profileCache = { uid, profile, at: Date.now() };
          }
        }),
        shareReplay(1),
        finalize(() => {
          this.profileRequest$ = null;
        }),
      );
    }
    return this.profileRequest$;
  }

  /** Descarta el perfil cacheado; el siguiente acceso lo vuelve a pedir. */
  refreshProfile(): void {
    this.profileCache = null;
    this.profileRequest$ = null;
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
