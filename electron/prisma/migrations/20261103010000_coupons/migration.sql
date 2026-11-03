-- Cupones de descuento (SPEC 47). Catálogo SOLO-PULL como las promociones: lo
-- administra el panel y su `id` local es el código normalizado (= id remoto).

CREATE TABLE "Coupon" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "code"           TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "scope"          TEXT NOT NULL,
  "productIdsJson" TEXT NOT NULL,
  "discountJson"   TEXT NOT NULL,
  "minPurchase"    REAL,
  "startsAt"       DATETIME NOT NULL,
  "endsAt"         DATETIME,
  "maxUses"        INTEGER,
  "usedCount"      INTEGER NOT NULL DEFAULT 0,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "deactivatedAt"  DATETIME,
  "updatedAt"      DATETIME NOT NULL
);
CREATE INDEX "Coupon_isActive_idx" ON "Coupon"("isActive");

-- La venta recuerda el cupón que se imprimió en el ticket; la partida, su parte
-- de un cupón de producto. Opcionales: ALTER basta.
ALTER TABLE "Sale" ADD COLUMN "couponJson" TEXT;
ALTER TABLE "SaleItem" ADD COLUMN "couponDiscount" REAL;
