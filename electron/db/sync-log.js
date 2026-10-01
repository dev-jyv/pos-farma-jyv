/**
 * Bitácora local de sincronización (`SyncLog`).
 *
 * El `pushError` de una venta solo cuenta cómo está **ahora**; cuando una caja
 * lleva días sin subir algo, lo que hace falta es la historia: qué falló, cuándo
 * se bloqueó, quién pulsó "Arreglar", qué comando remoto llegó y cómo terminó.
 * Eso vive aquí y viaja en el diagnóstico remoto (`POST /pos/diagnostics`).
 */

const LEVELS = new Set(['info', 'warn', 'error']);
/** Un mensaje de error del servidor puede ser un HTML entero de un 502. */
const MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_LIST_LIMIT = 200;

function normalizeEntry(entry) {
  const level = LEVELS.has(entry?.level) ? entry.level : 'info';
  const message = String(entry?.message ?? '').slice(0, MAX_MESSAGE_LENGTH);
  return {
    level,
    entity: String(entry?.entity || 'sync').slice(0, 64),
    message: message || '(sin mensaje)',
    ref: entry?.ref ? String(entry.ref).slice(0, 128) : null,
  };
}

function toDto(row) {
  return {
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    level: row.level,
    entity: row.entity,
    message: row.message,
    ref: row.ref ?? null,
  };
}

async function append(prisma, entry) {
  const created = await prisma.syncLog.create({ data: normalizeEntry(entry) });
  return toDto(created);
}

/**
 * Igual que `append`, pero **nunca lanza**. Es la que usan los flujos de sync:
 * que la bitácora no se pueda escribir (tabla aún sin migrar, disco lleno) no
 * puede tumbar el push de una venta cobrada.
 */
async function appendSafe(prisma, entry) {
  try {
    return await append(prisma, entry);
  } catch (error) {
    console.warn('[sync-log] no se pudo escribir la bitácora', error?.message ?? error);
    return null;
  }
}

/** Los `limit` renglones más recientes, del más nuevo al más viejo. */
async function listRecent(prisma, limit = DEFAULT_LIST_LIMIT) {
  const take = Math.max(1, Math.min(Number(limit) || DEFAULT_LIST_LIMIT, 1000));
  const rows = await prisma.syncLog.findMany({ orderBy: { at: 'desc' }, take });
  return rows.map(toDto);
}

/**
 * Borra lo de más de `days` días. Corre al arrancar: la bitácora sirve para
 * diagnosticar lo reciente, y sin purga crecería sin tope en una caja que
 * lleva años encendida.
 */
async function purgeOld(prisma, now = new Date(), days = DEFAULT_RETENTION_DAYS) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const { count } = await prisma.syncLog.deleteMany({ where: { at: { lt: cutoff } } });
  return count;
}

module.exports = { append, appendSafe, listRecent, purgeOld, MAX_MESSAGE_LENGTH };
