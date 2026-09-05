-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remoteId" TEXT,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "activeIngredient" TEXT,
    "concentration" TEXT,
    "categoryId" TEXT,
    "unit" TEXT,
    "salePrice" REAL NOT NULL,
    "minStock" REAL NOT NULL DEFAULT 0,
    "hasIva" BOOLEAN NOT NULL DEFAULT false,
    "hasIvaZero" BOOLEAN NOT NULL DEFAULT false,
    "hasIeps" BOOLEAN NOT NULL DEFAULT false,
    "iepsRate" REAL,
    "controlledGroup" TEXT,
    "requiresPrescription" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "suppliersJson" TEXT,
    "totalStock" REAL NOT NULL DEFAULT 0,
    "pendingPush" BOOLEAN NOT NULL DEFAULT false,
    "pushError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remoteId" TEXT,
    "productId" TEXT NOT NULL,
    "lotNumber" TEXT,
    "expiryDate" DATETIME,
    "quantity" REAL NOT NULL,
    "pendingPush" BOOLEAN NOT NULL DEFAULT false,
    "pushError" TEXT,
    "payloadJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Batch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remoteId" TEXT,
    "folio" TEXT NOT NULL,
    "remoteFolio" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "subtotal" REAL NOT NULL,
    "discountTotal" REAL NOT NULL,
    "total" REAL NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "amountReceived" REAL,
    "change" REAL,
    "cashAmount" REAL,
    "cardAmount" REAL,
    "cardPaymentReference" TEXT,
    "cashSessionId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerName" TEXT,
    "prescriptionJson" TEXT,
    "prescriptionRetained" BOOLEAN NOT NULL DEFAULT false,
    "controlledGroupsJson" TEXT NOT NULL DEFAULT '[]',
    "taxSummaryJson" TEXT,
    "billingJson" TEXT,
    "invoiceStatus" TEXT,
    "voidedAt" DATETIME,
    "voidedBy" TEXT,
    "pendingPush" BOOLEAN NOT NULL DEFAULT true,
    "pushError" TEXT,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "unitPrice" REAL NOT NULL,
    "discountAmount" REAL NOT NULL,
    "quantity" REAL NOT NULL,
    "subtotal" REAL NOT NULL,
    "saleDiscountShare" REAL,
    "netAmount" REAL,
    "taxesJson" TEXT,
    CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entity" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cursor" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_remoteId_key" ON "Product"("remoteId");

-- CreateIndex
CREATE INDEX "Product_sku_idx" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_barcode_idx" ON "Product"("barcode");

-- CreateIndex
CREATE INDEX "Product_pendingPush_idx" ON "Product"("pendingPush");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_remoteId_key" ON "Batch"("remoteId");

-- CreateIndex
CREATE INDEX "Batch_productId_idx" ON "Batch"("productId");

-- CreateIndex
CREATE INDEX "Batch_pendingPush_idx" ON "Batch"("pendingPush");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_remoteId_key" ON "Sale"("remoteId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_idempotencyKey_key" ON "Sale"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Sale_cashSessionId_idx" ON "Sale"("cashSessionId");

-- CreateIndex
CREATE INDEX "Sale_createdAt_idx" ON "Sale"("createdAt");

-- CreateIndex
CREATE INDEX "Sale_pendingPush_idx" ON "Sale"("pendingPush");

-- CreateIndex
CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");

-- CreateIndex
CREATE INDEX "SyncRun_entity_direction_startedAt_idx" ON "SyncRun"("entity", "direction", "startedAt");
