-- Catálogo sin pisadas entre cajas y servidor (SPEC 56). Columnas opcionales:
-- ALTER basta, sin reconstruir tablas. Un producto existente queda con las tres
-- en NULL y se sube como hasta hoy (registro completo, sin `baseUpdatedAt`)
-- hasta que el siguiente pull le tome la foto.

-- Foto `{ updatedAt, fields }` de los campos de catálogo al último pull o push
-- confirmado: el PATCH manda solo lo que difiere de ella, con `baseUpdatedAt`.
ALTER TABLE "Product" ADD COLUMN "baseFields" TEXT;
-- `updatedAt` remoto más nuevo que ha visto esta caja (también en filas con una
-- edición pendiente, cuyo catálogo el pull no toca).
ALTER TABLE "Product" ADD COLUMN "remoteUpdatedAt" DATETIME;
-- Valor actual del panel cuando el servidor respondió 409 `CATALOG_CONFLICT`
-- (`{ salePrice, isActive }`), para "Usar el del panel".
ALTER TABLE "Product" ADD COLUMN "catalogConflict" TEXT;
