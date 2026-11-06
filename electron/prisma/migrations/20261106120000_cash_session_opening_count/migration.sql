-- Arqueo del fondo heredado al abrir turno (SPEC 63). Todo aditivo: los turnos
-- existentes quedan sin arqueo de apertura (null) y sin marca de revisión.
ALTER TABLE "CashSession" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CashSession" ADD COLUMN "openingCounted" REAL;
ALTER TABLE "CashSession" ADD COLUMN "inheritedFloat" REAL;
ALTER TABLE "CashSession" ADD COLUMN "openingDifference" REAL;
ALTER TABLE "CashSession" ADD COLUMN "openingNote" TEXT;
-- Los autocierres de antes tampoco los arqueó nadie: quedan para revisión.
UPDATE "CashSession" SET "needsReview" = 1 WHERE "autoClosedByExpiry" = 1;
