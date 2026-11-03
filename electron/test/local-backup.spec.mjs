import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import backup from '../db/backup.js';
import migrate from '../db/migrate.js';
import cashSessions from '../db/cash-sessions.js';
import ventas from '../db/sales.js';
import syncLog from '../db/sync-log.js';
import diagnostics from '../db/diagnostics.js';
import { createFakePrisma } from './fake-prisma.mjs';

const {
  backupDatabase,
  pruneRoutineBackups,
  lastRoutineBackupAt,
  routineBackupsDir,
  parseBackupName,
  createRoutineBackups,
  MAX_ROUTINE_BACKUPS,
  PARTIAL_SUFFIX,
} = backup;

/**
 * SPEC 37 — copias de rutina de la base de la caja en `Documentos/FarmaJyV/respaldos`:
 * tras cada corte Z y al salir, rotación de 7 sin tocar las previas a migración,
 * y un fallo que se asienta sin impedir cerrar turno ni salir.
 */

let tmp;
let documentos;
let userData;
let dbPath;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-respaldo-'));
  documentos = path.join(tmp, 'Documents');
  userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  dbPath = path.join(userData, 'farmajyv-pos.sqlite');
  fs.writeFileSync(dbPath, 'base-original');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Prisma falso: `VACUUM INTO` escribe el destino (como el real) salvo que se
 * pida fallar o colgarse. El resto de modelos (`syncLog`) es el fake común.
 */
function prismaConVacuum({ falla = null, cuelga = false } = {}) {
  const prisma = createFakePrisma();
  prisma.vacuums = [];
  prisma.$executeRawUnsafe = async (sql) => {
    if (!sql.startsWith('VACUUM INTO')) return 0;
    const destino = sql.match(/VACUUM INTO '(.+)'/)[1].replace(/''/g, "'");
    prisma.vacuums.push(destino);
    if (cuelga) return new Promise(() => undefined);
    if (falla) throw new Error(falla);
    fs.writeFileSync(destino, 'copia-vacuum');
    return 0;
  };
  return prisma;
}

const carpetaRutina = () => routineBackupsDir(documentos);
const archivos = (dir = carpetaRutina()) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const sinLog = { info() {}, error() {} };

function orquestador(prisma, extra = {}) {
  let reloj = Date.parse('2026-11-01T22:00:00.000Z');
  return createRoutineBackups({
    getPrisma: async () => prisma,
    getDir: carpetaRutina,
    databasePath: dbPath,
    log: sinLog,
    syncLog,
    // Cada copia, un minuto después: el orden de los nombres es el del tiempo.
    now: () => new Date((reloj += 60_000)),
    ...extra,
  });
}

describe('backupDatabase', () => {
  it('escribe farmajyv-pos-<reason>-<timestamp>.sqlite con VACUUM INTO', async () => {
    const prisma = prismaConVacuum();
    const resultado = await backupDatabase(prisma, {
      dir: carpetaRutina(),
      reason: 'corte-z',
      now: new Date('2026-11-02T20:39:30.695Z'),
    });

    expect(path.basename(resultado.path)).toBe('farmajyv-pos-corte-z-2026-11-02T20-39-30-695Z.sqlite');
    expect(fs.readFileSync(resultado.path, 'utf8')).toBe('copia-vacuum');
    expect(resultado.createdAt).toBe('2026-11-02T20:39:30.695Z');
    // Se escribe primero a `.partial` y se renombra: nunca queda a medias con el nombre bueno.
    expect(prisma.vacuums[0]).toBe(`${resultado.path}${PARTIAL_SUFFIX}`);
    expect(archivos()).toEqual([path.basename(resultado.path)]);
  });

  it('crea la carpeta si no existe (o si alguien la borró a mano)', async () => {
    const prisma = prismaConVacuum();
    await backupDatabase(prisma, { dir: carpetaRutina(), reason: 'cierre' });
    fs.rmSync(path.join(documentos, 'FarmaJyV'), { recursive: true, force: true });

    await backupDatabase(prisma, { dir: carpetaRutina(), reason: 'cierre' });

    expect(archivos()).toHaveLength(1);
  });

  it('dos copias en el mismo milisegundo no chocan: el nombre lleva sufijo', async () => {
    const prisma = prismaConVacuum();
    const ahora = new Date('2026-11-02T20:39:30.695Z');
    const a = await backupDatabase(prisma, { dir: carpetaRutina(), reason: 'cierre', now: ahora });
    const b = await backupDatabase(prisma, { dir: carpetaRutina(), reason: 'cierre', now: ahora });

    expect(a.path).not.toBe(b.path);
    expect(path.basename(b.path)).toBe('farmajyv-pos-cierre-2026-11-02T20-39-30-695Z-1.sqlite');
  });

  it('disco lleno: lanza, no deja archivo y NO cae a copiar el archivo vivo', async () => {
    const prisma = prismaConVacuum({ falla: 'database or disk is full' });
    const copia = vi.spyOn(fs, 'copyFileSync');

    await expect(
      backupDatabase(prisma, { dir: carpetaRutina(), reason: 'corte-z', databasePath: dbPath }),
    ).rejects.toThrow(/disk is full/);

    expect(copia).not.toHaveBeenCalled();
    expect(archivos()).toEqual([]);
  });

  it('rechaza un motivo que no sirve como parte de nombre de archivo', async () => {
    await expect(
      backupDatabase(prismaConVacuum(), { dir: carpetaRutina(), reason: '../fuera' }),
    ).rejects.toThrow(/motivo inválido/);
  });
});

