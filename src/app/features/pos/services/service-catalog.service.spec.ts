import { TestBed } from '@angular/core/testing';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { PharmacyService, ServiceProvider } from '../../../shared/models';
import { ServiceCatalogService } from './service-catalog.service';

function servicio(overrides: Partial<PharmacyService> = {}): PharmacyService {
  return {
    id: 'sv-1',
    code: 'CONS-01',
    name: 'Consulta general',
    serviceType: 'consultation',
    price: 200,
    taxMode: 'exempt',
    commissionRate: 40,
    requiresPerformer: true,
    ...overrides,
  };
}

describe('ServiceCatalogService', () => {
  let service: ServiceCatalogService;
  let list: Mock;
  let listProviders: Mock;

  beforeEach(() => {
    list = vi.fn().mockResolvedValue([
      servicio(),
      servicio({ id: 'sv-2', code: 'PROC-01', name: 'Aplicación de inyección', commissionRate: 0 }),
    ]);
    listProviders = vi.fn().mockResolvedValue([{ id: 'dr-1', name: 'Dra. Ruiz' } as ServiceProvider]);
    window.electronAPI = {
      catalog: {},
      sales: {},
      sync: { getStatus: vi.fn(), recordRun: vi.fn() },
      cashSessions: {},
      cashMovements: {},
      pharmacyServices: { list, listProviders, getById: vi.fn(), upsertMany: vi.fn(), upsertProviders: vi.fn() },
    } as unknown as Window['electronAPI'];

    TestBed.configureTestingModule({});
    service = TestBed.inject(ServiceCatalogService);
  });

  it('carga los dos catálogos desde SQLite, sin red', async () => {
    await new Promise<void>((resolve) => service.refresh().subscribe(() => resolve()));

    expect(service.services()).toHaveLength(2);
    expect(service.providers()).toHaveLength(1);
    expect(service.hasServices()).toBe(true);
  });

  it('sin servicios, la UI no debe ofrecer la pestaña', async () => {
    list.mockResolvedValue([]);
    await new Promise<void>((resolve) => service.refresh().subscribe(() => resolve()));

    expect(service.hasServices()).toBe(false);
  });

  it('un fallo del IPC no rompe la caja: se queda sin servicios y sigue vendiendo', async () => {
    list.mockRejectedValue(new Error('SQLite ocupada'));
    await new Promise<void>((resolve) => service.refresh().subscribe(() => resolve()));

    expect(service.services()).toEqual([]);
    expect(service.hasServices()).toBe(false);
    expect(service.loading()).toBe(false);
  });

  it('sin Electron no explota', async () => {
    window.electronAPI = undefined as unknown as Window['electronAPI'];
    await new Promise<void>((resolve) => service.refresh().subscribe(() => resolve()));
    expect(service.services()).toEqual([]);
  });

  describe('búsqueda sobre la caché', () => {
    beforeEach(async () => {
      await new Promise<void>((resolve) => service.refresh().subscribe(() => resolve()));
      list.mockClear();
    });

    it('sin término devuelve el catálogo completo y no vuelve a consultar', () => {
      expect(service.search('')).toHaveLength(2);
      expect(list).not.toHaveBeenCalled();
    });

    it('filtra por nombre sin distinguir mayúsculas', () => {
      expect(service.search('INYEC')).toHaveLength(1);
    });

    it('filtra por código', () => {
      expect(service.search('cons-01')[0].id).toBe('sv-1');
    });

    it('un término sin coincidencias devuelve vacío, no todo', () => {
      expect(service.search('radiografía')).toEqual([]);
    });
  });

  describe('coincidencia por código para el escáner', () => {
    beforeEach(async () => {
      await new Promise<void>((resolve) => service.refresh().subscribe(() => resolve()));
    });

    it('encuentra por código exacto', () => {
      expect(service.findByCode('PROC-01')?.id).toBe('sv-2');
    });

    it('es exacta: una coincidencia parcial no cuenta', () => {
      // Si fuera parcial, escanear un código de barras que empiece igual
      // agregaría un servicio por accidente.
      expect(service.findByCode('PROC')).toBeNull();
    });

    it('resuelve el doctor por id', () => {
      expect(service.providerById('dr-1')?.name).toBe('Dra. Ruiz');
      expect(service.providerById('dr-9')).toBeNull();
    });
  });
});
