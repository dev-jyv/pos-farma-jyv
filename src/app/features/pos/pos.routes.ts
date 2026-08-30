import { Routes } from '@angular/router';

import { permissionGuard } from '../../core/auth/auth.guard';

/**
 * Cada pantalla se resguarda con el **mismo permiso que exige su endpoint** en el
 * backend, para que la caja no ofrezca —ni abra— algo que terminaría en 403.
 *
 * `''` (venta) queda sin guard a propósito: es el destino al que redirige el
 * guard cuando deniega, así que cerrarla también crearía un rebote infinito.
 * La venta ya se autoprotege por dentro: sin `sales:write`, `ensureShiftOpen()`
 * bloquea el cobro con un mensaje explícito en vez de dejar avanzar hasta el 403.
 */
export const POS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./sale/sale').then((m) => m.Sale),
  },
  {
    path: 'historial',
    canActivate: [permissionGuard('sales', 'read')],
    loadComponent: () => import('./history/sale-history').then((m) => m.SaleHistory),
  },
  {
    path: 'cobro-directo',
    canActivate: [permissionGuard('directCharges', 'write')],
    loadComponent: () =>
      import('./direct-charge/direct-charge').then((m) => m.DirectChargeScreen),
  },
  {
    /**
     * Recibir mercancía es del mostrador; conteos, salidas y libro de control no.
     * Por eso `stockEntry` y no `inventory:write`.
     */
    path: 'entrada-stock',
    canActivate: [permissionGuard('stockEntry', 'write')],
    loadComponent: () => import('./stock-entry/stock-entry').then((m) => m.StockEntryScreen),
  },
  {
    path: 'reportes',
    canActivate: [permissionGuard('dashboard', 'read')],
    loadComponent: () => import('./reports/reports').then((m) => m.PosReports),
  },
  {
    /**
     * El libro es un entregable de cumplimiento, no una herramienta de mostrador:
     * se pide `inventory:write` y no el `read` del endpoint, porque `read` es el
     * permiso que el cajero necesita para consultar lotes y caducidades al vender.
     * Con `read` bastaría, el libro volvería a aparecerle a quien solo cobra.
     */
    path: 'libro-control',
    canActivate: [permissionGuard('inventory', 'write')],
    loadComponent: () =>
      import('./controlled-ledger/controlled-ledger').then((m) => m.ControlledLedger),
  },
];
