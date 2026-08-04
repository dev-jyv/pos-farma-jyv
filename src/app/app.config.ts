import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';

import { environment } from '../environments/environment';
import { routes } from './app.routes';
import { authInterceptor } from './core/api/auth.interceptor';
import { provideFirebase } from './core/firebase/firebase.providers';
import { PosPreset } from './core/theme/pos.preset';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    MessageService,
    provideRouter(routes, ...(environment.isElectron ? [withHashLocation()] : [])),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideTranslateService({
      loader: provideTranslateHttpLoader({
        prefix: environment.isElectron ? './i18n/' : '/i18n/',
        suffix: '.json',
      }),
      fallbackLang: 'es',
      lang: 'es',
    }),
    provideFirebase(),
    providePrimeNG({
      theme: {
        preset: PosPreset,
        options: {
          darkModeSelector: false,
        },
      },
      license: environment.primeNgLicense,
    }),
  ],
};
