import { Injectable } from '@angular/core';

import { environment } from '../../../../environments/environment';

declare global {
  interface Window {
    electronAPI?: {
      getAppVersion: () => Promise<string>;
      getDeviceInfo: () => Promise<unknown>;
      openCashDrawer: (printerName: string) => Promise<boolean>;
    };
  }
}

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
