CREATE TABLE "SaleMovement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "saleId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "userLabel" TEXT,
  "reason" TEXT,
  "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaleMovement_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SaleMovement_saleId_idx" ON "SaleMovement"("saleId");
CREATE INDEX "SaleMovement_occurredAt_idx" ON "SaleMovement"("occurredAt");
