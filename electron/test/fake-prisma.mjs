/**
 * Prisma falso en memoria para probar `electron/db/*.js` sin SQLite real.
 *
 * Solo implementa las operaciones y los filtros que esos módulos usan de
 * verdad (`where` por igualdad, `{ not: null }`, `{ in: [...] }`, los operadores
 * `OR`/`AND`/`NOT`, y la relación `cashSession: { remoteId: { not: null } }`). No pretende ser un Prisma
 * completo: si un módulo empieza a usar un filtro nuevo, esta ayuda debe
 * crecer con él — que la prueba falle es preferible a que pase por accidente.
 */

let sequence = 0;

function nextId(prefix) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function matchesCondition(value, condition) {
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
    if ('not' in condition) {
      return condition.not === null ? value !== null && value !== undefined : value !== condition.not;
    }
    if ('in' in condition) {
      return condition.in.includes(value);
    }
    // `contains` de Prisma. SQLite compara sin distinguir mayúsculas en LIKE
    // para ASCII, que es como se comporta la búsqueda real del catálogo.
    if ('contains' in condition) {
      return typeof value === 'string' &&
        value.toLowerCase().includes(String(condition.contains).toLowerCase());
    }
    // Comparadores de rango: `getCashOnHand` filtra los movimientos de caja
    // posteriores al último cierre con `createdAt: { gt: fecha }`.
    for (const [op, compare] of [
      ['gt', (a, b) => a > b],
      ['gte', (a, b) => a >= b],
      ['lt', (a, b) => a < b],
      ['lte', (a, b) => a <= b],
    ]) {
      if (op in condition) {
        return value !== null && value !== undefined && compare(value, condition[op]);
      }
    }
  }
  return value === condition;
}

function matchesWhere(row, where, db) {
  return Object.entries(where ?? {}).every(([key, condition]) => {
    // Operadores lógicos de Prisma. `OR` lo usan `getPendingPush`, la búsqueda de
    // productos y la conciliación de ventas; sin esto la clave caía al comparador
    // de igualdad (`null === [...]`) y descartaba **todas** las filas.
    if (key === 'OR') {
      return condition.some((clause) => matchesWhere(row, clause, db));
    }
    if (key === 'AND') {
      const clauses = Array.isArray(condition) ? condition : [condition];
      return clauses.every((clause) => matchesWhere(row, clause, db));
    }
    if (key === 'NOT') {
      // `NOT: {a, b}` niega la conjunción; `NOT: [a, b]` niega cada una. Las dos
      // formas equivalen a "ninguna cláusula coincide".
      const clauses = Array.isArray(condition) ? condition : [condition];
      return !clauses.some((clause) => matchesWhere(row, clause, db));
    }
    if (key === 'cashSession') {
      const parent = db.cashSession.rows.find((session) => session.id === row.cashSessionId);
      return parent ? matchesWhere(parent, condition, db) : false;
    }
    return matchesCondition(row[key] ?? null, condition);
  });
}

/** Aplica `data`, resolviendo los operadores `increment`/`decrement` de Prisma. */
function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('increment' in value) { row[key] = (row[key] ?? 0) + value.increment; continue; }
      if ('decrement' in value) { row[key] = (row[key] ?? 0) - value.decrement; continue; }
    }
    row[key] = value;
  }
}

/** `where` de `findUnique`/`update`/`upsert`/`delete`: igualdad sobre la llave única que sea (`id`, `fileSha256`, `documentId`). */
function matchesKey(row, where) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function sortRows(rows, orderBy) {
  if (!orderBy) {
    return rows;
  }
  const [field, direction] = Object.entries(orderBy)[0];
  return [...rows].sort((a, b) => {
    const left = a[field] ?? 0;
    const right = b[field] ?? 0;
    if (left === right) return 0;
    const cmp = left < right ? -1 : 1;
    return direction === 'desc' ? -cmp : cmp;
  });
}

/**
 * Relaciones que el fake sabe resolver: `create` anidado (`items: {create: [...]}`)
 * e `include`. Cada entrada dice en qué modelo viven los hijos y por qué campo
 * cuelgan del padre.
 */
const RELATIONS = {
  sale: {
    items: { model: 'saleItem', foreignKey: 'saleId' },
    movements: { model: 'saleMovement', foreignKey: 'saleId' },
  },
};

