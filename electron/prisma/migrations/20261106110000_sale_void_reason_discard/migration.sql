-- Anulación con motivo y descarte lógico (SPEC 62). Todo aditivo: las ventas
-- existentes quedan sin motivo, sin error de anulación y sin descartar.
ALTER TABLE "Sale" ADD COLUMN "voidReason" TEXT;
ALTER TABLE "Sale" ADD COLUMN "voidError" TEXT;
ALTER TABLE "Sale" ADD COLUMN "discardedAt" DATETIME;
ALTER TABLE "Sale" ADD COLUMN "discardedBy" TEXT;
ALTER TABLE "Sale" ADD COLUMN "discardReason" TEXT;
ALTER TABLE "Sale" ADD COLUMN "pushAttempts" INTEGER NOT NULL DEFAULT 0;
-- Una venta rechazada por el servidor ya salió al menos una vez: se cuenta, para
-- que no se pueda descartar en silencio. Las bloqueadas por espera (contador de
-- resolución al tope o el texto viejo) nunca salieron y se dejan en 0.
UPDATE "Sale" SET "pushAttempts" = 1
WHERE "remoteId" IS NULL
  AND "pushError" IS NOT NULL
  AND "payloadResolveAttempts" < 6
  AND lower("pushError") NOT LIKE '%espera a que su turno o alguno de sus productos%';
