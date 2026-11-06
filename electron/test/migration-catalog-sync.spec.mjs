import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import migrate from '../db/migrate.js';
import productos from '../db/products.js';

/**
 * La migración de SPEC 56 (`baseFields`, `remoteUpdatedAt`, `catalogConflict`)
 * sobre una base que **ya existe con datos**, con SQLite y Prisma de verdad:
 * así llega a una caja en producción. Un producto de antes, con una edición sin
 * subir, no puede perderse ni cambiar de comportamiento.
 */

const NUEVA = '20261106020000_catalog_sync_base';
const MIGRATIONS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'prisma', 'migrations');

let tmpDir;
let dbPath;
let prisma;
let resultado;

function sentencias(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.replace(/^(\s*--[^\n]*\n)+/g, '').trim())
    .filter((statement) => statement && !statement.startsWith('--'));
}

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmajyv-mig-56-'));
  dbPath = path.join(tmpDir, 'farmajyv-pos.sqlite');
  prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });

  // 1) La base "de ayer": todas las migraciones anteriores.
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_local_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" TEXT NOT NULL)',
  );
  const anteriores = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < NUEVA)
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

  // 2) Datos de ayer con SQL crudo: uno sincronizado con una edición sin subir.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Product" ("id","remoteId","sku","name","salePrice","totalStock","pendingCatalogPush","updatedAt")
     VALUES ('p-1','r-1','SKU-1','Paracetamol',65,20,1,CURRENT_TIMESTAMP)`,
  );

  // 3) La actualización: arranca la app nueva.
  resultado = await migrate.runMigrations(prisma, { databasePath: dbPath });
});

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('migración de la foto de catálogo sobre una base existente', () => {
  it('aplica la migración nueva y respalda antes', () => {
    expect(resultado.applied).toContain(NUEVA);
    expect(resultado.backupPath).toBeTruthy();
  });

  it('no pierde el producto y las columnas nuevas quedan vacías', async () => {
    const producto = await prisma.product.findUnique({ where: { id: 'p-1' } });
    expect(producto).toMatchObject({
      name: 'Paracetamol',
      salePrice: 65,
      totalStock: 20,
      pendingCatalogPush: true,
      baseFields: null,
      remoteUpdatedAt: null,
      catalogConflict: null,
    });
  });

  it('la edición de antes sube completa, como antes de SPEC 56', async () => {
    const [pendiente] = await productos.getPendingCatalogPush(prisma);
    expect(pendiente.changes).toBeNull();
    expect(pendiente.baseUpdatedAt).toBeNull();
    expect(pendiente.fields).toMatchObject({ salePrice: 65, isActive: true });
  });

  it('y el pull no se la pisa', async () => {
    await productos.upsertMany(prisma, [
      { id: 'r-1', sku: 'SKU-1', name: 'Paracetamol', salePrice: 50, stock: 30, updatedAt: '2026-11-06T10:00:00.000Z' },
    ]);
    expect(await prisma.product.findUnique({ where: { id: 'p-1' } })).toMatchObject({ salePrice: 65, totalStock: 30 });
  });
});
