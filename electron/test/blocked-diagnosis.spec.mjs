import { describe, expect, it, beforeEach } from 'vitest';

import diagnosis from '../db/blocked-diagnosis.js';
import sales from '../db/sales.js';
import cashMovements from '../db/cash-movements.js';
import { createFakePrisma } from './fake-prisma.mjs';

const { codeFromReason, diagnoseReason, syncCodeFromReason } = diagnosis;

describe('codeFromReason: textos reales del backend y de la caja', () => {
  it.each([
    ['El turno de caja ya está cerrado', 'turno-cerrado'],
    ['El turno de caja ya está cerrado: el gasto no se puede corregir', 'turno-cerrado'],
    ['Turno de caja no encontrado', 'turno-no-encontrado'],
    ['Producto no encontrado', 'producto-no-encontrado'],
    [
      'Esta entrada quedó a medio registrar en un intento anterior. Revisa el lote en inventario antes de volver a capturarla.',
      'entrada-a-medias',
    ],
    ['Stock insuficiente para Paracetamol', 'sin-stock'],
    ['Stock insuficiente. Faltan 2 unidades.', 'sin-stock'],
    ['La promoción "2x1 Jarabes" no está vigente', 'promocion-no-vigente'],
    ['Solo el cajero que abrió el turno o un administrador puede usarlo', 'turno-ajeno'],
    ['Ya tienes un turno de caja abierto', 'turno-abierto-existente'],
    [
      'El turno remoto abc ya pertenece a otro turno de este equipo. Sincroniza el cierre del turno anterior antes de subir este.',
      'turno-duplicado',
    ],
  ])('%s → %s', (reason, code) => {
    expect(codeFromReason(reason)).toBe(code);
  });

  it('lo que no reconoce cae en desconocido, no en un código equivocado', () => {
    expect(codeFromReason('Internal error 0x55')).toBe('desconocido');
    expect(codeFromReason(null)).toBe('desconocido');
  });
});

describe('código de sincronización del servidor (SPEC 49)', () => {
  it('el código al final del motivo manda sobre el texto', () => {
    expect(codeFromReason('Faltan 2 piezas [STOCK_INSUFFICIENT]')).toBe('sin-stock');
    expect(codeFromReason('Producto abc no encontrado [PRODUCT_NOT_FOUND]')).toBe('producto-no-encontrado');
    expect(codeFromReason('Otro texto [SESSION_CLOSED]')).toBe('turno-cerrado');
    expect(codeFromReason('Otro texto [SESSION_FORBIDDEN]')).toBe('turno-ajeno');
    expect(codeFromReason('quedó a medio registrar [ENTRY_IN_PROGRESS]')).toBe('entrada-en-curso');
    expect(codeFromReason('quedó a medio registrar [ENTRY_AMBIGUOUS]')).toBe('entrada-a-medias');
  });

  it('un código sin traducción cae al texto', () => {
    expect(codeFromReason('Stock insuficiente [CODIGO_NUEVO]')).toBe('sin-stock');
    expect(codeFromReason('algo raro [VALIDATION]')).toBe('desconocido');
  });

  it('diagnoseReason lleva el código del servidor solo si vino', () => {
    expect(diagnoseReason('Faltan 2 [STOCK_INSUFFICIENT]')).toEqual({
      code: 'sin-stock',
      syncCode: 'STOCK_INSUFFICIENT',
    });
    expect(diagnoseReason('Stock insuficiente')).toEqual({ code: 'sin-stock' });
    expect(syncCodeFromReason(null)).toBeNull();
  });

  it('el motivo de un bloqueo por espera no se confunde con un código', () => {
    expect(syncCodeFromReason('Espera al turno de Ana del 25/09 13:02')).toBeNull();
  });
});

