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
  /**
   * `primary` (default): botón directo en la barra — lo que el cajero toca todo
   * el turno. `secondary`: pantallas de administración/consulta ocasional, que
   * viven detrás del menú "Más" para que la barra no crezca con cada módulo
   * nuevo que se agregue.
   */
  group?: 'primary' | 'secondary';
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
    group: 'secondary',
  },
  {
    labelKey: 'nav.expenses',
    path: '/pos/gastos',
    icon: 'pi pi-money-bill',
    hotkey: '',
    // Mismo permiso que opera la caja: cualquier cajero con turno abierto.
    permission: { area: 'pos', level: 'write' },
    // `primary` a propósito: registrar un gasto es trabajo de turno, no de
    // administración. Enterrado en "Más" el cajero pagaba de su bolsa o lo
    // apuntaba en papel, y el efectivo esperado del corte dejaba de cuadrar.
  },
  {
    labelKey: 'nav.cashBox',
    path: '/pos/efectivo',
    icon: 'pi pi-arrow-right-arrow-left',
    hotkey: '',
    // Exclusiva de admin: entradas y salidas de efectivo de la farmacia.
    permission: { area: 'cashSessions', level: 'write' },
    group: 'secondary',
  },
  {
    labelKey: 'nav.cashSessionsAudit',
    path: '/pos/cortes',
    icon: 'pi pi-verified',
    hotkey: '',
    // Exclusiva de admin: aprobar/rechazar ajustes de todas las cajas.
    permission: { area: 'cashSessions', level: 'read' },
    group: 'secondary',
  },
  {
    labelKey: 'nav.expensesAudit',
    path: '/pos/gastos-auditoria',
    icon: 'pi pi-wallet',
    hotkey: '',
    // Exclusiva de admin: gastos de todas las cajas.
    permission: { area: 'expenses', level: 'read' },
    group: 'secondary',
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
    group: 'secondary',
  },
  {
    labelKey: 'nav.categories',
    path: '/pos/categorias',
    icon: 'pi pi-tags',
    hotkey: '',
    permission: { area: 'categories', level: 'write' },
    group: 'secondary',
  },
  {
    labelKey: 'nav.suppliers',
    path: '/pos/proveedores',
    icon: 'pi pi-truck',
    hotkey: '',
    permission: { area: 'suppliers', level: 'write' },
    group: 'secondary',
  },
  {
    labelKey: 'nav.invoices',
    path: '/pos/facturas',
    icon: 'pi pi-file',
    hotkey: '',
    permission: { area: 'invoices', level: 'write' },
    group: 'secondary',
  },
  {
    labelKey: 'nav.products',
    path: '/pos/productos',
    icon: 'pi pi-tag',
    hotkey: '',
    // Cajero y admin: alta/edición de catálogo local-first, búsqueda en SQLite.
    permission: { area: 'products', level: 'write' },
    group: 'secondary',
  },
];
