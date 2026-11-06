import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import ventas from '../db/sales.js';

/**
 * La migración de SPEC 52 (marcas de revisión de la venta aceptada) sobre una
 * base que **ya existe con datos**, con SQLite y Prisma de verdad: se aplica
 * todo lo anterior, se siembra una venta pendiente y luego `runMigrations` debe
 * aplicar solo lo nuevo sin perder nada.
 */

const NUEVAS = ['20261106100000_sale_sync_review'];
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-mig-52-'));
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

  resultado = await migrate.runMigrations(prisma, { databasePath: dbPath });
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('migración de marcas de revisión sobre una base existente (SPEC 52)', () => {
  it('aplica solo lo nuevo y respalda antes', () => {
    expect(resultado.applied).toEqual(
      fs
        .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name >= NUEVAS[0])
        .map((entry) => entry.name)
        .sort(),
    );
    expect(resultado.applied).toContain(NUEVAS[0]);
    expect(fs.existsSync(resultado.backupPath)).toBe(true);
  });

  it('la venta de antes sigue igual y sin marcas', async () => {
    const venta = await prisma.sale.findUnique({ where: { id: 's-1' } });
    expect(venta).toMatchObject({ total: 100, pendingPush: true, syncReviewJson: null });
    const [listada] = await ventas.list(prisma, {});
    expect(listada.syncReview).toBeNull();
  });

  it('al subir aceptada con faltante, la venta vieja guarda su marca', async () => {
    await ventas.markSynced(prisma, 's-1', 'remote-1', 'V-1', {
      stock: { items: [{ productId: 'r-1', requested: 5, allocated: 3, shortfall: 2 }] },
      catalog: null,
      late: false,
    });
    const [listada] = await ventas.list(prisma, {});
    expect(listada.remoteId).toBe('remote-1');
    expect(listada.syncReview?.stock?.items[0]).toMatchObject({ shortfall: 2 });
  });
});
