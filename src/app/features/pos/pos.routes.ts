import { Routes } from '@angular/router';

export const POS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./sale/sale').then((m) => m.Sale),
  },
  {
    path: 'historial',
    loadComponent: () => import('./history/sale-history').then((m) => m.SaleHistory),
  },
  {
    path: 'reportes',
    loadComponent: () => import('./reports/reports').then((m) => m.PosReports),
  },
  {
    path: 'libro-control',
    loadComponent: () =>
      import('./controlled-ledger/controlled-ledger').then((m) => m.ControlledLedger),
  },
];
