-- Promociones por cantidad (precio escalonado, lleva N paga M, % por volumen).
-- Catálogo SOLO-PULL, igual que los servicios: lo administra el admin web y su
-- `id` local es el de Firestore. La regla va como JSON porque es una unión
-- discriminada que la caja solo lee.

CREATE TABLE "Promotion" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "name"           TEXT NOT NULL,
  "type"           TEXT NOT NULL,
  "ruleJson"       TEXT NOT NULL,
  "productIdsJson" TEXT NOT NULL,
  "startsAt"       DATETIME NOT NULL,
  "endsAt"         DATETIME,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "deactivatedAt"  DATETIME,
  "updatedAt"      DATETIME NOT NULL
);
CREATE INDEX "Promotion_isActive_idx" ON "Promotion"("isActive");

-- La partida recuerda qué promoción se aplicó para el ticket y el payload.
-- Columnas opcionales: ALTER basta, no hace falta reconstruir `SaleItem`.
ALTER TABLE "SaleItem" ADD COLUMN "promotionId" TEXT;
ALTER TABLE "SaleItem" ADD COLUMN "promotionName" TEXT;
ALTER TABLE "SaleItem" ADD COLUMN "promotionDiscount" REAL;
