CREATE TABLE "CashSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "remoteId" TEXT,
  "openedBy" TEXT NOT NULL,
  "openedByLabel" TEXT,
  "openingAmount" REAL NOT NULL,
  "expectedCashAmount" REAL,
  "countedCashAmount" REAL,
  "cashDifference" REAL,
  "summaryJson" TEXT,
  "closedBy" TEXT,
  "closedByLabel" TEXT,
  "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAtLocal" DATETIME,
  "hasPendingAdjustment" BOOLEAN NOT NULL DEFAULT false,
  "adjustmentStatus" TEXT,
  "adjustmentReviewedBy" TEXT,
  "adjustmentReviewedAt" DATETIME,
  "adjustmentNote" TEXT,
  "autoClosedByExpiry" BOOLEAN NOT NULL DEFAULT false,
  "pendingPush" BOOLEAN NOT NULL DEFAULT true,
  "pushError" TEXT,
  "pendingClosePush" BOOLEAN NOT NULL DEFAULT false,
  "closePushError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "CashSession_remoteId_key" ON "CashSession"("remoteId");
CREATE INDEX "CashSession_openedBy_idx" ON "CashSession"("openedBy");
CREATE INDEX "CashSession_pendingPush_idx" ON "CashSession"("pendingPush");
CREATE INDEX "CashSession_pendingClosePush_idx" ON "CashSession"("pendingClosePush");
CREATE INDEX "CashSession_closedAtLocal_idx" ON "CashSession"("closedAtLocal");
