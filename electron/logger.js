const fs = require('fs');
const path = require('path');

/**
 * Bitácora de operación en disco: una línea JSON por evento, un archivo por día
 * (`farmajyv-YYYY-MM-DD.log`) y retención de 14 días. Existe para reconstruir
 * qué pasó en una caja (venta duplicada, stock descuadrado, sync rechazado) sin
 * tener que estar ahí. Nunca lanza: un fallo de log no puede tumbar un cobro.
 *
 * No se registran datos personales: solo canal, duración, resultado e ids
 * (`sanitizeArgs`). Los textos de usuario (nombre de cliente, receta) quedan fuera.
 */
const RETENTION_DAYS = 14;
const MAX_FIELD = 300;
const SENSITIVE = /(token|password|secret|authorization|rfc|customer|prescription|billing|receta)/i;

function createLogger(dir, now = () => new Date()) {
  let ready = false;

  function ensureDir() {
    if (!ready) {
      fs.mkdirSync(dir, { recursive: true });
      ready = true;
    }
  }

  function fileFor(date) {
    return path.join(dir, `farmajyv-${date.toISOString().slice(0, 10)}.log`);
  }

  function write(level, event, data) {
    try {
      ensureDir();
      const date = now();
      const line = JSON.stringify({ ts: date.toISOString(), level, event, ...scrub(data) });
      fs.appendFileSync(fileFor(date), `${line}\n`);
    } catch {
      /* el log nunca rompe la operación */
    }
  }

  function prune() {
    try {
      ensureDir();
      const limit = now().getTime() - RETENTION_DAYS * 86_400_000;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (/^farmajyv-.*\.log$/.test(name) && fs.statSync(full).mtimeMs < limit) {
          fs.unlinkSync(full);
        }
      }
    } catch {
      /* best-effort */
    }
  }

  return {
    dir,
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    prune,
  };
}

/** Recorta textos largos y descarta campos sensibles; deja ids y números. */
function scrub(value, depth = 0) {
  if (value == null || typeof value !== 'object') {
    return value == null ? {} : { value: clip(value) };
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE.test(key)) {
      out[key] = '[omitido]';
    } else if (val && typeof val === 'object') {
      out[key] = depth >= 2 ? '[objeto]' : scrub(val, depth + 1);
    } else {
      out[key] = clip(val);
    }
  }
  return out;
}

function clip(val) {
  return typeof val === 'string' && val.length > MAX_FIELD ? `${val.slice(0, MAX_FIELD)}…` : val;
}

/**
 * Resumen de los argumentos de un IPC para el log: ids, llaves de idempotencia y
 * cantidad de partidas — lo necesario para seguir una venta de punta a punta.
 */
function sanitizeArgs(args) {
  return args.map((arg) => {
    if (arg == null || typeof arg !== 'object') {
      return typeof arg === 'string' ? clip(arg) : arg;
    }
    if (Array.isArray(arg)) {
      return { count: arg.length };
    }
    const picked = {};
    for (const key of ['id', 'folio', 'idempotencyKey', 'productId', 'cashSessionId', 'total', 'paymentMethod', 'quantity', 'lotNumber', 'sku']) {
      if (arg[key] !== undefined) picked[key] = arg[key];
    }
    if (Array.isArray(arg.items)) picked.items = arg.items.length;
    return picked;
  });
}

module.exports = { createLogger, sanitizeArgs, scrub, RETENTION_DAYS };