describe('rotación', () => {
  it('tras 8 cortes solo quedan 7 copias de rutina; las previas a migración siguen', async () => {
    const dir = carpetaRutina();
    fs.mkdirSync(dir, { recursive: true });
    // Una previa a migración en la misma carpeta (no debería estar ahí, pero si
    // alguien la copia a mano no se toca) y una con el nombre viejo sin motivo.
    const migracion = 'farmajyv-pos-pre-migracion-2026-01-01T00-00-00-000Z.sqlite';
    const legado = 'farmajyv-pos-2026-01-02T00-00-00-000Z.sqlite';
    const ajeno = 'notas.txt';
    for (const name of [migracion, legado, ajeno]) fs.writeFileSync(path.join(dir, name), 'x');

    const backups = orquestador(prismaConVacuum());
    const hechas = [];
    for (let i = 0; i < 8; i += 1) {
      hechas.push(await backups.run('corte-z'));
    }

    expect(hechas.every((r) => r.ok)).toBe(true);
    const rutina = archivos().filter((name) => /-(corte-z|cierre)-/.test(name));
    expect(rutina).toHaveLength(MAX_ROUTINE_BACKUPS);
    // Se fue la primera; la más nueva se quedó.
    expect(fs.existsSync(hechas[0].path)).toBe(false);
    expect(fs.existsSync(hechas[7].path)).toBe(true);
    expect(archivos()).toEqual(expect.arrayContaining([migracion, legado, ajeno]));
  });

  it('cuentan juntas las de corte Z y las de cierre, ordenadas por fecha y no por motivo', () => {
    const dir = carpetaRutina();
    fs.mkdirSync(dir, { recursive: true });
    const nombres = [];
    for (let dia = 1; dia <= 9; dia += 1) {
      const motivo = dia % 2 ? 'corte-z' : 'cierre';
      const nombre = `farmajyv-pos-${motivo}-2026-10-0${dia}T12-00-00-000Z.sqlite`;
      fs.writeFileSync(path.join(dir, nombre), 'x');
      nombres.push(nombre);
    }

    const borradas = pruneRoutineBackups(dir);

    expect(borradas).toEqual(nombres.slice(0, 2));
    expect(archivos()).toEqual(nombres.slice(2).sort());
  });

  it('limpia el .partial que dejó una copia cortada y no lo cuenta como copia', () => {
    const dir = carpetaRutina();
    fs.mkdirSync(dir, { recursive: true });
    const cortada = `farmajyv-pos-cierre-2026-10-09T12-00-00-000Z.sqlite${PARTIAL_SUFFIX}`;
    fs.writeFileSync(path.join(dir, cortada), 'a medias');

    expect(lastRoutineBackupAt(dir)).toBeNull();
    pruneRoutineBackups(dir);
    expect(archivos()).toEqual([]);
  });
});

