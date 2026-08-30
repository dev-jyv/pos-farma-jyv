import { beforeEach, describe, expect, it } from 'vitest';

import { HeldSale, Product } from '../../../shared/models';
import { HeldSaleStorageService } from './held-sale-storage.service';

const UID = 'u1';
const KEY = `pos.held-sales.${UID}`;

function heldSale(): HeldSale {
  return {
    id: 'h1',
    label: 'Cliente de la 3',
    heldAt: new Date('2026-08-08T15:00:00.000Z'),
    lines: [
      {
        product: { id: 'p1', sku: 'SKU1', name: 'Producto', salePrice: 50, stock: 3 } as Product,
        quantity: 1,
        discountAmount: 0,
      },
    ],
  };
}

describe('HeldSaleStorageService', () => {
  let service: HeldSaleStorageService;

  beforeEach(() => {
    localStorage.clear();
    service = new HeldSaleStorageService();
  });

  it('guarda y recupera las ventas en espera con su fecha', () => {
    service.save(UID, [heldSale()]);

    const [restored] = service.load(UID);
    expect(restored.id).toBe('h1');
    expect(restored.label).toBe('Cliente de la 3');
    expect(restored.heldAt.toISOString()).toBe('2026-08-08T15:00:00.000Z');
    expect(restored.lines[0].product.id).toBe('p1');
  });

  it('sin guardado devuelve lista vacía', () => {
    expect(service.load(UID)).toEqual([]);
  });

  it('sin uid no lee ni escribe', () => {
    service.save('', [heldSale()]);
    expect(localStorage.length).toBe(0);
    expect(service.load('')).toEqual([]);
  });

  it('un guardado corrupto se descarta y se limpia', () => {
    localStorage.setItem(KEY, 'no-json');
    expect(service.load(UID)).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('un guardado que no es arreglo se ignora', () => {
    localStorage.setItem(KEY, JSON.stringify({ id: 'h1' }));
    expect(service.load(UID)).toEqual([]);
  });

  it('guardar una lista vacía deja la caja sin ventas en espera', () => {
    service.save(UID, [heldSale()]);
    service.save(UID, []);
    expect(service.load(UID)).toEqual([]);
  });
});
