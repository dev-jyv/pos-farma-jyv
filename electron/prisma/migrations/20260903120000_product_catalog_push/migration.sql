ALTER TABLE "Product" ADD COLUMN "pendingCatalogPush" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "catalogPushError" TEXT;