describe('createRoutineBackups', () => {
  it('fallo de la copia: se asienta en el log y en SyncLog, y nunca lanza', async () => {
    const prisma = prismaConVacuum({ falla: 'EACCES: permission denied' });
    const log = { info: vi.fn(), error: vi.fn() };
    const backups = orquestador(prisma, { log });

    const resultado = await backups.run('corte-z');

    expect(resultado).toMatchObject({ ok: false, error: expect.stringMatching(/permission denied/) });
    expect(log.error).toHaveBeenCalledWith('local-backup-failed', expect.objectContaining({ reason: 'corte-z' }));
    const bitacora = await syncLog.listRecent(prisma);
    expect(bitacora[0]).toMatchObject({ level: 'error', entity: 'respaldo', ref: 'corte-z' });
    expect(bitacora[0].message).toMatch(/copia local.*permission denied/);
    // …y viaja en el diagnóstico remoto.
    const foto = await diagnostics.buildSnapshot(prisma, { deviceId: 'caja-1' });
    expect(foto.syncLog.some((r) => r.entity === 'respaldo' && r.level === 'error')).toBe(true);
  });

  it('sin permiso para crear la carpeta en Documentos: se registra y sigue', async () => {
    const prisma = prismaConVacuum();
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });

    const resultado = await orquestador(prisma).run('cierre');

    expect(resultado.ok).toBe(false);
    expect((await syncLog.listRecent(prisma))[0].message).toMatch(/EPERM/);
  });

  it('al salir no espera más del tope: una copia colgada no impide cerrar', async () => {
    const prisma = prismaConVacuum({ cuelga: true });
    const backups = orquestador(prisma);
    const inicio = Date.now();

    const resultado = await backups.runWithTimeout('cierre', 50);

    expect(resultado).toEqual({ ok: false, timedOut: true });
    expect(Date.now() - inicio).toBeLessThan(2_000);
    const bitacora = await syncLog.listRecent(prisma);
    expect(bitacora[0]).toMatchObject({ entity: 'respaldo', ref: 'cierre' });
    expect(bitacora[0].message).toMatch(/tardó más de/);
  });

  it('corte Z y salir enseguida: no se encima un segundo VACUUM INTO', async () => {
    const prisma = prismaConVacuum();
    const backups = orquestador(prisma);

    const [a, b] = await Promise.all([backups.run('corte-z'), backups.runWithTimeout('cierre', 5_000)]);

    expect(prisma.vacuums).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('sin base abierta (la app sale sin haberla tocado) no copia nada', async () => {
    const backups = createRoutineBackups({
      getPrisma: async () => null,
      getDir: carpetaRutina,
      log: sinLog,
      syncLog,
    });

    expect(await backups.run('cierre')).toMatchObject({ ok: false, skipped: true });
    expect(archivos()).toEqual([]);
  });

  it('lastBackupAt es la fecha de la copia de rutina más nueva, o null', async () => {
    const backups = orquestador(prismaConVacuum());
    expect(backups.lastBackupAt()).toBeNull();

    await backups.run('corte-z');
    const ultima = await backups.run('cierre');

    expect(backups.lastBackupAt()).toBe(ultima.createdAt);
  });

  it('borrar userData deja intactas las copias de Documentos/FarmaJyV/respaldos', async () => {
    const backups = orquestador(prismaConVacuum());
    const { path: copia } = await backups.run('corte-z');

    fs.rmSync(userData, { recursive: true, force: true });

    expect(fs.existsSync(copia)).toBe(true);
    expect(path.relative(documentos, copia).startsWith('..')).toBe(false);
    expect(path.relative(userData, copia).startsWith('..')).toBe(true);
  });
});

describe('routineBackupsDir / parseBackupName', () => {
  it('producción: Documentos/FarmaJyV/respaldos; otros entornos, aparte', () => {
    expect(routineBackupsDir('/home/caja/Documents')).toBe(path.join('/home/caja/Documents', 'FarmaJyV', 'respaldos'));
    expect(routineBackupsDir('/d', 'prod')).toBe(path.join('/d', 'FarmaJyV', 'respaldos'));
    expect(routineBackupsDir('/d', 'dev')).toBe(path.join('/d', 'FarmaJyV', 'respaldos (dev)'));
  });

  it('distingue motivo y fecha, también con el nombre viejo sin motivo', () => {
    expect(parseBackupName('farmajyv-pos-corte-z-2026-11-02T20-39-30-695Z.sqlite')).toMatchObject({
      reason: 'corte-z',
      createdAt: '2026-11-02T20:39:30.695Z',
    });
    expect(parseBackupName('farmajyv-pos-2026-11-02T20-39-30-695Z.sqlite')).toMatchObject({ reason: null });
    expect(parseBackupName('otra-cosa.sqlite')).toBeNull();
  });
});

describe('diagnóstico', () => {
  it('incluye lastLocalBackupAt (ISO) o null', async () => {
    const prisma = createFakePrisma();
    const con = await diagnostics.buildSnapshot(prisma, {
      deviceId: 'caja-1',
      lastLocalBackupAt: '2026-11-02T20:39:30.695Z',
    });
    const sin = await diagnostics.buildSnapshot(prisma, { deviceId: 'caja-1' });

    expect(con.lastLocalBackupAt).toBe('2026-11-02T20:39:30.695Z');
    expect(sin.lastLocalBackupAt).toBeNull();
  });
});

