import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';

const { runMigrations, backupsDir, MAX_BACKUPS } = migrate;

/**
 * Prisma falso a nivel de SQL crudo: `migrate.js` no usa el cliente tipado,
 * solo `$executeRawUnsafe`/`$queryRawUnsafe`/`$transaction`. Registra las
 * sentencias para poder afirmar sobre ellas, y deja simular que `VACUUM INTO`
 * no existe (motores viejos).
 */
function fakePrisma({ applied = [], vacuumFails = false, tables = ['Sale', 'Product'] } = {}) {
  const statements = [];
  const registradas = [...applied];
  const prisma = {
    statements,
    registradas,
    async $executeRawUnsafe(sql, ...params) {
      statements.push(sql);
      if (sql.startsWith('VACUUM INTO')) {
        if (vacuumFails) {
          throw new Error('near "INTO": syntax error');
        }
        // El VACUUM real escribe el archivo destino; aquí se imita.
        const destino = sql.match(/VACUUM INTO '(.+)'/)[1];
        fs.writeFileSync(destino, 'respaldo-vacuum');
        return 0;
      }
      if (sql.startsWith('INSERT INTO "_local_migrations"')) {
        registradas.push(params[0]);
      }
      return 0;
    },
    async $queryRawUnsafe(sql) {
      // `runMigrations` consulta dos cosas: qué migraciones se aplicaron y si la
      // base tiene tablas propias (para decidir si vale la pena respaldar).
      if (sql.includes('sqlite_master')) {
        return tables.map((name) => ({ name }));
      }
      return registradas.map((name) => ({ name }));
    },
    async $transaction(operaciones) {
      return Promise.all(operaciones);
    },
  };
  return prisma;
}

