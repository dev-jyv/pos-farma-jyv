export type StaffRole = string;

export function parseStaffRole(value: unknown): StaffRole | null {
  if (typeof value === 'string' && value) {
    return value;
  }
  if (value && typeof value === 'object' && 'slug' in value) {
    const slug = (value as { slug: unknown }).slug;
    return typeof slug === 'string' && slug ? slug : null;
  }
  return null;
}

/**
 * Áreas y niveles de permiso del backend (`functions/src/constants/permissions.ts`).
 * El rol ya no es un enum: es un documento de `roles` con su lista de permisos, así
 * que la UI debe preguntar por permiso y no por slug.
 */
export type PermissionArea =
  | 'dashboard'
  | 'users'
  /** Administrar lo vendido: leer ventas, anular, devolver, reembolsar. */
  | 'sales'
  /**
   * Operar la caja: levantar la venta, cobrar con la terminal, mover y cerrar el
   * turno, dar de alta al cliente en el mostrador. Separada de `sales` a
   * propósito: con una sola área, habilitar la caja le daba al cajero el poder de
   * anular y reembolsar sus propias ventas.
   */
  | 'pos'
  | 'categories'
  | 'products'
  | 'suppliers'
  | 'inventory'
  | 'invoices'
  | 'uploads'
  | 'doctor'
  /**
   * Áreas del consultorio. El POS no tiene pantallas para ellas, pero el perfil
   * que devuelve `/auth/me` sí las trae: omitirlas hacía que un permiso válido
   * del backend no tuviera representación aquí.
   */
  | 'patients'
  | 'medicalRecords'
  | 'appointments'
  /** Cobros fuera de una venta; área propia, no `sales` (ver `direct-charge`). */
  | 'directCharges'
  /**
   * Recibir mercancía contra factura desde la caja. Área propia y no
   * `inventory`: `inventory:write` abriría además conteos, salidas y el libro
   * de control, que no son del mostrador.
   */
  | 'stockEntry';

export type PermissionLevel = 'read' | 'write';

export interface RolePermission {
  area: PermissionArea;
  level: PermissionLevel;
}

export interface RoleSummary {
  id: string;
  name: string;
  slug: StaffRole;
}

/** Lo que devuelve `GET /auth/me`. */
export interface StaffProfile {
  uid: string;
  email: string;
  displayName: string;
  role: RoleSummary;
  permissions: RolePermission[];
}

/**
 * Misma regla que `hasPermission` en el backend, incluido el atajo de `admin`:
 * si la UI fuera más estricta que la API, bloquearía acciones permitidas.
 */
export function hasPermission(
  profile: StaffProfile | null,
  area: PermissionArea,
  level: PermissionLevel = 'write',
): boolean {
  if (!profile) {
    return false;
  }
  if (profile.role.slug === 'admin') {
    return true;
  }
  const permission = profile.permissions.find((item) => item.area === area);
  if (!permission) {
    return false;
  }
  return level === 'read' ? true : permission.level === 'write';
}

export function parseStaffProfile(value: unknown): StaffProfile | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const dto = value as {
    uid?: unknown;
    email?: unknown;
    displayName?: unknown;
    role?: unknown;
    permissions?: unknown;
  };
  const slug = parseStaffRole(dto.role);
  if (!slug) {
    return null;
  }
  const role = (typeof dto.role === 'object' && dto.role !== null ? dto.role : {}) as {
    id?: unknown;
    name?: unknown;
  };
  const permissions = Array.isArray(dto.permissions)
    ? dto.permissions.filter(
        (item): item is RolePermission =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as RolePermission).area === 'string' &&
          ((item as RolePermission).level === 'read' || (item as RolePermission).level === 'write'),
      )
    : [];

  return {
    uid: typeof dto.uid === 'string' ? dto.uid : '',
    email: typeof dto.email === 'string' ? dto.email : '',
    displayName: typeof dto.displayName === 'string' ? dto.displayName : '',
    role: {
      id: typeof role.id === 'string' ? role.id : '',
      name: typeof role.name === 'string' ? role.name : slug,
      slug,
    },
    permissions,
  };
}

