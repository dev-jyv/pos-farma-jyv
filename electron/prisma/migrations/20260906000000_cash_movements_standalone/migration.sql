-- La caja de la farmacia registra entradas y salidas de efectivo sin turno
-- abierto, así que `cashSessionId` deja de ser obligatorio. SQLite no permite
-- aflojar un NOT NULL con ALTER: hay que reconstruir la tabla. Sin PRAGMA:
-- `migrate.js` corre esto dentro de una transacción, donde SQLite ignora
-- `PRAGMA foreign_keys`, y aquí no hace falta —ninguna tabla referencia a
-- CashMovement, así que soltarla no rompe ninguna llave.
CREATE TABLE "CashMovement_new" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "remoteId" TEXT,
  "cashSessionId" TEXT,
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

INSERT INTO "CashMovement_new" (
  "id", "remoteId", "cashSessionId", "type", "amount", "reason", "category",
  "description", "createdBy", "createdByLabel", "createdAt", "pendingPush", "pushError"
)
SELECT
  "id", "remoteId", "cashSessionId", "type", "amount", "reason", "category",
  "description", "createdBy", "createdByLabel", "createdAt", "pendingPush", "pushError"
FROM "CashMovement";

DROP TABLE "CashMovement";
ALTER TABLE "CashMovement_new" RENAME TO "CashMovement";

CREATE UNIQUE INDEX "CashMovement_remoteId_key" ON "CashMovement"("remoteId");
CREATE INDEX "CashMovement_cashSessionId_idx" ON "CashMovement"("cashSessionId");
CREATE INDEX "CashMovement_pendingPush_idx" ON "CashMovement"("pendingPush");
CREATE INDEX "CashMovement_createdAt_idx" ON "CashMovement"("createdAt");
