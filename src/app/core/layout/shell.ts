import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

import { AuthService } from '../auth/auth.service';
import { ApiHealthService } from '../health/api-health.service';
import { environment } from '../../../environments/environment';
import { NAV_ITEMS } from './nav.config';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe],
  templateUrl: './shell.html',
  host: {
    '(document:keydown.f1)': 'goToSale($event)',
    '(document:keydown.f3)': 'goToHistory($event)',
  },
})
export class Shell {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly health = inject(ApiHealthService);

  /** Solo lo que el rol puede abrir: un enlace que devuelve 403 no es navegación. */
  readonly navItems = computed(() =>
    NAV_ITEMS.filter(
      (item) => !item.permission || this.authService.can(item.permission.area, item.permission.level),
    ),
  );
  readonly user = this.authService.user;
  readonly role = this.authService.role;
  /**
   * Nombre del rol tal como lo define el backend (`roles.name`). Los slugs ya no son
   * un enum de dos valores, así que traducir por clave dejaría "shell.role.manager"
   * a la vista; el nombre del documento siempre viene en español.
   */
  readonly roleLabel = computed(() => this.authService.roleName() || this.role() || '');
  readonly isAdmin = this.authService.isAdmin;
  readonly browserOnline = this.health.browserOnline;
  readonly degraded = this.health.degraded;
  readonly appVersion = environment.version;

  goToSale(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/pos']);
  }

  goToHistory(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/pos/historial']);
  }

  async logout(): Promise<void> {
    await this.authService.logout();
    await this.router.navigate(['/login']);
  }
}
