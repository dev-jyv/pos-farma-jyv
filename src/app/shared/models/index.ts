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
  | 'stockEntry'
  /**
   * Auditoría de cortes de caja de TODAS las cajas (listado global, aprobar/
   * rechazar ajustes pendientes). Exclusiva de `admin` — el cajero opera su
   * propio turno con `pos:write`.
   */
  | 'cashSessions'
  /**
   * Auditoría de gastos de TODAS las cajas. Exclusiva de `admin` — el cajero
   * registra sus propios gastos con `pos:write`.
   */
  | 'expenses';

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


/** Grupos del art. 226 de la Ley General de Salud (COFEPRIS). */
export type ControlledGroup = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI';

export interface Product {
  id: string;
  /**
   * Id del documento en Firestore. Ausente/null si el producto se dio de alta
   * local (`stock-entry`) y todavía no sincroniza — vender ese producto antes
   * de que su alta suba al backend hará que la venta falle al empujarse.
   */
  remoteId?: string | null;
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
  /** Solo lo llena/usa el módulo de edición de catálogo (`/pos/productos`). */
  isActive?: boolean;
}

/**
 * Campos editables de un producto vía `POST /products`/`PATCH /products/:id`
 * (creación desde "Entrada de stock" o desde el módulo de edición de
 * catálogo). Compartido entre ambos flujos para no duplicar la forma del
 * payload que el backend espera.
 */
export interface ProductFieldsPayload {
  name: string;
  sku: string;
  categoryId: string;
  unit: string;
  salePrice: number;
  minStock: number;
  hasIva: boolean;
  hasIvaZero: boolean;
  hasIeps: boolean;
  barcode?: string;
  activeIngredient?: string;
  concentration?: string;
  /** Fracción, no porcentaje: 0.08 es 8 %. La pantalla captura el porcentaje. */
  iepsRate?: number;
  controlledGroup?: ControlledGroup;
  requiresPrescription?: boolean;
  /** Solo lo usa el módulo de edición de catálogo; alta/entrada de stock no lo toca. */
  isActive?: boolean;
}

/** Categoría del catálogo. Los campos opcionales solo los llena el módulo de administración. */
export interface Category {
  id: string;
  name: string;
  description?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
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
  fileUrl?: string;
}

export interface ProductBatch {
  id: string;
  productId: string;
  lotNumber: string;
  expiryDate: Date;
  quantity: number;
}

/**
 * Servicio de farmacia: consulta, procedimiento u otro concepto que se cobra en
 * la venta pero **no es mercancía**. Catálogo propio, administrado solo por un
 * admin y sincronizado por pull; su `id` es el mismo de Firestore.
 *
 * Que aquí no exista `stock`, `minStock` ni `controlledGroup` es deliberado:
 * hace **imposible** darle entrada de inventario a un servicio, en vez de
 * dejarlo como una regla que hay que recordar verificar en cada pantalla.
 */
export interface PharmacyService {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  serviceType: ServiceType;
  /** Impuesto incluido, mismo criterio que `Product.salePrice`. */
  price: number;
  taxMode: ServiceTaxMode;
  hasIeps?: boolean;
  /** Fracción, no porcentaje: 0.08 es 8 %. */
  iepsRate?: number | null;
  /** Porcentaje 0..100 que se acredita a quien realiza el servicio. */
  commissionRate: number;
  /** Si es `true`, al cobrar es obligatorio elegir quién lo realizó. */
  requiresPerformer?: boolean;
  isActive?: boolean;
}

export type ServiceType = 'consultation' | 'procedure' | 'other';

/**
 * `exempt` y `zero` dan $0 de IVA por igual; se distinguen porque no son lo
 * mismo al facturar (los servicios médicos en México son exentos, no tasa 0).
 */
export type ServiceTaxMode = 'exempt' | 'zero' | 'iva16';

/** Doctor al que se acredita una comisión. **No** es un usuario del sistema. */
export interface ServiceProvider {
  id: string;
  name: string;
  /** Cédula profesional. */
  license?: string | null;
  defaultCommissionRate?: number | null;
  isActive?: boolean;
}

/**
 * Línea del ticket. Es una **unión discriminada**: una línea de producto mueve
 * inventario y está limitada por su stock; una de servicio no tiene stock que
 * consultar y puede generar comisión.
 *
 * Se descartó envolver el servicio en un objeto con forma de `Product`: habría
 * entrado al Top de medicamentos de los reportes, a las promociones y al
 * payload de venta como si fuera mercancía. Con la unión, el compilador señala
 * cada sitio que tiene que decidir qué hacer con cada tipo de línea.
 * Las utilidades para leer una línea sin ramificar a mano viven en
 * `shared/utils/cart-line.ts`.
 */
export interface CartProductLine {
  kind: 'product';
  product: Product;
  quantity: number;
  discountAmount: number;
}

export interface CartServiceLine {
  kind: 'service';
  service: PharmacyService;
  /** `null` mientras el cajero no elige doctor (bloquea el cobro si es obligatorio). */
  provider: ServiceProvider | null;
  quantity: number;
  discountAmount: number;
}

export type CartLine = CartProductLine | CartServiceLine;

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

