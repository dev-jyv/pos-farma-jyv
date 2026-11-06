import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import cashSessions from '../db/cash-sessions.js';

/**
 * La migración de SPEC 63 (arqueo del fondo heredado y marca de revisión) sobre
 * una base que **ya existe con datos**, con SQLite y Prisma de verdad: se aplica
 * todo lo anterior, se siembran un turno autocerrado, uno cerrado por el cajero
 * y uno abierto, y `runMigrations` debe aplicar solo lo nuevo sin perder nada.
 */

const NUEVAS = ['20261106120000_cash_session_opening_count'];
const MIGRATIONS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'prisma', 'migrations');

let tmpDir;
let dbPath;
let prisma;
let resultado;

function sentencias(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-mig-63-'));
  dbPath = path.join(tmpDir, 'farmajyv-pos.sqlite');
  prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });

  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_local_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" TEXT NOT NULL)',
  );
  const anteriores = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < NUEVAS[0])
    .map((entry) => entry.name)
    .sort();
  for (const folder of anteriores) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8');
    for (const statement of sentencias(sql)) {
      await prisma.$executeRawUnsafe(statement);
    }
    await prisma.$executeRawUnsafe(
      'INSERT INTO "_local_migrations" ("name", "appliedAt") VALUES (?, ?)',
      folder,
      new Date().toISOString(),
    );
  }

  // SQL crudo: el cliente generado ya conoce las columnas nuevas y las pediría.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CashSession" ("id","openedBy","openingAmount","countedCashAmount","expectedCashAmount",
       "cashDifference","closedAtLocal","autoClosedByExpiry","pendingPush","updatedAt")
     VALUES ('cs-auto','uid-a',500,900,900,0,'2026-11-05T06:00:00.000Z',1,0,CURRENT_TIMESTAMP)`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CashSession" ("id","openedBy","openingAmount","countedCashAmount","expectedCashAmount",
       "cashDifference","closedAtLocal","autoClosedByExpiry","pendingPush","updatedAt")
     VALUES ('cs-manual','uid-a',500,880,900,-20,'2026-11-04T23:00:00.000Z',0,0,CURRENT_TIMESTAMP)`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CashSession" ("id","openedBy","openingAmount","pendingPush","updatedAt")
     VALUES ('cs-open','uid-b',900,1,CURRENT_TIMESTAMP)`,
  );

  resultado = await migrate.runMigrations(prisma, { databasePath: dbPath });
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('migración del arqueo de apertura sobre una base existente (SPEC 63)', () => {
  it('aplica solo lo nuevo y respalda antes', () => {
    expect(resultado.applied).toContain(NUEVAS[0]);
    expect(resultado.applied.every((name) => name >= NUEVAS[0])).toBe(true);
    expect(fs.existsSync(resultado.backupPath)).toBe(true);
  });

  it('los turnos de antes conservan sus cifras y quedan sin arqueo de apertura', async () => {
    const manual = await prisma.cashSession.findUnique({ where: { id: 'cs-manual' } });
    expect(manual).toMatchObject({
      openingAmount: 500,
      countedCashAmount: 880,
      cashDifference: -20,
      needsReview: false,
      openingCounted: null,
      inheritedFloat: null,
      openingDifference: null,
      openingNote: null,
    });
  });

  it('un autocierre de antes queda para revisión: nadie lo arqueó', async () => {
    const auto = await prisma.cashSession.findUnique({ where: { id: 'cs-auto' } });
    expect(auto.needsReview).toBe(true);
  });

  it('el turno abierto de antes sigue en cola y sube como un POS viejo', async () => {
    const [pendiente] = await cashSessions.getPendingPush(prisma, {});
    expect(pendiente).toMatchObject({ id: 'cs-open', openingAmount: 900, openingCounted: null });
  });

  it('después de migrar, abrir con arqueo guarda la diferencia contra el último cierre', async () => {
    const heredado = await cashSessions.getCashOnHand(prisma);
    // El cierre más reciente es el autocierre: contado = esperado = 900.
    expect(heredado.amount).toBe(900);
    const abierto = await cashSessions.createLocal(prisma, {
      openedBy: 'uid-c',
      openingAmount: 850,
      openingCounted: 850,
      inheritedFloat: heredado.amount,
      openingNote: 'Faltan 50 del turno de anoche',
    });
    expect(abierto).toMatchObject({
      openingAmount: 850,
      openingCounted: 850,
      inheritedFloat: 900,
      openingDifference: -50,
      openingNote: 'Faltan 50 del turno de anoche',
    });
  });
});
