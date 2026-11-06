import {
  CashAdjustmentStatus,
  CashMovement,
  CashMovementType,
  CashSession,
  CashSessionSummary,
  CouponDto,
  ExpenseCategory,
  InvoiceRagData,
  InvoiceRagDocument,
  InvoiceRagDocumentType,
  InvoiceRagEmbedding,
  InvoiceRagSearchHit,
  InvoiceRagStatus,
  PaymentMethod,
  PosBlocker,
  PosDiagnosticsInput,
  PosSyncLogEntry,
  Product,
  ProductBatch,
  ProductFieldsPayload,
  PromotionDto,
  Sale,
} from '../../shared/models';

export interface PendingStockEntry {
  id: string;
  productId: string;
  /** `CreateStockEntryPayload` tal como se reenvía a `POST /stock-entries`. */
  payload: unknown;
  pushError: string | null;
}

/**
 * Campos de catálogo tal como suben: `controlledGroup: null` es la
 * desclasificación (SPEC 64), que viaja solo cuando la foto del servidor tenía grupo.
 */
export type CatalogPushFields = Partial<Omit<ProductFieldsPayload, 'controlledGroup'>> & {
  controlledGroup?: ProductFieldsPayload['controlledGroup'] | null;
};

/** Producto pendiente de subir desde el módulo de edición de catálogo. */
export interface PendingCatalogProduct {
  id: string;
  /** `null` = alta nueva (nunca sincronizó); si tiene valor, es una edición. */
  remoteId: string | null;
  fields: ProductFieldsPayload;
  /**
   * Edición con foto (SPEC 56): solo los campos que difieren de `baseFields`;
   * eso es lo que sube el PATCH. `null`/ausente = sin foto (alta, o producto de
   * antes de la migración): sube `fields` completo, como siempre.
   */
  changes?: CatalogPushFields | null;
  /** `updatedAt` remoto de la foto; `null` sin foto o con "Forzar el mío". */
  baseUpdatedAt?: string | null;
  /** Campos de catálogo completos tal como quedarán arriba; la foto nueva al confirmar. */
  snapshot?: CatalogPushFields;
  catalogPushError: string | null;
  /** `updatedAt` del producto al leer la cola; se devuelve a `markCatalogSynced`. */
  version?: string | null;
}

/** Lo que el servidor ya tiene tras un push de catálogo: renueva la foto `baseFields`. */
export interface CatalogSyncedSnapshot {
  fields: CatalogPushFields;
  /** `updatedAt` que respondió el servidor (ISO o `Timestamp` serializado). */
  remoteUpdatedAt?: unknown;
}

/** Valor actual del panel en un 409 `CATALOG_CONFLICT` (SPEC 56). */
export interface CatalogConflictCurrent {
  salePrice: number | null;
  isActive: boolean | null;
}

/** "Usar el del panel" o "Forzar el mío". */
export type CatalogConflictChoice = 'panel' | 'mine';

/** Respuesta de `GET /v1/products/:id/stock` (SPEC 57), tal como se guarda en SQLite. */
export interface ProductStockSnapshot {
  id: string;
  totalStock: number;
  updatedAt?: unknown;
  /** Solo lotes con piezas; misma forma que los de `/products/sync`. */
  batches: Array<{ id: string; lotNumber?: string | null; expiryDate?: unknown; quantity: number }>;
}

/** Producto y lotes tras guardar la existencia fresca (lo pendiente ya descontado). */
export interface ProductStockRefreshResult {
  product: Product;
  batches: ProductBatch[];
}

export interface StockEntryLocalResult {
  product: Product;
  stock: number;
}

