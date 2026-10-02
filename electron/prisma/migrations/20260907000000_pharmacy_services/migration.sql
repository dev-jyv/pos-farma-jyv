-- Servicios de farmacia (consultas, procedimientos con comisión, otros conceptos).
-- Se cobran en la misma venta que los medicamentos, pero no tienen stock, no se
-- les puede dar entrada de inventario y su corte va aparte.
--
-- Los dos catálogos son SOLO-PULL: los administra el admin web, así que su `id`
-- local es el mismo de Firestore y no llevan `remoteId` ni colas de push. Esa
-- decisión es la que garantiza que el `serviceId` congelado en el payload de una
-- venta siempre sea un id que el backend ya conoce.

CREATE TABLE "PharmacyService" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "code"              TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "description"       TEXT,
  "serviceType"       TEXT NOT NULL,
  "price"             REAL NOT NULL,
  "taxMode"           TEXT NOT NULL DEFAULT 'exempt',
  "hasIeps"           BOOLEAN NOT NULL DEFAULT false,
  "iepsRate"          REAL,
  "commissionRate"    REAL NOT NULL DEFAULT 0,
  "requiresPerformer" BOOLEAN NOT NULL DEFAULT false,
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"         DATETIME NOT NULL
);
CREATE INDEX "PharmacyService_isActive_idx" ON "PharmacyService"("isActive");
CREATE INDEX "PharmacyService_code_idx" ON "PharmacyService"("code");

CREATE TABLE "ServiceProvider" (
  "id"                    TEXT NOT NULL PRIMARY KEY,
  "name"                  TEXT NOT NULL,
  "license"               TEXT,
  "defaultCommissionRate" REAL,
  "isActive"              BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"             DATETIME NOT NULL
);
CREATE INDEX "ServiceProvider_isActive_idx" ON "ServiceProvider"("isActive");

-- `SaleItem` pasa a ser una unión discriminada. Hay que reconstruir la tabla por
-- dos razones que SQLite no permite con ALTER: aflojar el NOT NULL de
-- `productId`, y añadir el CHECK que impide una partida híbrida.
--
-- El CHECK es deliberado: guardar un `productId` inventado en una partida de
-- servicio es exactamente la trampa que este diseño existe para eliminar (sería
-- un servicio descontando stock de un producto real). El CHECK no se puede
-- expresar en `schema.prisma`, así que vive solo aquí: si algún día Prisma
-- regenera esta tabla, hay que volver a ponerlo.
--
-- Sin PRAGMA foreign_keys: `migrate.js` corre esto dentro de una transacción,
-- donde SQLite lo ignora. `SaleItem` no es referenciada por ninguna otra tabla.
CREATE TABLE "SaleItem_new" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "saleId"            TEXT NOT NULL,
  "kind"              TEXT NOT NULL DEFAULT 'product',
  "productId"         TEXT,
  "serviceId"         TEXT,
  "providerId"        TEXT,
  "providerName"      TEXT,
  "commissionRate"    REAL,
  "commissionAmount"  REAL,
  "productName"       TEXT NOT NULL,
  "unitPrice"         REAL NOT NULL,
  "discountAmount"    REAL NOT NULL,
  "quantity"          REAL NOT NULL,
  "subtotal"          REAL NOT NULL,
  "saleDiscountShare" REAL,
  "netAmount"         REAL,
  "taxesJson"         TEXT,
  CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SaleItem_kind_xor" CHECK (
    ("kind" = 'product' AND "productId" IS NOT NULL AND "serviceId" IS NULL)
    OR
    ("kind" = 'service' AND "serviceId" IS NOT NULL AND "productId" IS NULL)
  )
);

INSERT INTO "SaleItem_new" (
  "id", "saleId", "kind", "productId", "productName", "unitPrice",
  "discountAmount", "quantity", "subtotal", "saleDiscountShare", "netAmount", "taxesJson"
)
SELECT
  "id", "saleId", 'product', "productId", "productName", "unitPrice",
  "discountAmount", "quantity", "subtotal", "saleDiscountShare", "netAmount", "taxesJson"
FROM "SaleItem";

DROP TABLE "SaleItem";
ALTER TABLE "SaleItem_new" RENAME TO "SaleItem";
CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");
CREATE INDEX "SaleItem_serviceId_idx" ON "SaleItem"("serviceId");
CREATE INDEX "SaleItem_providerId_idx" ON "SaleItem"("providerId");

-- Totales denormalizados en la venta: el corte proyecta la venta y NUNCA recorre
-- sus partidas, así que el bloque de servicios tiene que poder calcularse sin
-- abrir `SaleItem`. Aquí sí hay backfill inmediato, porque el corte local lee
-- estas columnas: toda venta histórica es 100% farmacia.
ALTER TABLE "Sale" ADD COLUMN "pharmacyTotal" REAL;
ALTER TABLE "Sale" ADD COLUMN "servicesTotal" REAL;
ALTER TABLE "Sale" ADD COLUMN "pharmacyCashAmount" REAL;
ALTER TABLE "Sale" ADD COLUMN "servicesCashAmount" REAL;
ALTER TABLE "Sale" ADD COLUMN "commissionTotal" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN "payloadResolveAttempts" INTEGER NOT NULL DEFAULT 0;

UPDATE "Sale" SET
  "pharmacyTotal"      = "total",
  "servicesTotal"      = 0,
  "pharmacyCashAmount" = COALESCE("cashAmount", COALESCE("amountReceived", 0) - COALESCE("change", 0)),
  "servicesCashAmount" = 0;

-- El fondo inicial pertenece a farmacia; servicios abre en 0. El conteo al
-- cerrar sigue siendo UNO SOLO (mismo cajón físico): solo se guarda el esperado
-- de cada bloque para que el cajero vea de dónde salió la cifra.
ALTER TABLE "CashSession" ADD COLUMN "servicesOpeningAmount" REAL NOT NULL DEFAULT 0;
ALTER TABLE "CashSession" ADD COLUMN "expectedServicesCashAmount" REAL;

-- En v1 todos los movimientos de caja son de farmacia. La columna existe desde
-- ya para no tener que migrar datos el día que se separen.
ALTER TABLE "CashMovement" ADD COLUMN "bucket" TEXT NOT NULL DEFAULT 'pharmacy';