interface SaleItemCommon {
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

/**
 * Partida de venta. Unión discriminada: un producto mueve inventario, un
 * servicio no tiene stock y puede generar comisión. Las ventas anteriores a los
 * servicios no traen `kind`; al leerlas se asume `'product'`.
 */
export interface SaleProductItem extends SaleItemCommon {
  kind?: 'product';
  productId: string;
}

export interface SaleServiceItem extends SaleItemCommon {
  kind: 'service';
  serviceId: string;
  /** Doctor al que se acreditó la comisión. */
  providerId?: string | null;
  providerName?: string | null;
  /** Congelados al cobrar: la tarifa del catálogo puede cambiar después. */
  commissionRate?: number;
  commissionAmount?: number;
}

export type SaleItem = SaleProductItem | SaleServiceItem;

/**
 * `true` si la partida mueve inventario. Una venta anterior a los servicios no
 * trae `kind`, y esas partidas son productos — este es el único lugar donde se
 * escribe esa equivalencia, para no repetir `item.kind ?? 'product'` disperso.
 */
export function isSaleProductItem(item: SaleItem): item is SaleProductItem {
  return (item.kind ?? 'product') === 'product';
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
  voidedBy?: string | null;
  /**
   * El servidor no pudo registrar la venta (stock, producto) y quedó guardada
   * en `unreconciledSales`: el dinero entró y el movimiento está, pero el
   * inventario no cuadra hasta que alguien lo concilie.
   */
  unreconciledAt?: Date | null;
  unreconciledReason?: string | null;
  createdAt: Date;
  /**
   * Totales denormalizados por rama. El corte y los reportes los leen sin
   * recorrer partidas. Ausentes en ventas anteriores a los servicios: ahí
   * `pharmacyTotal ?? total` y `servicesTotal ?? 0` las tratan como 100 %
   * farmacia.
   */
  pharmacyTotal?: number | null;
  servicesTotal?: number | null;
  pharmacyCashAmount?: number | null;
  servicesCashAmount?: number | null;
  commissionTotal?: number | null;
  /** Id del documento en Firestore una vez sincronizada; ausente mientras es solo local. */
  remoteId?: string | null;
  /** Sigue en la cola local, pendiente de subirse al backend en el próximo sync. */
  pendingPush?: boolean;
}

export interface Customer {
  id: string;
  name: string;
  rfc?: string;
  phone?: string;
  email?: string;
}

export type CashMovementType = 'deposit' | 'withdrawal' | 'expense';

/** Categorías del módulo de gastos; solo aplican cuando `type === 'expense'`. */
export type ExpenseCategory =
  | 'salary' | 'food' | 'rent' | 'contingency' | 'electricity' | 'supplies' | 'supplier' | 'other';

export interface CashMovement {
  id: string;
  /**
   * `null` en la caja de la farmacia: entrada o salida de efectivo hecha por un
   * admin sin turno abierto, que por lo mismo no entra a ningún corte.
   */
  cashSessionId: string | null;
  type: CashMovementType;
  amount: number;
  reason: string;
  /** Solo poblado cuando `type === 'expense'`. */
  category?: ExpenseCategory | null;
  /** Obligatoria cuando `category` es `supplies`/`supplier`/`other`. */
  description?: string | null;
  createdBy: string;
  /** Correo de quien lo registró; solo lo llena la base local, para el historial. */
  createdByLabel?: string | null;
  createdAt: Date;
  /** Solo tiene sentido en el POS local-first; el admin-web (100% online) no lo usa. */
  pendingPush?: boolean;
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

/** Bloque independiente de servicios dentro del corte. */
export interface CashServicesTotals {
  count: number;
  voidedCount: number;
  byMethod: {
    cash: CashMethodTotals;
    card: CashMethodTotals;
    transfer: CashMethodTotals;
    mixed: CashMethodTotals;
  };
  total: number;
  commissionTotal: number;
  /** Efectivo del turno atribuible a servicios (reparto "servicios primero"). */
  cashInDrawer: number;
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
  /**
   * Ausente cuando el turno no vio servicios —y también en todo turno cerrado
   * antes de esta funcionalidad, cuyo resumen quedó congelado sin el bloque.
   * Toda lectura tiene que tolerar que no exista.
   */
  services?: CashServicesTotals;
}

export type CashAdjustmentStatus = 'pending' | 'approved' | 'rejected';

export interface CashSession {
  id: string;
  openedBy: string;
  openingAmount: number;
  /** Esperado de FARMACIA. El del cajón completo es este más el de servicios. */
  expectedCashAmount: number | null;
  expectedServicesCashAmount?: number | null;
  countedCashAmount: number | null;
  cashDifference: number | null;
  summary: CashSessionSummary | null;
  openedAt: Date;
  closedAt: Date | null;
  /** `true` si `|cashDifference| >= 0.01` al cerrar y el cierre no fue automático. */
  hasPendingAdjustment?: boolean;
  adjustmentStatus?: CashAdjustmentStatus | null;
  adjustmentReviewedBy?: string | null;
  adjustmentReviewedAt?: Date | null;
  adjustmentNote?: string | null;
  /** `true` si el turno se cerró solo por expiración de sesión (24:00 CDMX). */
  autoClosedByExpiry?: boolean;
  /** Solo tiene sentido en el POS local-first; el admin-web (100% online) no lo usa. */
  remoteId?: string | null;
  pendingPush?: boolean;
  pushError?: string | null;
  pendingClosePush?: boolean;
  closePushError?: string | null;
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
