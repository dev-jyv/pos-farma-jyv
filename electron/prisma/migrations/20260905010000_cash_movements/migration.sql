CREATE TABLE "CashMovement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "remoteId" TEXT,
  "cashSessionId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" REAL NOT NULL,
  "reason" TEXT NOT NULL,
  "category" TEXT,
  "description" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdByLabel" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pendingPush" BOOLEAN NOT NULL DEFAULT true,
  "pushError" TEXT,
  CONSTRAINT "CashMovement_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashMovement_remoteId_key" ON "CashMovement"("remoteId");
CREATE INDEX "CashMovement_cashSessionId_idx" ON "CashMovement"("cashSessionId");
CREATE INDEX "CashMovement_pendingPush_idx" ON "CashMovement"("pendingPush");
CREATE INDEX "CashMovement_createdAt_idx" ON "CashMovement"("createdAt");
