import { Injectable } from '@angular/core';
import { provideTranslateLoader, provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';

import es from '../../public/i18n/es.json';

/** Las pruebas ven los textos reales en español, no las llaves. Síncrono: `of()`. */
@Injectable()
class EsLoader implements TranslateLoader {
  getTranslation() {
    return of(es);
  }
}

export default [
  provideTranslateService({ loader: provideTranslateLoader(EsLoader), fallbackLang: 'es', lang: 'es' }),
];
