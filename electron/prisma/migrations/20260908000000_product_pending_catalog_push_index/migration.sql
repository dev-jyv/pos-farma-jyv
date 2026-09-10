-- `@@index([pendingCatalogPush])` estaba declarado en el schema y ninguna
-- migración lo creaba: la cola de catálogo escaneaba `Product` completo en cada
-- barrido. `IF NOT EXISTS` porque una base regenerada con `prisma db push` ya
-- puede tenerlo.
CREATE INDEX IF NOT EXISTS "Product_pendingCatalogPush_idx" ON "Product"("pendingCatalogPush");
