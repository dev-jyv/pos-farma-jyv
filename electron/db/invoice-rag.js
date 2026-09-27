/**
 * Facturas-RAG: archivos de facturas/recibos guardados en `userData`, su
 * extracción por LLM (JSON) y el embedding del JSON confirmado para búsqueda
 * semántica. Solo local: no hay colas de push.
 *
 * El renderer nunca manda rutas, solo bytes; la ruta en disco la decide este
 * módulo, así que `readFile`/`remove` solo tocan archivos que él mismo creó.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const products = require('./products');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PAGE_LIMIT_MAX = 100;
const SEARCH_LIMIT_MAX = 50;

const FILE_TYPES = {
  'application/pdf': { ext: 'pdf', matches: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
  'image/jpeg': { ext: 'jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': {
    ext: 'webp',
    matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};

const DOCUMENT_TYPES = new Set(['invoice', 'receipt', 'other']);

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function toDocumentDto(row) {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    documentType: row.documentType ?? null,
    confidence: row.confidence ?? null,
    extracted: parseJson(row.extractedJson),
    confirmed: parseJson(row.confirmedJson),
    extractError: row.extractError ?? null,
    model: row.model ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stockAppliedAt: row.stockAppliedAt ? row.stockAppliedAt.toISOString() : null,
    stockApplied: parseJson(row.stockAppliedJson),
  };
}

function assertStockEntry(entry) {
  const valid =
    entry &&
    typeof entry.productId === 'string' && entry.productId &&
    typeof entry.invoiceId === 'string' && entry.invoiceId &&
    typeof entry.lotNumber === 'string' && entry.lotNumber.trim() &&
    typeof entry.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.expiryDate) &&
    Number.isInteger(entry.quantity) && entry.quantity >= 1 &&
    !entry.product;
  if (!valid) throw new Error('Partida de inventario inválida');
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} inválido`);
  }
}

function toDocumentType(value) {
  return DOCUMENT_TYPES.has(value) ? value : 'other';
}

function toConfidence(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

function encodeVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
    throw new Error('Vector de embedding inválido');
  }
  return Buffer.from(new Float32Array(vector).buffer);
}

/** Copia a un buffer propio: el `Buffer` de Prisma puede no estar alineado a 4 bytes. */
function decodeVector(bytes) {
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function norm(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

function cosine(query, queryNorm, candidate) {
  if (candidate.length !== query.length) return null;
  let dot = 0;
  for (let i = 0; i < query.length; i += 1) dot += query[i] * candidate[i];
  const denominator = queryNorm * norm(candidate);
  return denominator === 0 ? null : dot / denominator;
}

async function requireDocument(prisma, id) {
  const row = await prisma.invoiceDocument.findUnique({ where: { id } });
  if (!row) throw new Error('Documento no encontrado');
  return row;
}

async function register(prisma, storageDir, { fileName, mimeType, bytes, createdBy }) {
  const type = FILE_TYPES[mimeType];
  if (!type) throw new Error('Tipo de archivo no permitido');
  if (!createdBy) throw new Error('Usuario requerido');
  const buffer = Buffer.from(bytes ?? []);
  if (buffer.length === 0) throw new Error('Archivo vacío');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('El archivo excede 10 MB');
  if (!type.matches(buffer)) throw new Error('El contenido no coincide con el tipo de archivo');

  const fileSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await prisma.invoiceDocument.findUnique({ where: { fileSha256 } });
  if (existing) return { document: toDocumentDto(existing), duplicate: true };

  const id = crypto.randomUUID();
  const filePath = path.join(storageDir, `${id}.${type.ext}`);
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(filePath, buffer);
  try {
    const row = await prisma.invoiceDocument.create({
      data: {
        id,
        fileName: String(fileName || `documento.${type.ext}`).slice(0, 255),
        mimeType,
        sizeBytes: buffer.length,
        filePath,
        fileSha256,
        createdBy,
      },
    });
    return { document: toDocumentDto(row), duplicate: false };
  } catch (error) {
    await fs.rm(filePath, { force: true });
    throw error;
  }
}

async function readFile(prisma, id) {
  const row = await requireDocument(prisma, id);
  const bytes = await fs.readFile(row.filePath);
  return { fileName: row.fileName, mimeType: row.mimeType, bytes: new Uint8Array(bytes) };
}

async function list(prisma, { status, documentType, term, page = 1, limit = 20 } = {}) {
  const take = Math.min(PAGE_LIMIT_MAX, Math.max(1, Number(limit) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const trimmed = typeof term === 'string' ? term.trim() : '';
  const where = {
    ...(status ? { status } : {}),
    ...(documentType ? { documentType } : {}),
    ...(trimmed ? { OR: [{ fileName: { contains: trimmed } }, { confirmedJson: { contains: trimmed } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.invoiceDocument.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.invoiceDocument.count({ where }),
  ]);
  return { items: rows.map(toDocumentDto), total };
}

async function getById(prisma, id) {
  const row = await prisma.invoiceDocument.findUnique({ where: { id } });
  return row ? toDocumentDto(row) : null;
}

async function saveExtraction(prisma, id, { data, model }) {
  assertPlainObject(data, 'JSON extraído');
  await requireDocument(prisma, id);
  const row = await prisma.invoiceDocument.update({
    where: { id },
    data: {
      status: 'extracted',
      documentType: toDocumentType(data.documentType),
      confidence: toConfidence(data.confidence),
      extractedJson: JSON.stringify(data),
      extractError: null,
      model: model ? String(model) : null,
    },
  });
  return toDocumentDto(row);
}

async function markFailed(prisma, id, message) {
  await requireDocument(prisma, id);
  const row = await prisma.invoiceDocument.update({
    where: { id },
    data: { status: 'failed', extractError: String(message || 'Error desconocido').slice(0, 500) },
  });
  return toDocumentDto(row);
}

async function confirm(prisma, id, { data, contentText, embedding }) {
  assertPlainObject(data, 'JSON confirmado');
  assertPlainObject(embedding, 'Embedding');
  if (!contentText || typeof contentText !== 'string') throw new Error('Texto del embedding requerido');
  const vector = encodeVector(embedding.vector);
  await requireDocument(prisma, id);

  const embeddingData = {
    model: String(embedding.model ?? ''),
    dims: embedding.vector.length,
    vector,
    contentText,
  };
  await prisma.invoiceEmbedding.upsert({
    where: { documentId: id },
    create: { documentId: id, ...embeddingData },
    update: embeddingData,
  });
  const row = await prisma.invoiceDocument.update({
    where: { id },
    data: {
      status: 'indexed',
      documentType: toDocumentType(data.documentType),
      confirmedJson: JSON.stringify(data),
    },
  });
  return toDocumentDto(row);
}

async function search(prisma, { vector, model, limit = 10, minScore = 0 }) {
  if (!Array.isArray(vector) || vector.length === 0) throw new Error('Vector de búsqueda inválido');
  const query = Float32Array.from(vector);
  const queryNorm = norm(query);
  if (queryNorm === 0) return [];
  const take = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Number(limit) || 10));

  const embeddings = await prisma.invoiceEmbedding.findMany({
    where: { dims: query.length, ...(model ? { model } : {}) },
  });
  const ranked = embeddings
    .map((row) => ({ documentId: row.documentId, score: cosine(query, queryNorm, decodeVector(row.vector)) }))
    .filter((hit) => hit.score !== null && hit.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, take);
  if (ranked.length === 0) return [];

  const documents = await prisma.invoiceDocument.findMany({
    where: { id: { in: ranked.map((hit) => hit.documentId) } },
  });
  const byId = new Map(documents.map((row) => [row.id, row]));
  return ranked
    .filter((hit) => byId.has(hit.documentId))
    .map((hit) => ({ document: toDocumentDto(byId.get(hit.documentId)), score: hit.score }));
}

/**
 * Suma al inventario las partidas del documento, **una sola vez**: el
 * `updateMany` condicionado reclama el documento antes de tocar stock, así que
 * dos clics simultáneos no duplican la entrada. Todo en una transacción: si una
 * partida falla, no entra ninguna y el documento queda sin aplicar. Cada
 * partida pasa por `recordStockEntry`, así que sube con el push de entradas.
 */
async function applyStock(prisma, id, { entries, appliedBy }) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('No hay partidas para aplicar');
  if (!appliedBy) throw new Error('Usuario requerido');
  entries.forEach(assertStockEntry);

  return prisma.$transaction(async (tx) => {
    await requireDocument(tx, id);
    const claimed = await tx.invoiceDocument.updateMany({
      where: { id, status: 'indexed', stockAppliedAt: null },
      data: { stockAppliedAt: new Date(), stockAppliedBy: String(appliedBy) },
    });
    if (claimed.count !== 1) {
      throw new Error('El documento debe estar indexado y aún no aplicado al inventario');
    }

    const applied = [];
    for (const entry of entries) {
      const { product, stock } = await products.recordStockEntry(tx, entry);
      applied.push({ productId: product.id, name: product.name, quantity: entry.quantity, stock });
    }
    const row = await tx.invoiceDocument.update({
      where: { id },
      data: { stockAppliedJson: JSON.stringify(applied) },
    });
    return toDocumentDto(row);
  });
}

async function remove(prisma, id) {
  const row = await requireDocument(prisma, id);
  await prisma.$transaction([
    prisma.invoiceEmbedding.deleteMany({ where: { documentId: id } }),
    prisma.invoiceDocument.delete({ where: { id } }),
  ]);
  await fs.rm(row.filePath, { force: true });
  return { id };
}

module.exports = {
  MAX_FILE_BYTES,
  register,
  readFile,
  list,
  getById,
  saveExtraction,
  markFailed,
  confirm,
  search,
  applyStock,
  remove,
};
