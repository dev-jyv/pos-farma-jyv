import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '../auth.service';
import { NotificationService } from '../../notifications/notification.service';
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

  readonly submitting = signal(false);
  readonly appVersion = environment.version;

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  async onSubmit(): Promise<void> {
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
      await this.router.navigate(['/pos']);
    } catch (err) {
      this.notifications.error(this.translate.instant(this.authService.getLoginErrorMessage(err)));
    } finally {
      this.submitting.set(false);
    }
  }
}
