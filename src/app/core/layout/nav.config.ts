import { PermissionArea, PermissionLevel } from '../../shared/models';

export interface NavItem {
  labelKey: string;
  path: string;
  icon: string;
  hotkey: string;
  /**
   * Permiso que resguarda la pantalla. Debe coincidir con el `permissionGuard` de
   * `pos.routes.ts`: aquí solo se decide **si se ofrece el camino**; quien cierra
   * la puerta es el guard. Sin permiso declarado, el enlace es visible para
   * cualquier sesión.
   */
  permission?: { area: PermissionArea; level: PermissionLevel };
}

export const NAV_ITEMS: NavItem[] = [
  { labelKey: 'nav.sale', path: '/pos', icon: 'pi pi-shopping-cart', hotkey: 'F1' },
  {
    labelKey: 'nav.history',
    path: '/pos/historial',
    icon: 'pi pi-history',
    hotkey: 'F3',
    permission: { area: 'sales', level: 'read' },
  },
  {
    labelKey: 'nav.directCharge',
    path: '/pos/cobro-directo',
    icon: 'pi pi-credit-card',
    hotkey: '',
    /**
     * Área propia y no `sales`: cobrar fuera del ticket mueve dinero sin venta
     * que lo respalde, así que es atribución de supervisión. Con `sales:write`
     * bastaba, cualquier cajero podría cobrar sin dejar rastro en el ticket.
     */
    permission: { area: 'directCharges', level: 'write' },
  },
  {
    labelKey: 'nav.stockEntry',
    path: '/pos/entrada-stock',
    icon: 'pi pi-box',
    hotkey: '',
    // Área propia: el cajero recibe mercancía, pero no abre el resto de inventario.
    permission: { area: 'stockEntry', level: 'write' },
  },
  {
    labelKey: 'nav.reports',
    path: '/pos/reportes',
    icon: 'pi pi-chart-bar',
    hotkey: '',
    // Pantalla de analítica: mismo área que los reportes del backend (`dashboard`),
    // así el cajero, que solo tiene `sales`, no ve el enlace.
    permission: { area: 'dashboard', level: 'read' },
  },
  {
    labelKey: 'nav.controlledLedger',
    path: '/pos/libro-control',
    icon: 'pi pi-book',
    hotkey: '',
    /**
     * `inventory:write` y no el `read` que pide el endpoint: `read` es el permiso
     * con el que el cajero consulta lotes y caducidades al vender, así que con él
     * el libro —un entregable de cumplimiento— le aparecería en la barra.
     */
    permission: { area: 'inventory', level: 'write' },
  },
];