/**
 * Con SQLite y Prisma de verdad: la copia de rutina es una base que abre en la
 * app (migraciones al día) con las mismas ventas pendientes. Es el criterio
 * "una copia restaurada a mano abre en la app con las mismas ventas pendientes".
 */
describe('copia real con SQLite', () => {
  let realTmp;
  let realDb;
  let prisma;

  beforeAll(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    realTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-respaldo-real-'));
    realDb = path.join(realTmp, 'userData', 'farmajyv-pos.sqlite');
    fs.mkdirSync(path.dirname(realDb), { recursive: true });
    prisma = new PrismaClient({ datasourceUrl: `file:${realDb}` });
    await migrate.runMigrations(prisma, { databasePath: realDb });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    fs.rmSync(realTmp, { recursive: true, force: true });
  });

  it('tras un corte Z la copia restaurada abre con las mismas ventas pendientes', async () => {
    const sesion = await cashSessions.createLocal(prisma, { openedBy: 'uid-cajero', openingAmount: 0 });
    await prisma.product.create({
      data: { id: 'p-1', sku: 'SKU-1', name: 'Paracetamol', salePrice: 50, totalStock: 20 },
    });
    const partida = {
      kind: 'product', productId: 'p-1', productName: 'Paracetamol',
      unitPrice: 50, discountAmount: 0, quantity: 2, subtotal: 100,
    };
    for (const n of [1, 2]) {
      await ventas.createLocal(prisma, {
        folio: `PENDIENTE-${n}`,
        idempotencyKey: `k-respaldo-${n}`,
        subtotal: 100, discountTotal: 0, total: 100, taxSummary: null,
        paymentMethod: 'cash', amountReceived: 100, change: 0, cashAmount: 100,
        cardAmount: null, cardPaymentReference: null, cashierId: 'uid-cajero',
        customerId: null, customerName: null, prescription: null, prescriptionRetained: false,
        controlledGroups: [], billing: null, invoiceStatus: null,
        items: [partida], pharmacyTotal: 100, servicesTotal: 0, servicesCashAmount: 0,
        pharmacyCashAmount: 100, commissionTotal: 0,
        payload: { items: [partida] },
        cashSessionId: sesion.id,
      });
    }
    await cashSessions.closeLocal(prisma, sesion.id, { countedCashAmount: 200, closedBy: 'uid-cajero' });

    const docs = path.join(realTmp, 'Documents');
    const backups = createRoutineBackups({
      getPrisma: async () => prisma,
      getDir: () => routineBackupsDir(docs),
      databasePath: realDb,
      log: sinLog,
      syncLog,
    });
    const resultado = await backups.run('corte-z');
    expect(resultado.ok).toBe(true);
    expect(path.dirname(resultado.path)).toBe(path.join(docs, 'FarmaJyV', 'respaldos'));

    // Restauración a mano: se copia el respaldo como `farmajyv-pos.sqlite` de un userData nuevo.
    const restaurada = path.join(realTmp, 'userData-restaurado', 'farmajyv-pos.sqlite');
    fs.mkdirSync(path.dirname(restaurada), { recursive: true });
    fs.copyFileSync(resultado.path, restaurada);
    const reabierta = new PrismaClient({ datasourceUrl: `file:${restaurada}` });
    try {
      // La app corre migraciones al abrir: en la copia no debe quedar nada pendiente.
      const { applied } = await migrate.runMigrations(reabierta, { databasePath: restaurada });
      expect(applied).toEqual([]);
      const pendientesOriginal = await prisma.sale.findMany({ where: { pendingPush: true }, orderBy: { folio: 'asc' } });
      const pendientesCopia = await reabierta.sale.findMany({ where: { pendingPush: true }, orderBy: { folio: 'asc' } });
      expect(pendientesCopia.map((v) => v.folio)).toEqual(['PENDIENTE-1', 'PENDIENTE-2']);
      expect(pendientesCopia.map((v) => v.payloadJson)).toEqual(pendientesOriginal.map((v) => v.payloadJson));
      const turno = await reabierta.cashSession.findUnique({ where: { id: sesion.id } });
      expect(turno.closedAtLocal).not.toBeNull();
    } finally {
      await reabierta.$disconnect();
    }
  });
});