export interface ListMeta {
  total: number;
  page: number;
  pageSize: number;
}

/** Grupos del art. 226 de la Ley General de Salud (COFEPRIS). */
export type ControlledGroup = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI';

export interface Product {
  id: string;
  name: string;
  activeIngredient?: string;
  concentration?: string;
  sku: string;
  barcode?: string;
  salePrice: number;
  stock: number;
  requiresPrescription?: boolean;
  /**
   * Grupo COFEPRIS del producto. Manda sobre `requiresPrescription`: define si la
   * venta exige receta, folio, retención de la receta y renglón en el libro de control.
   */
  controlledGroup?: ControlledGroup;
  /** Banderas fiscales del catálogo; el precio ya trae los impuestos incluidos. */
  hasIva?: boolean;
  hasIvaZero?: boolean;
  hasIeps?: boolean;
  iepsRate?: number;
  /**
   * Campos que el catálogo ya devuelve y que solo necesita la entrada de stock
   * para poder editar el producto sin perderlos. La venta no los usa.
   */
  categoryId?: string;
  unit?: string;
  minStock?: number;
}

/** Categoría del catálogo; el POS solo la lista para el alta de productos. */
export interface Category {
  id: string;
  name: string;
}

/**
 * Factura de **compra** ya registrada en el sistema, contra la que se recibe
 * mercancía. No confundir con `SaleBilling`, que es la factura al cliente.
 */
export interface PurchaseInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: Date;
  supplierId: string;
  supplierName: string;
  totalAmount: number;
  /** `false` cuando el proveedor entregó la mercancía sin comprobante fiscal. */
  hasInvoice: boolean;
}

export interface ProductBatch {
  id: string;
  productId: string;
  lotNumber: string;
  expiryDate: Date;
  quantity: number;
}

export interface CartLine {
  product: Product;
  quantity: number;
  discountAmount: number;
}

export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'mixed';

export function parsePaymentMethod(value: unknown): PaymentMethod | null {
  return value === 'cash' || value === 'card' || value === 'transfer' || value === 'mixed'
    ? value
    : null;
}

/** Desglose fiscal de una partida: el precio de catálogo trae impuestos incluidos. */
export interface SaleItemTaxes {
  base: number;
  ivaRate: number;
  ivaAmount: number;
  iepsRate: number;
  iepsAmount: number;
}

export interface SaleTaxSummary {
  base: number;
  ivaTotal: number;
  iepsTotal: number;
  taxTotal: number;
  /** `base + taxTotal`; debe coincidir al centavo con el total cobrado. */
  total: number;
}

export interface SaleItem {
  productId: string;
  productName: string;
  unitPrice: number;
  discountAmount: number;
  quantity: number;
  subtotal: number;
  /** Parte del descuento a nivel venta prorrateada a esta partida. */
  saleDiscountShare?: number;
  /** Importe realmente cobrado por la partida (impuestos incluidos). */
  netAmount?: number;
  /** Ausente en ventas anteriores al desglose de impuestos. */
  taxes?: SaleItemTaxes;
}

export interface SalePrescription {
  doctorName: string;
  doctorLicense: string;
  folio?: string;
}

export interface SaleBilling {
  rfc: string;
  name: string;
  usoCfdi?: string;
  email?: string;
}

