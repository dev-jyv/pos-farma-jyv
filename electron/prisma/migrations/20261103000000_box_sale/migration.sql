-- Venta por caja completa (SPEC 46). Columnas opcionales: ALTER basta, sin
-- reconstruir tablas. Un producto sin caja (o una venta vieja) queda en NULL y
-- se comporta como hasta hoy.

ALTER TABLE "Product" ADD COLUMN "boxQuantity" INTEGER;
ALTER TABLE "Product" ADD COLUMN "boxPrice" REAL;
ALTER TABLE "Product" ADD COLUMN "boxBarcode" TEXT;
CREATE INDEX "Product_boxBarcode_idx" ON "Product"("boxBarcode");

-- `{ type: 'box', boxes, piecesPerBox, boxPrice }` (JSON). `quantity` sigue en piezas.
ALTER TABLE "SaleItem" ADD COLUMN "saleUnit" TEXT;
