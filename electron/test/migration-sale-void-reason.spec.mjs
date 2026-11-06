import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import ventas from '../db/sales.js';

/**
 * La migración de SPEC 62 (motivo de anulación y descarte lógico) sobre una base
 * que **ya existe con datos**, con SQLite y Prisma de verdad: se aplica todo lo
 * anterior, se siembran una venta pendiente y una rechazada por el servidor, y
 * `runMigrations` debe aplicar solo lo nuevo sin perder nada.
 */

const NUEVAS = ['20261106110000_sale_void_reason_discard'];
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-mig-62-'));
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

  // Venta "de ayer", pendiente de subir, con SQL crudo: el cliente generado ya
  // conoce la columna nueva y la pediría al escribir.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Product" ("id","remoteId","sku","name","salePrice","totalStock","updatedAt")
     VALUES ('p-1','r-1','SKU-1','Paracetamol',50,20,CURRENT_TIMESTAMP)`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Sale" ("id","folio","idempotencyKey","subtotal","discountTotal","total","paymentMethod",
       "cashSessionId","cashierId","payloadJson","updatedAt")
     VALUES ('s-1','PENDIENTE-1','k-1',100,0,100,'cash','cs-1','uid-cajero','{"items":[]}',CURRENT_TIMESTAMP)`,
  );
  // Rechazada por el servidor: ya salió una vez, así que no se puede descartar.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Sale" ("id","folio","idempotencyKey","subtotal","discountTotal","total","paymentMethod",
       "cashSessionId","cashierId","payloadJson","pushError","updatedAt")
     VALUES ('s-2','PENDIENTE-2','k-2',50,0,50,'cash','cs-1','uid-cajero','{"items":[]}',
       'Stock insuficiente [STOCK_INSUFFICIENT]',CURRENT_TIMESTAMP)`,
  );

  resultado = await migrate.runMigrations(prisma, { databasePath: dbPath });
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('migración de motivo de anulación y descarte lógico sobre una base existente (SPEC 62)', () => {
  it('aplica solo lo nuevo y respalda antes', () => {
    expect(resultado.applied).toContain(NUEVAS[0]);
    expect(resultado.applied.every((name) => name >= NUEVAS[0])).toBe(true);
    expect(fs.existsSync(resultado.backupPath)).toBe(true);
  });

  it('las ventas de antes siguen igual, sin motivo ni descarte', async () => {
    const venta = await prisma.sale.findUnique({ where: { id: 's-1' } });
    expect(venta).toMatchObject({
      total: 100,
      pendingPush: true,
      voidReason: null,
      voidError: null,
      discardedAt: null,
      pushAttempts: 0,
    });
    expect((await ventas.list(prisma, {})).map((row) => row.id).sort()).toEqual(['s-1', 's-2']);
  });

  it('la rechazada por el servidor cuenta como enviada y no se puede descartar', async () => {
    const rechazada = await prisma.sale.findUnique({ where: { id: 's-2' } });
    expect(rechazada.pushAttempts).toBe(1);
    await expect(
      ventas.discard(prisma, 's-2', { discardedBy: 'uid-admin', reason: 'Venta de prueba' }),
    ).rejects.toThrow(/pudo registrarse/);
  });

  it('la pendiente que nunca salió se descarta con rastro', async () => {
    await ventas.discard(prisma, 's-1', { discardedBy: 'uid-admin', reason: 'Venta de prueba' });
    const fila = await prisma.sale.findUnique({ where: { id: 's-1' } });
    expect(fila.discardedAt).toBeInstanceOf(Date);
    expect(await prisma.syncLog.count({ where: { ref: 's-1' } })).toBe(1);
  });
});