export interface Sale {
  id: string;
  folio: string;
  items: SaleItem[];
  subtotal: number;
  discountTotal: number;
  total: number;
  /** `null` en ventas anteriores al desglose de impuestos. */
  taxSummary: SaleTaxSummary | null;
  paymentMethod: PaymentMethod;
  amountReceived: number | null;
  change: number | null;
  /**
   * Parte del total pagada en efectivo (lo que entra al cajón). `null` en ventas
   * anteriores al split mixto y en tarjeta/transferencia.
   */
  cashAmount: number | null;
  /** Parte del total pagada con tarjeta (monto de la order Point). */
  cardAmount: number | null;
  cardPaymentReference: string | null;
  cashierId: string;
  cashSessionId: string | null;
  customerId: string | null;
  customerName: string | null;
  prescription: SalePrescription | null;
  /** El cajero confirmó que la receta se retuvo (grupos I a III). */
  prescriptionRetained: boolean;
  /** Grupos COFEPRIS presentes en la venta; vacío si nada era controlado. */
  controlledGroups: ControlledGroup[];
  billing: SaleBilling | null;
  invoiceStatus: 'pending' | null;
  voidedAt: Date | null;
  createdAt: Date;
}

export interface Customer {
  id: string;
  name: string;
  rfc?: string;
  phone?: string;
  email?: string;
}

export type CashMovementType = 'deposit' | 'withdrawal' | 'expense';

export interface CashMovement {
  id: string;
  cashSessionId: string;
  type: CashMovementType;
  amount: number;
  reason: string;
  createdBy: string;
  createdAt: Date;
}

export interface HeldSale {
  id: string;
  label: string;
  lines: CartLine[];
  heldAt: Date;
}

export interface CashMethodTotals {
  count: number;
  total: number;
}

export interface CashMovementTotals {
  count: number;
  total: number;
}

export interface CashSessionSummary {
  salesCount: number;
  voidedCount: number;
  byMethod: {
    cash: CashMethodTotals;
    card: CashMethodTotals;
    transfer: CashMethodTotals;
    mixed: CashMethodTotals;
  };
  movements: {
    deposits: CashMovementTotals;
    withdrawals: CashMovementTotals;
    expenses: CashMovementTotals;
  };
  grandTotal: number;
  cashInDrawer: number;
}

export interface CashSession {
  id: string;
  openedBy: string;
  openingAmount: number;
  expectedCashAmount: number | null;
  countedCashAmount: number | null;
  cashDifference: number | null;
  summary: CashSessionSummary | null;
  openedAt: Date;
  closedAt: Date | null;
}

export interface CashSessionCut {
  session: CashSession;
  summary: CashSessionSummary;
  expectedCashAmount?: number;
}

/* ── Cobro directo con tarjeta (sin venta) ─────────────────────────────── */

export type DirectChargeStatus = 'pending' | 'approved' | 'failed' | 'canceled';

/** Cómo se cobró: terminal física (Point) o link de pago de Mercado Pago. */
export type DirectChargeChannel = 'point' | 'online';

/** Foto de la order Point que respalda el cobro. */
export interface DirectChargePoint {
  orderId: string;
  paymentId: string | null;
  status: string;
  amount: string;
  terminalId: string;
  externalReference: string;
}

/**
 * Cobro con terminal que no corresponde a una venta de mostrador. Vive en su
 * propia colección del backend (`directCharges`): no entra al ticket, ni al
 * inventario, ni al arqueo de caja, ni a los reportes de ventas.
 */
/** Link de pago (Checkout Pro) que respalda un cobro en línea. */
export interface DirectChargeOnline {
  preferenceId: string;
  /** URL que se comparte con el cliente para pagar. */
  initPoint: string;
  sandboxInitPoint: string | null;
  paymentId: string | null;
  /** Estado crudo del pago en Mercado Pago (`approved`, `rejected`, …). */
  paymentStatus: string | null;
  externalReference: string;
  /** ISO; pasada esta hora el link deja de cobrar. */
  expiresAt: string | null;
}

export interface DirectCharge {
  id: string;
  folio: string;
  amount: number;
  concept: string;
  channel: DirectChargeChannel;
  status: DirectChargeStatus;
  /** Detalle del rechazo tal como lo reporta Mercado Pago. */
  statusDetail: string | null;
  /** Presente solo en cobros por terminal. */
  point: DirectChargePoint | null;
  /** Presente solo en cobros en línea. */
  online: DirectChargeOnline | null;
  cashierId: string;
  canceledBy: string | null;
  canceledAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
}
