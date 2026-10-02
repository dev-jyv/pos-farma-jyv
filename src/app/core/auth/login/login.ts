import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '../auth.service';
import { NotificationService } from '../../notifications/notification.service';
import { SyncScheduler } from '../../sync/sync-scheduler.service';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, TranslatePipe],
  templateUrl: './login.html',
})
export class Login {
  private readonly fb = inject(FormBuilder);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly syncScheduler = inject(SyncScheduler);

  readonly submitting = signal(false);
  /**
   * Contraseña a la vista. Arranca oculta y no se recuerda entre entradas: el
   * equipo de caja está de cara al público y la sesión se reabre cada día.
   */
  readonly passwordVisible = signal(false);
  readonly appVersion = environment.version;

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  /**
   * Por qué "Entrar" está deshabilitado. Un botón gris sin motivo deja al cajero
   * probando clics sin saber si la app se colgó; el aviso dice qué falta.
   *
   * Depende del **valor**, no de `statusChanges`: teclear un correo mal escrito
   * no cambia el estado (sigue `INVALID`), así que con `statusChanges` el aviso
   * nunca pasaba de "falta capturar" a "el correo no es válido".
   */
  private readonly formValue = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });

  readonly disabledHint = computed<string | null>(() => {
    const valor = this.formValue() ?? {};
    if (this.submitting()) {
      return null;
    }
    if (!(valor.email ?? '').trim() || !(valor.password ?? '')) {
      return 'auth.login.hintEmpty';
    }
    if (this.form.controls.email.hasError('email')) {
      return 'auth.login.hintEmail';
    }
    return null;
  });

  togglePassword(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  async onSubmit(): Promise<void> {
    // El botón ya se deshabilita con `submitting()`, pero esa actualización del
    // DOM llega en el próximo tick — un doble clic real (o Enter + clic) puede
    // disparar `onSubmit()` dos veces antes de que el binding se refleje. Sin
    // esta guardia, dos `signInWithPassword` en vuelo duplicaban el login.
    if (this.submitting()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);

    try {
      const { email, password } = this.form.getRawValue();
      await this.authService.login(email, password);
      const role = await firstValueFrom(this.authService.fetchRole());
      if (!role) {
        await this.authService.logout();
        this.notifications.error(this.translate.instant('auth.login.error'));
        return;
      }
      // Sync solo aquí: un inicio de sesión explícito. No en cada apertura de la
      // app con la sesión de Firebase ya persistida (eso ya no cuenta como
      // "login" para este propósito). No se espera: el modal de `Shell` recoge
      // el `syncing()` ya en marcha en cuanto monta.
      if (window.electronAPI) {
        void this.syncScheduler.syncNow();
      }
      await this.router.navigate(['/pos']);
    } catch (err) {
      this.notifications.error(this.translate.instant(this.authService.getLoginErrorMessage(err)));
    } finally {
      this.submitting.set(false);
      this.passwordVisible.set(false);
    }
  }
}