describe('listBlocked: diagnóstico en vivo de ventas bloqueadas por intentos', () => {
  let prisma;

  beforeEach(() => {
    prisma = createFakePrisma();
  });

  function partida(productId) {
    return { kind: 'product', productId, productName: 'X', unitPrice: 100, discountAmount: 0, quantity: 1, subtotal: 100 };
  }

  async function ventaBloqueada(items, cashSessionId = 'cs-1') {
    await sales.createLocal(prisma, {
      folio: 'PENDIENTE-1',
      idempotencyKey: `k-${Math.random()}`,
      subtotal: 100,
      discountTotal: 0,
      total: 100,
      paymentMethod: 'cash',
      amountReceived: 100,
      change: 0,
      cashAmount: 100,
      cashSessionId,
      cashierId: 'uid',
      items,
      payload: { cashSessionId, items },
    });
    for (let ciclo = 0; ciclo < 6; ciclo += 1) {
      await sales.getPendingPush(prisma, { contarIntentos: true });
    }
    // Bloqueo por espera: mensaje con el bloqueador concreto y el contador al tope.
    expect(prisma.sale.rows[0].pushError).toMatch(/^(Espera al|El producto)/);
    expect(sales.isWaitBlocked(prisma.sale.rows[0])).toBe(true);
  }

  async function producto(data) {
    await prisma.product.create({ data: { sku: data.id, salePrice: 100, totalStock: 10, ...data } });
  }

  it('turno sin remoteId y con rechazo → turno-rechazado, con el turno nombrado', async () => {
    await producto({ id: 'p-1', remoteId: 'r-1', name: 'Paracetamol' });
    await prisma.cashSession.create({
      data: { id: 'cs-1', remoteId: null, pendingPush: true, pushError: 'x', openedByLabel: 'Ana' },
    });
    await ventaBloqueada([partida('p-1')]);

    const [registro] = await sales.listBlocked(prisma);

    expect(registro.diagnosis.code).toBe('turno-rechazado');
    expect(registro.diagnosis.dependency).toMatchObject({ kind: 'cashSession' });
    expect(registro.diagnosis.dependency.label).toContain('Ana');
  });

  it('turno que dejó de tener rechazo pero no subió → turno-sin-subir', async () => {
    await producto({ id: 'p-1', remoteId: 'r-1', name: 'Paracetamol' });
    await prisma.cashSession.create({ data: { id: 'cs-1', remoteId: null, pendingPush: true, pushError: 'x' } });
    await ventaBloqueada([partida('p-1')]);
    prisma.cashSession.rows[0].pushError = null;

    const [registro] = await sales.listBlocked(prisma);

    expect(registro.diagnosis.code).toBe('turno-sin-subir');
  });

  it('producto fuera de la cola del catálogo → producto-sin-subir con su nombre', async () => {
    await producto({ id: 'p-1', remoteId: null, name: 'Jarabe nuevo' });
    await ventaBloqueada([partida('p-1')]);

    const [registro] = await sales.listBlocked(prisma);

    expect(registro.diagnosis).toEqual({
      code: 'producto-sin-subir',
      dependency: { kind: 'product', label: 'Jarabe nuevo' },
    });
  });

  it('producto con alta rechazada → producto-rechazado', async () => {
    await producto({ id: 'p-1', remoteId: null, name: 'Jarabe nuevo', catalogPushError: 'SKU duplicado' });
    await ventaBloqueada([partida('p-1')]);

    const [registro] = await sales.listBlocked(prisma);

    expect(registro.diagnosis.code).toBe('producto-rechazado');
  });

  it('si lo que faltaba ya subió → listo-para-reintentar', async () => {
    await producto({ id: 'p-1', remoteId: null, name: 'Jarabe nuevo' });
    await ventaBloqueada([partida('p-1')]);
    prisma.product.rows[0].remoteId = 'r-1';

    const [registro] = await sales.listBlocked(prisma);

    expect(registro.diagnosis.code).toBe('listo-para-reintentar');
  });

  it('un rechazo del servidor se clasifica por su texto', async () => {
    await producto({ id: 'p-1', remoteId: 'r-1', name: 'Paracetamol' });
    const creada = await sales.createLocal(prisma, {
      folio: 'PENDIENTE-2',
      idempotencyKey: 'k-2',
      subtotal: 100,
      discountTotal: 0,
      total: 100,
      paymentMethod: 'cash',
      amountReceived: 100,
      change: 0,
      cashAmount: 100,
      cashSessionId: 'cs-1',
      cashierId: 'uid',
      items: [partida('p-1')],
      payload: { items: [partida('p-1')] },
    });
    await sales.markPushFailed(prisma, creada.id, 'Stock insuficiente para Paracetamol');

    const [registro] = await sales.listBlocked(prisma);

    expect(registro.diagnosis).toEqual({ code: 'sin-stock' });
  });

  it('un rechazo con código del servidor lleva el código al panel', async () => {
    const creada = await sales.createLocal(prisma, {
      folio: 'PENDIENTE-3',
      idempotencyKey: 'k-3',
      subtotal: 100,
      discountTotal: 0,
      total: 100,
      paymentMethod: 'cash',
      amountReceived: 100,
      change: 0,
      cashAmount: 100,
      cashSessionId: 'cs-1',
      cashierId: 'uid',
      items: [partida('p-1')],
      payload: { items: [partida('p-1')] },
    });
    await sales.markPushFailed(prisma, creada.id, 'El turno ya no admite ventas [SESSION_CLOSED]');

    const [registro] = await sales.listBlocked(prisma);

    expect(registro.diagnosis).toEqual({ code: 'turno-cerrado', syncCode: 'SESSION_CLOSED' });
  });
});

describe('listBlocked de gastos', () => {
  it('trae el diagnóstico por texto', async () => {
    const prisma = createFakePrisma();
    await prisma.cashMovement.create({
      data: { id: 'm-1', type: 'expense', amount: 50, reason: 'Garrafón', pushError: 'El turno de caja ya está cerrado' },
    });

    const [registro] = await cashMovements.listBlocked(prisma);

    expect(registro.diagnosis).toEqual({ code: 'turno-cerrado' });
  });
});