let tmp;
let dbPath;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-migrate-'));
  dbPath = path.join(tmp, 'farmajyv-pos.sqlite');
  fs.writeFileSync(dbPath, 'base-original');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function respaldos() {
  const dir = backupsDir(dbPath);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe('respaldo antes de migrar', () => {
  it('respalda la base cuando hay migraciones pendientes', async () => {
    const prisma = fakePrisma();

    const resultado = await runMigrations(prisma, { databasePath: dbPath });

    expect(resultado.applied.length).toBeGreaterThan(0);
    expect(resultado.backupPath).toBeTruthy();
    expect(fs.existsSync(resultado.backupPath)).toBe(true);
  });

  /**
   * El respaldo tiene que ocurrir ANTES de la primera sentencia de la
   * migración: si se hiciera después, una migración que reconstruye una tabla
   * (como la de servicios con `SaleItem`) ya habría tocado los datos.
   */
  it('el respaldo es la primera cosa que se escribe, antes de cualquier DDL', async () => {
    const prisma = fakePrisma();

    await runMigrations(prisma, { databasePath: dbPath });

    const vacuum = prisma.statements.findIndex((sql) => sql.startsWith('VACUUM INTO'));
    const primerDdl = prisma.statements.findIndex((sql) => /^(CREATE TABLE "|ALTER TABLE |DROP TABLE )/.test(sql));
    expect(vacuum).toBeGreaterThan(-1);
    expect(primerDdl).toBeGreaterThan(vacuum);
  });

  it('usa VACUUM INTO y no una copia de archivo: la base está abierta y puede estar en WAL', async () => {
    const prisma = fakePrisma();

    const { backupPath } = await runMigrations(prisma, { databasePath: dbPath });

    expect(fs.readFileSync(backupPath, 'utf8')).toBe('respaldo-vacuum');
  });

  it('si el motor no soporta VACUUM INTO, cae a copiar el archivo', async () => {
    const prisma = fakePrisma({ vacuumFails: true });

    const { backupPath } = await runMigrations(prisma, { databasePath: dbPath });

    // Mejor un respaldo imperfecto que ninguno.
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('base-original');
  });

  it('sin migraciones pendientes no deja un respaldo en cada arranque', async () => {
    const primera = fakePrisma();
    await runMigrations(primera, { databasePath: dbPath });
    const trasPrimera = respaldos().length;

    // Segunda corrida con TODAS las migraciones ya registradas.
    const segunda = fakePrisma({ applied: primera.registradas });
    const resultado = await runMigrations(segunda, { databasePath: dbPath });

    expect(resultado.applied).toEqual([]);
    expect(resultado.backupPath).toBeNull();
    expect(respaldos()).toHaveLength(trasPrimera);
  });

  /**
   * Prisma crea el archivo al conectarse, así que en el primer arranque la base
   * existe pero no tiene ni una tabla: respaldarla dejaba una copia inútil y un
   * mensaje engañoso en cada caja nueva.
   */
  it('una instalación nueva (base sin tablas) no genera respaldo', async () => {
    const prisma = fakePrisma({ applied: [], tables: [] });

    const resultado = await runMigrations(prisma, { databasePath: dbPath });

    expect(resultado.applied.length).toBeGreaterThan(0);
    expect(resultado.backupPath).toBeNull();
    expect(respaldos()).toEqual([]);
  });

  /**
   * Caso opuesto y más peligroso: una base ANTERIOR a este sistema de
   * migraciones tiene el registro vacío pero está llena de ventas. Deducir
   * "instalación nueva" del registro la habría dejado sin respaldo.
   */
  it('una base con datos pero sin registro de migraciones SÍ se respalda', async () => {
    const prisma = fakePrisma({ applied: [], tables: ['Sale', 'SaleItem', 'Product'] });

    const { backupPath } = await runMigrations(prisma, { databasePath: dbPath });

    expect(backupPath).toBeTruthy();
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it('una base que todavía no existe no se respalda: no hay nada que perder', async () => {
    fs.unlinkSync(dbPath);
    const prisma = fakePrisma();

    const { backupPath } = await runMigrations(prisma, { databasePath: dbPath });

    expect(backupPath).toBeNull();
    expect(respaldos()).toEqual([]);
  });

  /**
   * Negarse a migrar por no poder respaldar dejaría la caja inservible, que es
   * peor que migrar sin respaldo. Se avisa y se sigue.
   */
  it('si el respaldo falla del todo, la migración se aplica igual', async () => {
    const prisma = fakePrisma({ vacuumFails: true });
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('disco lleno');
    });

    const resultado = await runMigrations(prisma, { databasePath: dbPath });

    expect(resultado.backupPath).toBeNull();
    expect(resultado.applied.length).toBeGreaterThan(0);
    expect(console.error).toHaveBeenCalled();
  });

  it('sin ruta de base (pruebas, herramientas) migra sin respaldar', async () => {
    const prisma = fakePrisma();

    const resultado = await runMigrations(prisma);

    expect(resultado.backupPath).toBeNull();
    expect(resultado.applied.length).toBeGreaterThan(0);
  });

  it('conserva solo los respaldos más recientes: son copias completas de la base', async () => {
    const dir = backupsDir(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    // Respaldos viejos ya existentes; los nombres ordenan por fecha.
    for (let i = 1; i <= MAX_BACKUPS + 3; i += 1) {
      fs.writeFileSync(path.join(dir, `farmajyv-pos-2026-01-0${i}T00-00-00-000Z.sqlite`), 'viejo');
    }

    await runMigrations(fakePrisma(), { databasePath: dbPath });

    expect(respaldos()).toHaveLength(MAX_BACKUPS);
    // El más antiguo se fue; el nuevo se quedó.
    expect(respaldos().some((name) => name.includes('2026-01-01'))).toBe(false);
  });

  it('los respaldos viven junto a la base, en su propia carpeta', async () => {
    const { backupPath } = await runMigrations(fakePrisma(), { databasePath: dbPath });

    expect(path.dirname(backupPath)).toBe(path.join(tmp, 'backups'));
    expect(path.basename(backupPath)).toMatch(/^farmajyv-pos-.+\.sqlite$/);
  });
});

describe('aplicación de migraciones', () => {
  it('aplica todas las carpetas pendientes, en orden de timestamp', async () => {
    const prisma = fakePrisma();

    const { applied } = await runMigrations(prisma, { databasePath: dbPath });

    expect(applied).toEqual([...applied].sort());
    expect(applied).toContain('20260907000000_pharmacy_services');
  });

  it('no reaplica una migración ya registrada', async () => {
    const prisma = fakePrisma({ applied: ['20260907000000_pharmacy_services'] });

    const { applied } = await runMigrations(prisma, { databasePath: dbPath });

    expect(applied).not.toContain('20260907000000_pharmacy_services');
  });

  /**
   * Guardián: `@@index` en el schema no crea nada por sí solo — las migraciones
   * de esta app son SQL a mano. `pendingCatalogPush` vivió declarado y sin crear,
   * así que la cola de catálogo escaneaba `Product` completo en cada barrido y
   * nadie lo notaba: el schema decía que el índice existía.
   */
  it('todo `@@index` del schema tiene su CREATE INDEX en alguna migración', () => {
    const raiz = path.join(import.meta.dirname, '..', 'prisma');
    const schema = fs.readFileSync(path.join(raiz, 'schema.prisma'), 'utf8');
    const sql = fs
      .readdirSync(path.join(raiz, 'migrations'), { withFileTypes: true })
      .filter((entrada) => entrada.isDirectory())
      .map((carpeta) =>
        fs.readFileSync(path.join(raiz, 'migrations', carpeta.name, 'migration.sql'), 'utf8'),
      )
      .join('\n');

    const faltantes = [];
    let modelo = null;
    for (const linea of schema.split('\n')) {
      const encabezado = linea.match(/^model (\w+)/);
      if (encabezado) {
        modelo = encabezado[1];
      }
      const indice = linea.match(/@@index\(\[([^\]]+)\]/);
      if (indice) {
        const columnas = indice[1].split(',').map((columna) => columna.trim());
        const nombre = `${modelo}_${columnas.join('_')}_idx`;
        if (!sql.includes(nombre)) {
          faltantes.push(nombre);
        }
      }
    }

    expect(faltantes).toEqual([]);
  });
});