/** Todo lo que el renderer ya calculó (tender, fiscal, controlados) para una venta local. */
export interface LocalSaleInput {
  idempotencyKey: string;
  folio: string;
  items: Sale['items'];
  subtotal: number;
  discountTotal: number;
  total: number;
  taxSummary: Sale['taxSummary'];
  paymentMethod: PaymentMethod;
  amountReceived: number | null;
  change: number | null;
  cashAmount: number | null;
  cardAmount: number | null;
  cardPaymentReference: string | null;
  cashierId: string;
  /** Correo del cajero, para que la bitácora no muestre un uid. */
  cashierLabel?: string;
  cashSessionId: string;
  customerId: string | null;
  customerName: string | null;
  prescription: Sale['prescription'];
  prescriptionRetained: boolean;
  controlledGroups: Sale['controlledGroups'];
  billing: Sale['billing'];
  invoiceStatus: Sale['invoiceStatus'];
  /**
   * Totales denormalizados por rama (farmacia / servicios). El corte los lee
   * sin recorrer partidas; el backend los recalcula al sincronizar.
   */
  pharmacyTotal?: number;
  servicesTotal?: number;
  pharmacyCashAmount?: number;
  servicesCashAmount?: number;
  commissionTotal?: number;
  /** Cupón que se imprimió en el ticket (SPEC 47). */
  coupon?: Sale['coupon'];
  /** Cuerpo crudo que se reenvía sin cambios a `POST /sales` al sincronizar. */
  payload: unknown;
}

export interface PendingSale extends Sale {
  /**
   * `null` cuando la venta todavía no se puede enviar: su turno o alguno de sus
   * productos no tiene `remoteId`. Solo las lecturas de UI reciben estas filas
   * (para que la cajera las vea y el conteo no mienta); el push las omite.
   */
  payload: unknown;
  pushError: string | null;
  /** Qué falta para poder enviarla. Solo viene si `payload` es `null`. */
  esperandoPor?: 'turno' | 'catalogo';
}

export interface ListSalesLocalFilters {
  cashSessionId?: string;
  /** Solo las de este cajero. Sin él vienen las de todos los que usaron el equipo. */
  cashierId?: string;
  includeVoided?: boolean;
  from?: string;
  to?: string;
  search?: string;
}

