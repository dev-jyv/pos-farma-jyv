import { describe, expect, it, beforeEach } from 'vitest';

import catalogo from '../db/pharmacy-services.js';
import { createFakePrisma } from './fake-prisma.mjs';

const { upsertServices, upsertProviders, listServices, getServiceById, listProviders } = catalogo;

let prisma;

beforeEach(() => {
  prisma = createFakePrisma();
});

function servicioRemoto(overrides = {}) {
  return {
    id: 'sv-1',
    code: 'CONS-01',
    name: 'Consulta general',
    serviceType: 'consultation',
    price: 200,
    taxMode: 'exempt',
    commissionRate: 40,
    requiresPerformer: true,
    isActive: true,
    updatedAt: '2026-09-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('pull del catálogo de servicios', () => {
  it('guarda el servicio con el mismo id que trae el backend', async () => {
    await upsertServices(prisma, [servicioRemoto()]);

    const [guardado] = await listServices(prisma);
    // El id local ES el remoto: por eso el `serviceId` de una venta nunca
    // necesita traducción al sincronizar.
    expect(guardado.id).toBe('sv-1');
    expect(guardado).toMatchObject({ code: 'CONS-01', price: 200, commissionRate: 40 });
  });

  it('un segundo pull actualiza en vez de duplicar', async () => {
    await upsertServices(prisma, [servicioRemoto()]);
    await upsertServices(prisma, [servicioRemoto({ price: 250, name: 'Consulta general (2026)' })]);

    const servicios = await listServices(prisma);
    expect(servicios).toHaveLength(1);
    expect(servicios[0]).toMatchObject({ price: 250, name: 'Consulta general (2026)' });
  });

  it('un servicio dado de baja deja de ofrecerse en el mostrador', async () => {
    await upsertServices(prisma, [servicioRemoto()]);
    await upsertServices(prisma, [servicioRemoto({ isActive: false })]);

    expect(await listServices(prisma)).toHaveLength(0);
    // Pero sigue existiendo, para que una venta vieja pueda mostrar su nombre.
    expect(await getServiceById(prisma, 'sv-1')).not.toBeNull();
  });

  it('ignora documentos sin id en vez de romper el pull completo', async () => {
    await upsertServices(prisma, [servicioRemoto(), { name: 'basura sin id' }]);

    expect(await listServices(prisma)).toHaveLength(1);
  });

  it('aplica defaults sanos a un documento incompleto', async () => {
    await upsertServices(prisma, [{ id: 'sv-2', name: 'Suelto' }]);

    const [guardado] = await listServices(prisma);
    expect(guardado).toMatchObject({
      serviceType: 'other',
      taxMode: 'exempt',
      commissionRate: 0,
      requiresPerformer: false,
      price: 0,
    });
  });
});

describe('búsqueda en el mostrador', () => {
  beforeEach(async () => {
    await upsertServices(prisma, [
      servicioRemoto(),
      servicioRemoto({ id: 'sv-2', code: 'PROC-01', name: 'Aplicación de inyección' }),
      servicioRemoto({ id: 'sv-3', code: 'PROC-02', name: 'Toma de presión' }),
    ]);
  });

  it('sin término devuelve el catálogo completo: son decenas, no miles', async () => {
    expect(await listServices(prisma)).toHaveLength(3);
  });

  it('filtra por nombre', async () => {
    const encontrados = await listServices(prisma, 'inyec');
    expect(encontrados).toHaveLength(1);
    expect(encontrados[0].id).toBe('sv-2');
  });

  it('filtra por código', async () => {
    const encontrados = await listServices(prisma, 'PROC-02');
    expect(encontrados[0].name).toBe('Toma de presión');
  });

  it('los devuelve en orden alfabético', async () => {
    const nombres = (await listServices(prisma)).map((servicio) => servicio.name);
    // Orden por bytes, que es el de SQLite: no se usa `localeCompare` para que
    // la prueba no afirme algo que la base real no cumple.
    expect(nombres).toEqual([...nombres].sort());
  });
});

describe('catálogo de doctores', () => {
  it('solo lista los activos, ordenados', async () => {
    await upsertProviders(prisma, [
      { id: 'dr-2', name: 'Zoe Zavala', license: '1234567', updatedAt: '2026-09-07T10:00:00.000Z' },
      { id: 'dr-1', name: 'Ana Ruiz', license: '7654321', updatedAt: '2026-09-07T10:00:00.000Z' },
      { id: 'dr-3', name: 'Beto Baja', isActive: false, updatedAt: '2026-09-07T10:00:00.000Z' },
    ]);

    const doctores = await listProviders(prisma);
    expect(doctores.map((doctor) => doctor.name)).toEqual(['Ana Ruiz', 'Zoe Zavala']);
  });

  it('un doctor no necesita cédula ni porcentaje propio', async () => {
    await upsertProviders(prisma, [{ id: 'dr-9', name: 'Pasante', updatedAt: '2026-09-07T10:00:00.000Z' }]);

    const [doctor] = await listProviders(prisma);
    expect(doctor).toMatchObject({ license: null, defaultCommissionRate: null });
  });
});

describe('lo que el diseño hace imposible', () => {
  it('un servicio no tiene stock ni ningún campo de inventario', async () => {
    await upsertServices(prisma, [servicioRemoto()]);

    const [guardado] = await listServices(prisma);
    // Si algún día aparece `stock` aquí, alguien reintrodujo la posibilidad de
    // darle entrada de inventario a un servicio.
    expect(guardado).not.toHaveProperty('stock');
    expect(guardado).not.toHaveProperty('minStock');
    expect(guardado).not.toHaveProperty('controlledGroup');
  });

  it('el catálogo de servicios no comparte tabla con los productos', async () => {
    await upsertServices(prisma, [servicioRemoto()]);

    // El buscador de entrada de stock lee `Product`: si el servicio cayera ahí,
    // aparecería como mercancía recibible.
    expect(prisma.product.rows).toHaveLength(0);
  });
});
