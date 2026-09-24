import { describe, expect, it, beforeEach } from 'vitest';

import promociones from '../db/promotions.js';
import { createFakePrisma } from './fake-prisma.mjs';

const { upsertMany, listActive } = promociones;

let prisma;

beforeEach(() => {
  prisma = createFakePrisma();
});

const AHORA = new Date('2026-09-24T12:00:00Z');

function promoRemota(overrides = {}) {
  return {
    id: 'promo-1',
    name: 'Paracetamol 2x$60',
    rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
    productIds: ['p1'],
    startsAt: { _seconds: Date.parse('2026-09-01T00:00:00Z') / 1000, _nanoseconds: 0 },
    endsAt: null,
    isActive: true,
    deactivatedAt: null,
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('pull de promociones', () => {
  it('guarda la regla y los productos con el id remoto', async () => {
    await upsertMany(prisma, [promoRemota()]);
    const [promo] = await listActive(prisma, AHORA);
    expect(promo).toMatchObject({
      id: 'promo-1',
      rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
      productIds: ['p1'],
      endsAt: null,
    });
  });

  it('una baja que llega en el siguiente pull la saca de las vigentes', async () => {
    await upsertMany(prisma, [promoRemota()]);
    await upsertMany(prisma, [promoRemota({ isActive: false, deactivatedAt: AHORA.toISOString() })]);
    expect(await listActive(prisma, AHORA)).toEqual([]);
  });

  it('no ofrece programadas ni vencidas', async () => {
    await upsertMany(prisma, [
      promoRemota({ id: 'futura', startsAt: '2026-10-01T00:00:00Z' }),
      promoRemota({ id: 'vencida', endsAt: '2026-09-20T00:00:00Z' }),
      promoRemota({ id: 'vigente', endsAt: '2026-09-30T00:00:00Z' }),
    ]);
    expect((await listActive(prisma, AHORA)).map((promo) => promo.id)).toEqual(['vigente']);
  });

  it('descarta filas sin id o sin regla', async () => {
    const { count } = await upsertMany(prisma, [promoRemota({ id: undefined }), promoRemota({ rule: null })]);
    expect(count).toBe(0);
  });
});