export interface SyncRunStatus {
  entity: string;
  direction: 'pull' | 'push';
  status: string;
  cursor: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SyncRunInput {
  entity: string;
  direction: 'pull' | 'push';
  status: 'ok' | 'error';
  cursor?: string | null;
  errorMessage?: string | null;
}

/** Movimiento asentado en la bitácora local de una venta. */
export interface SaleMovement {
  id: string;
  saleId: string;
  /** `sale` (cobrada) | `void` (anulada). */
  type: 'sale' | 'void';
  userId: string;
  /** Correo del cajero en el momento del movimiento. */
  userLabel: string | null;
  reason: string | null;
  /** ISO. */
  occurredAt: string;
}

export interface LocalCashSessionInput {
  openedBy: string;
  /** Correo del cajero al abrir; para que la auditoría no muestre un uid. */
  openedByLabel?: string;
  openingAmount: number;
}

/** Turno con su alta (`POST /cash-sessions`) pendiente de subir. */
export interface PendingCashSession extends CashSession {
  pushError: string | null;
}

/** Turno ya remoto cuyo cierre local todavía no se refleja en el backend. */
export interface PendingCashSessionClose extends CashSession {
  remoteId: string;
  closePushError: string | null;
}

export interface LocalCashSessionCloseInput {
  countedCashAmount: number;
  closedBy: string;
  closedByLabel?: string;
  /** `true` solo cuando lo dispara `AuthService.autoCloseForExpiry()`, nunca el cajero. */
  autoClosedByExpiry?: boolean;
}

export interface LocalCashMovementInput {
  type: CashMovementType;
  amount: number;
  reason: string;
  category?: ExpenseCategory;
  description?: string;
  createdBy: string;
  createdByLabel?: string;
}

/**
 * Movimiento (depósito/retiro/gasto) pendiente de subir. `cashSessionRemoteId`
 * es `null` en los de la caja de la farmacia, que no cuelgan de ningún turno y
 * suben por `POST /cash-sessions/movements`.
 */
/**
 * Registro que el servidor **rechazó** al sincronizar. No se reintenta solo:
 * alguien tiene que leer el motivo y decidir, así que la caja debe mostrarlo.
 */
export interface BlockedSyncRecord {
  kind: 'sale' | 'cashMovement' | 'cashSession' | 'stockEntry' | 'product';
  id: string;
  /** Folio, motivo del gasto o tipo de operación: con qué lo reconoce el cajero. */
  label: string;
  /** Importe o dato de apoyo. */
  detail: string;
  occurredAt: string | Date;
  reason: string;
  /** Causa ya clasificada (`electron/db/blocked-diagnosis.js`); ver `core/sync/sync-diagnosis.ts`. */
  diagnosis?: BlockedDiagnosis;
  /**
   * Solo ventas: lo que la detiene en la caja (turno o productos sin
   * `remoteId`). Vacío si el bloqueo es un rechazo del servidor.
   */
  blockers?: PosBlocker[];
  /**
   * Solo productos con 409 `CATALOG_CONFLICT` (SPEC 56): lo que dice el panel.
   * Con él se ofrecen "Usar el del panel" y "Forzar el mío".
   */
  conflict?: CatalogConflictCurrent;
}

export type BlockedCode =
  | 'turno-sin-subir'
  | 'turno-rechazado'
  | 'producto-sin-subir'
  | 'producto-rechazado'
  | 'producto-no-encontrado'
  | 'listo-para-reintentar'
  | 'entrada-a-medias'
  | 'entrada-en-curso'
  | 'entrada-posible-duplicada'
  | 'turno-duplicado'
  | 'turno-abierto-existente'
  | 'turno-ajeno'
  | 'turno-cerrado'
  | 'turno-no-encontrado'
  | 'sin-stock'
  | 'promocion-no-vigente'
  | 'catalogo-en-conflicto'
  | 'producto-duplicado'
  | 'desconocido';

export interface BlockedDiagnosis {
  code: BlockedCode;
  /**
   * Código estable del servidor (SPEC 49) que la caja guardó con el motivo, si
   * vino (`SyncErrorCode`, o uno que esta versión no conoce). Manda sobre el texto.
   */
  syncCode?: string;
  /** Lo que la venta espera: con qué nombre lo reconoce el cajero. */
  dependency?: { kind: 'cashSession' | 'product'; label: string };
}


/** Venta lista para `POST /sales/unreconciled` aunque su turno nunca haya subido. */
export interface UnreconciledSaleDraft extends Omit<Sale, 'cashSessionId'> {
  /** Remoto del turno, o `null` si nunca subió (entonces no se manda). */
  cashSessionId: string | null;
  payload: Record<string, unknown>;
}

export interface SyncLogInput {
  level: 'info' | 'warn' | 'error';
  entity: string;
  message: string;
  ref?: string | null;
}

export interface PendingCashMovement extends CashMovement {
  cashSessionRemoteId: string | null;
  /**
   * Id en el servidor. Presente cuando el movimiento ya subió y vuelve a estar
   * pendiente por una **corrección**: distingue el alta (POST) de la enmienda
   * (PATCH), que es lo que evita duplicar el gasto al reenviarlo.
   */
  remoteId: string | null;
  pushError: string | null;
}

/**
 * Efectivo que debe haber en la caja: lo contado en el último corte más o menos
 * lo que se movió entre turnos. No es la suma de todos los movimientos —los de
 * un turno ya quedaron dentro del conteo de su corte, y volver a restarlos los
 * contaría dos veces.
 */
export interface CashOnHand {
  amount: number;
  lastClosedAt: string | Date | null;
  countedAtLastClose: number | null;
  /** Neto de los movimientos sin turno posteriores al último cierre. */
  movementsSinceClose: number;
}

declare global {
  interface Window {
    electronAPI?: {
      log?: {
        write: (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => Promise<void>;
        getDir: () => Promise<string>;
      };
      app: {
        /**
         * La ventana pidió cerrarse: el renderer decide si sale. Devuelve la baja
         * del listener. Si nadie responde, el proceso principal cierra a los 10 s.
         */
        onCloseRequested: (handler: () => void) => () => void;
        /** Frena el cierre por timeout mientras el cajero decide. */
        closePending: () => Promise<void>;
        confirmClose: () => Promise<void>;
        cancelClose: () => Promise<void>;
      };
      getAppVersion: () => Promise<string>;
      getDeviceInfo: () => Promise<unknown>;
      openCashDrawer: (printerName: string) => Promise<boolean>;
      products?: {
        /** SPEC 57: guarda la existencia fresca de un producto; `null` si no está en la caja. */
        refreshOne: (
          remoteId: string,
          snapshot: ProductStockSnapshot,
        ) => Promise<ProductStockRefreshResult | null>;
      };
      catalog: {
        search: (term: string) => Promise<Product[]>;
        /** Productos (activos o no) con el mismo nombre; el servidor no admite repetidos. */
        findByName: (name: string, excludeId?: string | null) => Promise<Product[]>;
        getByBarcode: (code: string) => Promise<Product | null>;
        getByIds: (ids: string[]) => Promise<Product[]>;
        /** Local-first de `POST /stock-entries`; acepta el mismo `CreateStockEntryPayload`. */
        recordStockEntry: (payload: unknown) => Promise<StockEntryLocalResult>;
        upsertMany: (products: unknown[]) => Promise<{ count: number }>;
        /** Lotes (local + sincronizados) de un producto, para caducidad/FEFO al agregar al carrito. */
        getBatchesByProduct: (productId: string) => Promise<ProductBatch[]>;
        /**
         * `includeWaiting`: incluye también las entradas que esperan a que suba su
         * producto (sin `remoteId`), que no se envían pero sí cuentan como pendientes.
         */
        getPendingStockEntries: (options?: { includeWaiting?: boolean }) => Promise<PendingStockEntry[]>;
        /** Lotes que el servidor rechazó: salen en el panel "Rechazados al sincronizar". */
        listBlockedStockEntries: () => Promise<BlockedSyncRecord[]>;
        clearStockEntryPushError: (batchLocalId: string) => Promise<void>;
        /** Borra un lote que nunca subió y descuenta sus piezas del stock local. */
        discardStockEntry: (batchLocalId: string) => Promise<void>;
        /**
         * "Sí, es otra partida" (SPEC 58): reenvía la entrada con `confirmDuplicate: true`
         * tras un 409 `ENTRY_POSSIBLE_DUPLICATE`. `false` si ya no estaba pendiente.
         */
        confirmDuplicateStockEntry: (batchLocalId: string) => Promise<boolean>;
        /** Altas o ediciones de catálogo que el servidor rechazó. */
        listBlockedProducts: () => Promise<BlockedSyncRecord[]>;
        markStockEntrySynced: (batchLocalId: string, remoteProductId?: string | null) => Promise<void>;
        markStockEntryPushFailed: (batchLocalId: string, message: string) => Promise<void>;
        /** Acepta id local o `remoteId`; devuelve `null` si no existe. */
        getProductById: (id: string) => Promise<Product | null>;
        createCatalogProduct: (fields: ProductFieldsPayload) => Promise<Product>;
        updateCatalogProduct: (id: string, fields: CatalogPushFields) => Promise<Product>;
        getPendingCatalogPush: () => Promise<PendingCatalogProduct[]>;
        markCatalogSynced: (
          localId: string,
          remoteId?: string | null,
          pushedVersion?: string | null,
          synced?: CatalogSyncedSnapshot | null,
        ) => Promise<void>;
        /** 409 `CATALOG_CONFLICT`: bloquea la edición visible con el valor del panel. */
        markCatalogConflict: (localId: string, current: CatalogConflictCurrent) => Promise<void>;
        /** `false` si el producto no tiene conflicto que resolver. */
        resolveCatalogConflict: (localId: string, choice: CatalogConflictChoice) => Promise<boolean>;
        markCatalogPushFailed: (localId: string, message: string) => Promise<void>;
        clearCatalogPushError: (localId: string) => Promise<void>;
        /**
         * Limpia los errores de alta del producto (catálogo y lotes) para que su
         * cola lo reintente. `false` si no existe en local.
         */
        retryProductPush: (localId: string) => Promise<boolean>;
      };
      sales: {
        createLocal: (sale: LocalSaleInput) => Promise<Sale>;
        list: (filters?: ListSalesLocalFilters) => Promise<Sale[]>;
        /** `ownerUid`: solo lo del cajero indicado. Sin él (admin) sube todo. */
        /**
         * `contarIntentos`: solo el push real. Las lecturas de la UI no deben
         * consumir el cupo de `payloadResolveAttempts`.
         */
        getPendingPush: (
          filters?: { ownerUid?: string; contarIntentos?: boolean },
        ) => Promise<PendingSale[]>;
        listBlocked: (filters?: { ownerUid?: string }) => Promise<BlockedSyncRecord[]>;
        /**
         * Anuladas que nunca llegaron al servidor: se crean y se anulan allá,
         * para que el movimiento quede completo.
         */
        getPendingVoided: (filters?: { ownerUid?: string }) => Promise<
          Array<PendingSale & { voidedAt: string | null; voidedBy: string | null }>
        >;
        markSynced: (localId: string, remoteId: string, remoteFolio: string) => Promise<void>;
        markPushFailed: (localId: string, message: string) => Promise<void>;
        /** Bloqueadores de una venta; `null` si no existe. */
        diagnose: (saleId: string) => Promise<PosBlocker[] | null>;
        /** Payload para conciliación, sin turno local; `null` si no existe. */
        prepareUnreconciled: (localId: string) => Promise<UnreconciledSaleDraft | null>;
        /** Guardada en `unreconciledSales` del servidor: sale de la cola, no del historial. */
        markUnreconciled: (localId: string, reason: string) => Promise<void>;
        voidLocal: (
          localId: string,
          voidedBy: string,
          voidedByLabel?: string,
          reason?: string,
        ) => Promise<Sale | null>;
        /** Bitácora de la venta: un renglón por movimiento, con quién y cuándo. */
        listMovements: (saleId: string) => Promise<SaleMovement[]>;
        clearPushError: (localId: string) => Promise<void>;
        discard: (localId: string) => Promise<void>;
        /** Ventas ya sincronizadas que se anularon en local durante la carrera de `markSynced`. */
        getNeedingRemoteVoid: (filters?: { ownerUid?: string }) => Promise<
          Array<{ id: string; remoteId: string; voidedAt: string | null; voidedBy: string | null }>
        >;
        /** Anulada sin red: queda pendiente de anularse también en el servidor. */
        markNeedsRemoteVoid: (localId: string) => Promise<void>;
        markRemoteVoided: (localId: string) => Promise<void>;
      };
      sync: {
        getStatus: () => Promise<SyncRunStatus[]>;
        recordRun: (run: SyncRunInput) => Promise<{ id: string }>;
      };
      /** Bitácora local de sincronización. `append` nunca lanza. */
      syncLog: {
        append: (entry: SyncLogInput) => Promise<PosSyncLogEntry | null>;
        list: (limit?: number) => Promise<PosSyncLogEntry[]>;
      };
      diagnostics: {
        /** Foto para `POST /pos/diagnostics`, con la identidad del equipo. */
        buildSnapshot: () => Promise<PosDiagnosticsInput>;
      };
      cashSessions: {
        /** El único turno sin cerrar de este cajero, si existe. */
        getOpenLocal: (userId: string) => Promise<CashSession | null>;
        /**
         * Turno abierto en este equipo sin importar quién lo abrió. Para las
         * pantallas que mueven el efectivo del cajón sin ser su cajero (la caja
         * de la farmacia es solo de admin).
         */
        getOpenLocalAnyUser: () => Promise<CashSession | null>;
        createLocal: (input: LocalCashSessionInput) => Promise<CashSession>;
        /** Efectivo esperado en vivo, sin red — recalculado en cada llamada. */
        getLiveSummary: (
          sessionId: string,
        ) => Promise<{
          summary: CashSessionSummary;
          /** Esperado de farmacia. */
          expectedCashAmount: number;
          expectedServicesCashAmount: number;
        }>;
        /**
         * Efectivo que quedó en el cajón tras el último cierre, ajustado por
         * los movimientos de caja hechos entre turnos. Precarga el fondo al
         * abrir el siguiente turno.
         */
        getCashOnHand: () => Promise<CashOnHand>;
        closeLocal: (sessionId: string, input: LocalCashSessionCloseInput) => Promise<CashSession>;
        getPendingPush: (filters?: { ownerUid?: string }) => Promise<PendingCashSession[]>;
        listBlocked: () => Promise<BlockedSyncRecord[]>;
        getPendingClosePush: (
          /**
           * `sinHijosPendientes`: excluye turnos con ventas o gastos aún en cola,
           * para no cerrarlos antes que sus propios movimientos.
           */
          filters?: { ownerUid?: string; sinHijosPendientes?: boolean },
        ) => Promise<PendingCashSessionClose[]>;
        /**
         * `conflict: true` si ese `remoteId` ya es de otro turno local (el
         * turno anterior sigue abierto en el backend): no se adopta, se marca
         * `pushError` y lo resuelve un admin.
         */
        markCreateSynced: (
          localId: string,
          remoteId: string,
        ) => Promise<{ conflict: boolean; requeuedClose?: boolean }>;
        markCloseSynced: (
          localId: string,
          values: { expectedCashAmount?: number; cashDifference?: number },
        ) => Promise<void>;
        markPushFailed: (localId: string, message: string) => Promise<void>;
        markClosePushFailed: (localId: string, message: string) => Promise<void>;
        clearPushError: (localId: string) => Promise<void>;
        /** Limpia errores de alta y cierre para reintentar. `false` si no existe. */
        retryPush: (localId: string) => Promise<boolean>;
        clearClosePushError: (localId: string) => Promise<void>;
        /** Todos los turnos locales, para la pantalla de auditoría del POS. */
        listLocal: (filters?: { openedBy?: string; adjustmentStatus?: CashAdjustmentStatus }) => Promise<CashSession[]>;
        /** Solo la usa el pull — nunca el cajero. La aprobación vive en el backend. */
        updateAdjustmentStatus: (
          localId: string,
          values: {
            status: CashAdjustmentStatus;
            reviewedBy?: string | null;
            reviewedAt?: string | null;
            note?: string | null;
          },
        ) => Promise<void>;
      };
      /**
       * Catálogos **solo-pull**: se leen en la caja y se administran en el admin
       * web. No hay `create` ni cola de push, y el `id` local es el de Firestore.
       */
      pharmacyServices: {
        /** Sin término devuelve el catálogo activo completo: son decenas. */
        list: (term?: string) => Promise<PharmacyServiceDto[]>;
        listProviders: () => Promise<ServiceProviderDto[]>;
        upsertMany: (services: unknown[]) => Promise<{ count: number }>;
        upsertProviders: (providers: unknown[]) => Promise<{ count: number }>;
      };
      /** Promociones **solo-pull**; `listActive` ya filtra por vigencia con la hora local. */
      promotions: {
        listActive: () => Promise<PromotionDto[]>;
        upsertMany: (promotions: unknown[]) => Promise<{ count: number }>;
      };
      /**
       * Cupones **solo-pull** (SPEC 47). `findByCode` normaliza el código y
       * devuelve también los inactivos: la pantalla dice por qué no aplica.
       */
      coupons: {
        findByCode: (code: string) => Promise<CouponDto | null>;
        upsertMany: (coupons: unknown[]) => Promise<{ count: number }>;
      };
      /** Archivos en `userData/invoice-rag/`; el renderer manda bytes, nunca rutas. */
      invoiceRag: {
        register: (input: {
          fileName: string;
          mimeType: string;
          bytes: Uint8Array;
          createdBy: string;
        }) => Promise<{ document: InvoiceRagDocument; duplicate: boolean }>;
        readFile: (id: string) => Promise<{ fileName: string; mimeType: string; bytes: Uint8Array }>;
        list: (filters?: {
          status?: InvoiceRagStatus;
          documentType?: InvoiceRagDocumentType;
          term?: string;
          page?: number;
          limit?: number;
        }) => Promise<{ items: InvoiceRagDocument[]; total: number }>;
        getById: (id: string) => Promise<InvoiceRagDocument | null>;
        saveExtraction: (id: string, input: { data: InvoiceRagData; model: string }) => Promise<InvoiceRagDocument>;
        markFailed: (id: string, message: string) => Promise<InvoiceRagDocument>;
        confirm: (
          id: string,
          input: { data: InvoiceRagData; contentText: string; embedding: InvoiceRagEmbedding },
        ) => Promise<InvoiceRagDocument>;
        search: (input: {
          vector: number[];
          model: string;
          limit?: number;
          minScore?: number;
        }) => Promise<InvoiceRagSearchHit[]>;
        markUploaded: (id: string, storagePath: string) => Promise<InvoiceRagDocument>;
        applyStock: (
          id: string,
          input: { entries: unknown[]; appliedBy: string },
        ) => Promise<InvoiceRagDocument>;
        remove: (id: string) => Promise<{ id: string }>;
      };
      cashMovements: {
        /** `cashSessionId` en `null`: caja de la farmacia, movimiento sin turno. */
        add: (cashSessionId: string | null, input: LocalCashMovementInput) => Promise<CashMovement>;
        /**
         * Corrige un gasto del turno. Vuelve a marcarlo pendiente de subir, así
         * que la corrección llega también al reporte del admin.
         */
        updateExpense: (
          id: string,
          patch: {
            amount?: number;
            reason?: string;
            category?: ExpenseCategory;
            description?: string;
          },
        ) => Promise<CashMovement>;
        listForSession: (cashSessionId: string) => Promise<CashMovement[]>;
        /**
         * Cerrojo consultado **justo antes** de emitir el POST: `false` si el
         * turno ya cerró en el servidor. En ese caso deja el movimiento
         * bloqueado con su motivo y no se manda nada.
         */
        assertPushable: (id: string) => Promise<boolean>;
        /** Todos los movimientos locales, para la pantalla de auditoría de gastos del POS. */
        listAllLocal: (filters?: {
          type?: CashMovementType;
          category?: ExpenseCategory;
          /** Alcance del reporte de turno. */
          cashSessionId?: string;
          /** ISO; alcance del reporte del día. */
          from?: string;
          to?: string;
          limit?: number;
          /** Filas a saltar; con `limit` forma la paginación contra SQLite. */
          offset?: number;
        }) => Promise<CashMovement[]>;
        /** Total con los mismos filtros, para que el paginador sepa cuántas páginas hay. */
        countAllLocal: (filters?: {
          type?: CashMovementType;
          category?: ExpenseCategory;
        }) => Promise<number>;
        getPendingPush: (filters?: { ownerUid?: string }) => Promise<PendingCashMovement[]>;
        listBlocked: () => Promise<BlockedSyncRecord[]>;
        /** Borra un movimiento rechazado que nunca existió en el servidor. */
        discard: (id: string) => Promise<void>;
        markSynced: (localId: string, remoteId?: string | null) => Promise<void>;
        markPushFailed: (localId: string, message: string) => Promise<void>;
        clearPushError: (localId: string) => Promise<void>;
      };
    };
  }
}
