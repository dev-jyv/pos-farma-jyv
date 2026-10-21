import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createLogger, sanitizeArgs } = require('../logger.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-log-'));

describe('logger', () => {
  it('escribe una línea JSON por evento en el archivo del día', () => {
    const dir = tmp();
    const log = createLogger(dir, () => new Date('2026-10-10T12:00:00Z'));
    log.info('ipc', { channel: 'sales:createLocal', ms: 4 });
    log.error('ipc-error', { message: 'boom' });
    const lines = fs.readFileSync(path.join(dir, 'farmajyv-2026-10-10.log'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', event: 'ipc', channel: 'sales:createLocal' });
    expect(lines[1].level).toBe('error');
  });

  it('omite campos sensibles y recorta textos largos', () => {
    const dir = tmp();
    const log = createLogger(dir, () => new Date('2026-10-10T12:00:00Z'));
    log.info('x', { rfc: 'XAXX010101000', customerName: 'Ana', note: 'a'.repeat(1000) });
    const line = JSON.parse(fs.readFileSync(path.join(dir, 'farmajyv-2026-10-10.log'), 'utf8'));
    expect(line.rfc).toBe('[omitido]');
    expect(line.customerName).toBe('[omitido]');
    expect(line.note.length).toBeLessThan(400);
  });

  it('nunca lanza aunque el directorio sea inválido', () => {
    const file = path.join(tmp(), 'archivo');
    fs.writeFileSync(file, 'x');
    const log = createLogger(path.join(file, 'no-es-dir'));
    expect(() => log.info('x', {})).not.toThrow();
  });

  it('prune borra logs de más de 14 días', () => {
    const dir = tmp();
    const vieja = path.join(dir, 'farmajyv-2026-01-01.log');
    fs.writeFileSync(vieja, 'x');
    const antigua = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(vieja, antigua, antigua);
    createLogger(dir, () => new Date('2026-10-10T00:00:00Z')).prune();
    expect(fs.existsSync(vieja)).toBe(false);
  });

  it('sanitizeArgs deja ids y llave de idempotencia, no datos del cliente', () => {
    const [venta] = sanitizeArgs([{ idempotencyKey: 'k1', total: 50, customerName: 'Ana', items: [1, 2] }]);
    expect(venta).toEqual({ idempotencyKey: 'k1', total: 50, items: 2 });
  });
});