function createModel(db, name, defaults) {
  const model = {
    rows: [],
    async create({ data, include }) {
      const relations = RELATIONS[name] ?? {};
      const own = {};
      const nested = {};
      for (const [key, value] of Object.entries(data)) {
        if (relations[key]) {
          nested[key] = value;
        } else {
          own[key] = value;
        }
      }
      const row = { id: own.id ?? nextId(name), ...defaults(), ...own };
      model.rows.push(row);

      for (const [key, value] of Object.entries(nested)) {
        const { model: childModel, foreignKey } = relations[key];
        const hijos = Array.isArray(value?.create) ? value.create : value?.create ? [value.create] : [];
        for (const hijo of hijos) {
          await db[childModel].create({ data: { ...hijo, [foreignKey]: row.id } });
        }
      }
      return model.attachIncludes({ ...row }, include);
    },
    /** Cuelga los hijos pedidos con `include: { items: true }`. */
    attachIncludes(row, include) {
      const relations = RELATIONS[name] ?? {};
      for (const [key, wanted] of Object.entries(include ?? {})) {
        if (!wanted || !relations[key]) continue;
        const { model: childModel, foreignKey } = relations[key];
        row[key] = db[childModel].rows.filter((child) => child[foreignKey] === row.id).map((c) => ({ ...c }));
      }
      return row;
    },
    async findFirst({ where, orderBy }) {
      const found = sortRows(model.rows.filter((row) => matchesWhere(row, where, db)), orderBy)[0];
      return found ? { ...found } : null;
    },
    /** Lo usa `getPendingClosePush` para saber si al turno le quedan hijos en cola. */
    async count({ where } = {}) {
      return model.rows.filter((row) => matchesWhere(row, where, db)).length;
    },
    async findUnique({ where, include }) {
      const found = model.rows.find((row) => matchesKey(row, where));
      return found ? model.attachIncludes({ ...found }, include) : null;
    },
    async findMany({ where, orderBy, include, take, skip = 0 } = {}) {
      const ordered = sortRows(model.rows.filter((row) => matchesWhere(row, where, db)), orderBy).slice(skip);
      const rows = take ? ordered.slice(0, take) : ordered;
      return rows.map((row) => {
        const copy = { ...row };
        if (include?.cashSession) {
          const parent = db.cashSession.rows.find((session) => session.id === row.cashSessionId);
          copy.cashSession = parent ? { remoteId: parent.remoteId ?? null } : null;
        }
        return copy;
      });
    },
    async update({ where, data, include }) {
      const found = model.rows.find((row) => matchesKey(row, where));
      if (!found) {
        // Mismo fallo que Prisma real: así una prueba nota un id equivocado.
        throw new Error('Record to update not found.');
      }
      const relations = RELATIONS[name] ?? {};
      for (const [key, value] of Object.entries(data)) {
        if (relations[key]) {
          const { model: childModel, foreignKey } = relations[key];
          const hijos = Array.isArray(value?.create) ? value.create : value?.create ? [value.create] : [];
          for (const hijo of hijos) {
            await db[childModel].create({ data: { ...hijo, [foreignKey]: found.id } });
          }
          continue;
        }
        found[key] = value;
      }
      return model.attachIncludes({ ...found }, include);
    },
    async upsert({ where, create, update }) {
      const found = model.rows.find((row) => matchesKey(row, where));
      if (!found) {
        return model.create({ data: { ...where, ...create } });
      }
      applyData(found, update);
      return { ...found };
    },
    async delete({ where }) {
      const index = model.rows.findIndex((row) => matchesKey(row, where));
      if (index === -1) {
        throw new Error('Record to delete does not exist.');
      }
      const [borrado] = model.rows.splice(index, 1);
      // Cascada, como el `onDelete: Cascade` del schema.
      for (const { model: childModel, foreignKey } of Object.values(RELATIONS[name] ?? {})) {
        db[childModel].rows = db[childModel].rows.filter((child) => child[foreignKey] !== borrado.id);
      }
      return { ...borrado };
    },
    /** Lo usa la purga de promociones viejas (`purgeStale`). Sin cascada: ningún modelo que lo use tiene hijos. */
    async deleteMany({ where } = {}) {
      const antes = model.rows.length;
      model.rows = model.rows.filter((row) => !matchesWhere(row, where, db));
      return { count: antes - model.rows.length };
    },
    async updateMany({ where, data }) {
      const affected = model.rows.filter((row) => matchesWhere(row, where, db));
      affected.forEach((row) => applyData(row, data));
      return { count: affected.length };
    },
  };
  return model;
}

