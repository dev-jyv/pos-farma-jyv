import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import { CashDrawerService } from './cash-drawer.service';

describe('CashDrawerService', () => {
  let service: CashDrawerService;
  let openCashDrawer: ReturnType<typeof vi.fn>;
  const originalIsElectron = environment.isElectron;
  const originalPrinter = environment.cashDrawer?.printerName;

  beforeEach(() => {
    service = new CashDrawerService();
    openCashDrawer = vi.fn().mockResolvedValue(true);
    window.electronAPI = {
      getAppVersion: vi.fn(),
      getDeviceInfo: vi.fn(),
      openCashDrawer,
    } as unknown as Window['electronAPI'];
  });

  afterEach(() => {
    (environment as { isElectron: boolean }).isElectron = originalIsElectron;
    environment.cashDrawer.printerName = originalPrinter ?? '';
    delete window.electronAPI;
  });

  it('abre el cajón con la impresora configurada cuando corre en Electron', () => {
    (environment as { isElectron: boolean }).isElectron = true;
    environment.cashDrawer.printerName = 'TM-T20';

    service.open();

    expect(openCashDrawer).toHaveBeenCalledWith('TM-T20');
  });

  it('en navegador no intenta abrir el cajón', () => {
    (environment as { isElectron: boolean }).isElectron = false;
    environment.cashDrawer.printerName = 'TM-T20';

    service.open();

    expect(openCashDrawer).not.toHaveBeenCalled();
  });

  it('sin impresora configurada no hace nada, aunque sea Electron', () => {
    (environment as { isElectron: boolean }).isElectron = true;
    environment.cashDrawer.printerName = '   ';

    service.open();

    expect(openCashDrawer).not.toHaveBeenCalled();
  });

  it('un fallo de la impresora no revienta el cobro ya cerrado', async () => {
    (environment as { isElectron: boolean }).isElectron = true;
    environment.cashDrawer.printerName = 'TM-T20';
    openCashDrawer.mockRejectedValue(new Error('impresora apagada'));

    expect(() => service.open()).not.toThrow();
    await Promise.resolve();
  });
});
