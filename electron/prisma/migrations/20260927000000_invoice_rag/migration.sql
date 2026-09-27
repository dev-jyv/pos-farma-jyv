-- Facturas-RAG: comprobantes (factura o recibo) que un LLM con visión lee y
-- extrae a JSON. Son locales a la caja: no se sincronizan. Los bytes del
-- archivo viven en `userData/invoice-rag/`, no aquí: blobs de 10 MB inflarían
-- los respaldos `VACUUM INTO` que se toman antes de cada migración.

CREATE TABLE "InvoiceDocument" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "fileName"      TEXT NOT NULL,
  "mimeType"      TEXT NOT NULL,
  "sizeBytes"     INTEGER NOT NULL,
  "filePath"      TEXT NOT NULL,
  "fileSha256"    TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'uploaded',
  "documentType"  TEXT,
  "confidence"    REAL,
  "extractedJson" TEXT,
  "confirmedJson" TEXT,
  "extractError"  TEXT,
  "model"         TEXT,
  "createdBy"     TEXT NOT NULL,
  "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     DATETIME NOT NULL
);
CREATE UNIQUE INDEX "InvoiceDocument_fileSha256_key" ON "InvoiceDocument"("fileSha256");
CREATE INDEX "InvoiceDocument_status_idx" ON "InvoiceDocument"("status");
CREATE INDEX "InvoiceDocument_createdAt_idx" ON "InvoiceDocument"("createdAt");

-- Un embedding por documento, del JSON confirmado. `vector` es un Float32Array
-- en crudo: la similitud se calcula en el proceso main (no hay pgvector en SQLite).
CREATE TABLE "InvoiceEmbedding" (
  "documentId"  TEXT NOT NULL PRIMARY KEY,
  "model"       TEXT NOT NULL,
  "dims"        INTEGER NOT NULL,
  "vector"      BLOB NOT NULL,
  "contentText" TEXT NOT NULL,
  "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceEmbedding_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "InvoiceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
