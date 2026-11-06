-- Marcas de revisión con las que el servidor aceptó una venta offline (SPEC 52):
-- faltante de stock, catálogo inactivo o turno ya cerrado. Opcional: ALTER basta,
-- las ventas existentes quedan en NULL (subieron sin marcas o siguen pendientes).
ALTER TABLE "Sale" ADD COLUMN "syncReviewJson" TEXT;