export function createFakePrisma() {
  const db = {};
  db.cashSession = createModel(db, 'session', () => ({
    remoteId: null,
    openedByLabel: null,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    summaryJson: null,
    closedBy: null,
    closedByLabel: null,
    openedAt: new Date('2026-09-05T14:00:00Z'),
    closedAtLocal: null,
    hasPendingAdjustment: false,
    adjustmentStatus: null,
    adjustmentReviewedBy: null,
    adjustmentReviewedAt: null,
    adjustmentNote: null,
    autoClosedByExpiry: false,
    pendingPush: true,
    pushError: null,
    pendingClosePush: false,
    closePushError: null,
  }));
  db.cashMovement = createModel(db, 'movement', () => ({
    remoteId: null,
    category: null,
    description: null,
    createdByLabel: null,
    createdAt: new Date('2026-09-05T15:00:00Z'),
    pendingPush: true,
    pushError: null,
  }));
  db.sale = createModel(db, 'sale', () => ({
    remoteId: null,
    remoteFolio: null,
    voidedAt: null,
    voidedBy: null,
    cashAmount: null,
    amountReceived: null,
    change: null,
    pendingPush: true,
    pushError: null,
    needsRemoteVoid: false,
    unreconciledAt: null,
    unreconciledReason: null,
    payloadResolveAttempts: 0,
    pharmacyTotal: null,
    servicesTotal: null,
    pharmacyCashAmount: null,
    servicesCashAmount: null,
    commissionTotal: 0,
    createdAt: new Date('2026-09-07T15:00:00Z'),
  }));
  db.saleItem = createModel(db, 'saleItem', () => ({
    kind: 'product',
    productId: null,
    serviceId: null,
    providerId: null,
    providerName: null,
    commissionRate: null,
    commissionAmount: null,
    saleDiscountShare: null,
    netAmount: null,
    taxesJson: null,
  }));
  db.saleMovement = createModel(db, 'saleMovement', () => ({
    userLabel: null,
    reason: null,
    occurredAt: new Date('2026-09-07T15:00:00Z'),
  }));
  db.product = createModel(db, 'product', () => ({
    remoteId: null,
    totalStock: 0,
    isActive: true,
  }));
  db.pharmacyService = createModel(db, 'pharmacyService', () => ({
    description: null,
    taxMode: 'exempt',
    hasIeps: false,
    iepsRate: null,
    commissionRate: 0,
    requiresPerformer: false,
    isActive: true,
    updatedAt: new Date('2026-09-07T10:00:00Z'),
  }));
  db.promotion = createModel(db, 'promotion', () => ({
    endsAt: null,
    deactivatedAt: null,
    isActive: true,
    updatedAt: new Date('2026-09-24T10:00:00Z'),
  }));
  db.invoiceDocument = createModel(db, 'invoiceDocument', () => ({
    status: 'uploaded',
    documentType: null,
    confidence: null,
    extractedJson: null,
    confirmedJson: null,
    extractError: null,
    model: null,
    createdAt: new Date('2026-09-26T15:00:00Z'),
    updatedAt: new Date('2026-09-26T15:00:00Z'),
  }));
  db.invoiceEmbedding = createModel(db, 'invoiceEmbedding', () => ({
    createdAt: new Date('2026-09-26T15:00:00Z'),
  }));
  db.serviceProvider = createModel(db, 'serviceProvider', () => ({
    license: null,
    defaultCommissionRate: null,
    isActive: true,
    updatedAt: new Date('2026-09-07T10:00:00Z'),
  }));

  /**
   * `$transaction([...])` en Prisma recibe promesas ya iniciadas. El fake no
   * simula atomicidad: si una operación lanza, las anteriores ya se aplicaron.
   * Es suficiente para las pruebas, pero una que dependa del rollback mentiría.
   */
  db.$transaction = async (operaciones) => Promise.all(operaciones);

  return db;
}
