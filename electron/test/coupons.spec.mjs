import { beforeEach, describe, expect, it } from 'vitest';

import cupones from '../db/coupons.js';
import { createFakePrisma } from './fake-prisma.mjs';

const { upsertMany, findByCode, purgeStale, normalizeCode } = cupones;

let prisma;

beforeEach(() => {
  prisma = createFakePrisma();
});

const AHORA = new Date('2026-11-03T12:00:00Z');

function cuponRemoto(overrides = {}) {
  return {
    id: 'BIENVENIDA10',
    code: 'BIENVENIDA10',
    name: 'Bienvenida 10 %',
    scope: 'sale',
    productIds: [],
    discount: { type: 'percent', percent: 10 },
    minPurchase: 200,
    startsAt: '2026-11-01T06:00:00.000Z',
    endsAt: null,
    maxUses: 100,
    usedCount: 3,
    isActive: true,
    deactivatedAt: null,
    updatedAt: '2026-11-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('código de cupón', () => {
  it('normaliza a mayúsculas y quita espacios', () => {
    expect(normalizeCode(' bienvenida 10 ')).toBe('BIENVENIDA10');
  });

  it('rechaza lo que no cumple el formato del backend', () => {
    expect(normalizeCode('ab')).toBeNull();
    expect(normalizeCode('CUPÓN')).toBeNull();
    expect(normalizeCode('A'.repeat(21))).toBeNull();
  });
});

describe('pull de cupones', () => {
  it('guarda el cupón y se encuentra con el código escrito en minúsculas', async () => {
    await upsertMany(prisma, [cuponRemoto()]);

    const cupon = await findByCode(prisma, 'bienvenida10');

    expect(cupon).toMatchObject({
      code: 'BIENVENIDA10',
      scope: 'sale',
      discount: { type: 'percent', percent: 10 },
      minPurchase: 200,
      maxUses: 100,
      usedCount: 3,
      isActive: true,
      endsAt: null,
    });
  });

  it('guarda productos y monto por pieza de un cupón de producto', async () => {
    await upsertMany(prisma, [
      cuponRemoto({ id: 'AMOX-5', code: 'AMOX-5', scope: 'product', productIds: ['r-amox'], discount: { type: 'amount', amount: 5 }, minPurchase: null }),
    ]);

    expect(await findByCode(prisma, 'amox-5')).toMatchObject({
      scope: 'product',
      productIds: ['r-amox'],
      discount: { type: 'amount', amount: 5 },
    });
  });

  it('una baja que llega en el siguiente pull se conserva como inactiva (para decir por qué no aplica)', async () => {
    await upsertMany(prisma, [cuponRemoto()]);
    await upsertMany(prisma, [cuponRemoto({ isActive: false, deactivatedAt: AHORA.toISOString(), usedCount: 9 })]);

    expect(await findByCode(prisma, 'BIENVENIDA10')).toMatchObject({ isActive: false, usedCount: 9 });
  });

  it('descarta documentos sin código válido o sin descuento legible', async () => {
    const resultado = await upsertMany(prisma, [
      cuponRemoto({ id: 'x', code: 'x' }),
      cuponRemoto({ id: 'RARO-01', code: 'RARO-01', discount: { type: 'bogo' } }),
    ]);

    expect(resultado.count).toBe(0);
    expect(prisma.coupon.rows).toHaveLength(0);
  });

  it('un código desconocido devuelve null', async () => {
    expect(await findByCode(prisma, 'NOEXISTE')).toBeNull();
    expect(await findByCode(prisma, '')).toBeNull();
  });
});

describe('limpieza de cupones viejos', () => {
  it('borra los dados de baja o terminados hace más de 30 días y conserva el resto', async () => {
    await upsertMany(prisma, [
      cuponRemoto({ id: 'VIGENTE1', code: 'VIGENTE1' }),
      cuponRemoto({ id: 'BAJA-VIEJA', code: 'BAJA-VIEJA', isActive: false, deactivatedAt: '2026-09-01T00:00:00Z' }),
      cuponRemoto({ id: 'BAJA-NUEVA', code: 'BAJA-NUEVA', isActive: false, deactivatedAt: '2026-10-30T00:00:00Z' }),
      cuponRemoto({ id: 'VENCIDO1', code: 'VENCIDO1', endsAt: '2026-09-15T00:00:00Z' }),
    ]);

    await purgeStale(prisma, AHORA);

    expect(prisma.coupon.rows.map((row) => row.id).sort()).toEqual(['BAJA-NUEVA', 'VIGENTE1']);
  });
});
