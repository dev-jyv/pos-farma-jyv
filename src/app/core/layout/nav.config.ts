import { PermissionArea, PermissionLevel } from '../../shared/models';

export interface NavItem {
  labelKey: string;
  path: string;
  icon: string;
  hotkey: string;
  /** Permiso del backend que resguarda la pantalla; sin él no se muestra el enlace. */
  permission?: { area: PermissionArea; level: PermissionLevel };
}

export const NAV_ITEMS: NavItem[] = [
  { labelKey: 'nav.sale', path: '/pos', icon: 'pi pi-shopping-cart', hotkey: 'F1' },
  { labelKey: 'nav.history', path: '/pos/historial', icon: 'pi pi-history', hotkey: 'F3' },
  { labelKey: 'nav.reports', path: '/pos/reportes', icon: 'pi pi-chart-bar', hotkey: '' },
  {
    labelKey: 'nav.controlledLedger',
    path: '/pos/libro-control',
    icon: 'pi pi-book',
    hotkey: '',
    // El libro vive en `inventory`: mismo permiso que exige `GET /inventory/controlled-ledger`.
    permission: { area: 'inventory', level: 'read' },
  },
];
