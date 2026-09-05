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
    path: 'gastos',
    // Cualquier cajero con turno abierto puede registrar sus propios gastos.
    canActivate: [permissionGuard('pos', 'write')],
    loadComponent: () => import('./expenses/expense-form/expense-form').then((m) => m.ExpenseForm),
  },
  {
    /**
     * Caja de la farmacia: sacar o meter efectivo sin venta. Se pide
     * `cashSessions:write`, área ya exclusiva de admin, y no el `pos:write` con
     * el que se registran los gastos del turno — mover el efectivo de la
     * farmacia no es una tarea de mostrador.
     */
    path: 'efectivo',
    canActivate: [permissionGuard('cashSessions', 'write')],
    loadComponent: () => import('./cash-box/cash-box').then((m) => m.CashBoxScreen),
  },
  {
    path: 'cortes',
    canActivate: [permissionGuard('cashSessions', 'read')],
    loadComponent: () =>
      import('./cash-session/audit/cash-session-audit').then((m) => m.CashSessionAudit),
  },
  {
    path: 'gastos-auditoria',
    canActivate: [permissionGuard('expenses', 'read')],
    loadComponent: () => import('./expenses/audit/expenses-audit').then((m) => m.ExpensesAudit),
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
  {
    path: 'categorias',
    canActivate: [permissionGuard('categories', 'write')],
    loadComponent: () => import('./categories/category-list/category-list').then((m) => m.CategoryList),
  },
  {
    path: 'categorias/nuevo',
    canActivate: [permissionGuard('categories', 'write')],
    loadComponent: () => import('./categories/category-form/category-form').then((m) => m.CategoryForm),
  },
  {
    path: 'categorias/:id/editar',
    canActivate: [permissionGuard('categories', 'write')],
    loadComponent: () => import('./categories/category-form/category-form').then((m) => m.CategoryForm),
  },
  {
    path: 'proveedores',
    canActivate: [permissionGuard('suppliers', 'write')],
    loadComponent: () => import('./suppliers/supplier-list/supplier-list').then((m) => m.SupplierList),
  },
  {
    path: 'proveedores/nuevo',
    canActivate: [permissionGuard('suppliers', 'write')],
    loadComponent: () => import('./suppliers/supplier-form/supplier-form').then((m) => m.SupplierForm),
  },
  {
    path: 'proveedores/:id/editar',
    canActivate: [permissionGuard('suppliers', 'write')],
    loadComponent: () => import('./suppliers/supplier-form/supplier-form').then((m) => m.SupplierForm),
  },
  {
    path: 'facturas',
    canActivate: [permissionGuard('invoices', 'write')],
    loadComponent: () => import('./invoices/invoice-list/invoice-list').then((m) => m.InvoiceList),
  },
  {
    path: 'facturas/nuevo',
    canActivate: [permissionGuard('invoices', 'write')],
    loadComponent: () => import('./invoices/invoice-form/invoice-form').then((m) => m.InvoiceForm),
  },
  {
    path: 'facturas/:id',
    canActivate: [permissionGuard('invoices', 'write')],
    loadComponent: () => import('./invoices/invoice-detail/invoice-detail').then((m) => m.InvoiceDetail),
  },
  {
    /**
     * Edición de catálogo local-first: busca en SQLite, y da de alta/edita
     * escribiendo directo ahí (sin red), igual que venta y entrada de stock.
     */
    path: 'productos',
    canActivate: [permissionGuard('products', 'write')],
    loadComponent: () => import('./products/product-list/product-list').then((m) => m.ProductList),
  },
  {
    path: 'productos/nuevo',
    canActivate: [permissionGuard('products', 'write')],
    loadComponent: () => import('./products/product-form/product-form').then((m) => m.ProductForm),
  },
  {
    path: 'productos/:id/editar',
    canActivate: [permissionGuard('products', 'write')],
    loadComponent: () => import('./products/product-form/product-form').then((m) => m.ProductForm),
  },
];
