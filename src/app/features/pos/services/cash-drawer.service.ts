import { Injectable } from '@angular/core';

import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class CashDrawerService {
  open(): void {
    const printerName = environment.cashDrawer?.printerName?.trim() ?? '';
    if (!environment.isElectron || !printerName) {
      return;
    }
    void window.electronAPI?.openCashDrawer(printerName).catch(() => undefined);
  }
}
