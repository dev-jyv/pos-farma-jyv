-- Bitácora local de sincronización (ver `SyncLog` en schema.prisma).
CREATE TABLE "SyncLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "level" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "ref" TEXT
);
CREATE INDEX "SyncLog_at_idx" ON "SyncLog"("at");
