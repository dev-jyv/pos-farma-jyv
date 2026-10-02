import { PermissionArea, PermissionLevel } from '../../shared/models';
import { environment } from '../../../environments/environment';

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
   * Dónde vive el enlace. El reparto es **por atribución, no por frecuencia**:
   *
   * - `bar` (default): botón directo. Solo lo que se toca a cada rato.
   * - `catalog` / `inventory`: menús del mostrador, repartidos por materia.
   * - `admin`: menú "Administración" — lo que el mostrador **no** puede hacer.
   *
   * La línea que importa es la última: `admin` es todo y solo lo que el rol
   * `cashier` no puede abrir. Que `catalog` e `inventory` se repartan por materia
   * es comodidad; que nada del mostrador caiga en `admin` es la promesa.
   *
   * Ningún grupo es un permiso: quien cierra la puerta sigue siendo el
   * `permissionGuard` de la ruta, y `navItems` ya oculta lo que el rol no puede
   * abrir. Por eso `nav.config.spec.ts` verifica el reparto contra el conjunto de
   * permisos real del rol: si alguien agrega una pantalla al grupo equivocado, o
   * si el rol cambia en el backend, la prueba falla en vez de dejar al cajero
   * abriendo un menú vacío —o buscando su pantalla entre las del administrador.
   */
  group?: 'bar' | 'catalog' | 'inventory' | 'admin';
  /**
   * `false` deja la pantalla fuera del menú sin borrar su ruta ni su módulo:
   * para funciones completas que todavía no se ofrecen al mostrador.
   */
  enabled?: boolean;
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
    group: 'admin',
    // Oculto por ahora (`environment.directChargeEnabled`). La pantalla y el
    // módulo del backend siguen completos; solo no se ofrece el camino.
    enabled: environment.directChargeEnabled,
  },
  {
    labelKey: 'nav.stockEntry',
    path: '/pos/entrada-stock',
    icon: 'pi pi-box',
    hotkey: '',
    // Área propia: el cajero recibe mercancía, pero no abre el resto de inventario.
    permission: { area: 'stockEntry', level: 'write' },
    group: 'inventory',
  },
  {
    labelKey: 'nav.reports',
    path: '/pos/reportes',
    icon: 'pi pi-chart-bar',
    hotkey: '',
    // Pantalla de analítica: mismo área que los reportes del backend (`dashboard`),
    // así el cajero, que solo tiene `sales`, no ve el enlace.
    permission: { area: 'dashboard', level: 'read' },
    group: 'admin',
  },
  {
    labelKey: 'nav.expenses',
    path: '/pos/gastos',
    icon: 'pi pi-money-bill',
    hotkey: '',
    // Mismo permiso que opera la caja: cualquier cajero con turno abierto.
    permission: { area: 'pos', level: 'write' },
    // `bar` a propósito, y la excepción al reparto por atribución: registrar un
    // gasto es trabajo de turno. Enterrado en un menú, el cajero pagaba de su
    // bolsa o lo apuntaba en papel, y el efectivo esperado del corte dejaba de
    // cuadrar. Vale un botón en la barra aunque el rol lo tenga.
  },
  {
    labelKey: 'nav.cashBox',
    path: '/pos/efectivo',
    icon: 'pi pi-arrow-right-arrow-left',
    hotkey: '',
    // Exclusiva de admin: entradas y salidas de efectivo de la farmacia.
    permission: { area: 'cashSessions', level: 'write' },
    group: 'admin',
  },
  {
    labelKey: 'nav.cashSessionsAudit',
    path: '/pos/cortes',
    icon: 'pi pi-verified',
    hotkey: '',
    // Exclusiva de admin: aprobar/rechazar ajustes de todas las cajas.
    permission: { area: 'cashSessions', level: 'read' },
    group: 'admin',
  },
  {
    labelKey: 'nav.expensesAudit',
    path: '/pos/gastos-auditoria',
    icon: 'pi pi-wallet',
    hotkey: '',
    // Exclusiva de admin: gastos de todas las cajas.
    permission: { area: 'expenses', level: 'read' },
    group: 'admin',
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
    group: 'admin',
  },
  {
    labelKey: 'nav.categories',
    path: '/pos/categorias',
    icon: 'pi pi-tags',
    hotkey: '',
    permission: { area: 'categories', level: 'write' },
    group: 'catalog',
  },
  {
    labelKey: 'nav.suppliers',
    path: '/pos/proveedores',
    icon: 'pi pi-truck',
    hotkey: '',
    permission: { area: 'suppliers', level: 'write' },
    group: 'catalog',
  },
  {
    labelKey: 'nav.invoices',
    path: '/pos/facturas',
    icon: 'pi pi-file',
    hotkey: '',
    permission: { area: 'invoices', level: 'write' },
    group: 'inventory',
  },
  {
    labelKey: 'nav.invoiceRag',
    path: '/pos/facturas-rag',
    icon: 'pi pi-sparkles',
    hotkey: '',
    permission: { area: 'invoices', level: 'write' },
    group: 'inventory',
  },
  {
    labelKey: 'nav.products',
    path: '/pos/productos',
    icon: 'pi pi-tag',
    hotkey: '',
    // Cajero y admin: alta/edición de catálogo local-first, búsqueda en SQLite.
    permission: { area: 'products', level: 'write' },
    // Con Categorías: las dos editan la ficha del producto. En "Inventario"
    // quedaba junto a lo que mueve existencias, que es otra tarea.
    group: 'catalog',
  },
];
