import { beforeEach, describe, expect, it } from 'vitest';

import { CartLine, Product } from '../../../shared/models';
import { CartStorageService } from './cart-storage.service';

const UID = 'u1';
const KEY = `pos.current-cart.${UID}`;

function line(): CartLine {
  return {
    kind: 'product' as const,
    product: { id: 'p1', sku: 'SKU1', name: 'Producto', salePrice: 100, stock: 5 } as Product,
    quantity: 2,
    discountAmount: 10,
  };
}

describe('CartStorageService', () => {
  let service: CartStorageService;

  beforeEach(() => {
    localStorage.clear();
    service = new CartStorageService();
  });

  it('guarda y recupera el ticket en curso del mismo cajero', () => {
    service.save(UID, [line()], { p1: 10 });

    const stored = service.load(UID);
    expect(stored?.lines).toHaveLength(1);
    expect(stored?.lines[0].quantity).toBe(2);
    expect(stored?.manualDiscounts).toEqual({ p1: 10 });
    expect(stored?.savedAt).toBeInstanceOf(Date);
  });

  it('aísla el ticket por cajero: dos turnos en el mismo equipo no se mezclan', () => {
    service.save(UID, [line()], {});
    expect(service.load('otro-cajero')).toBeNull();
  });

  it('guardar un carrito vacío borra el guardado previo', () => {
    service.save(UID, [line()], {});
    service.save(UID, [], {});

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(service.load(UID)).toBeNull();
  });

  it('sin uid no lee ni escribe', () => {
    service.save('', [line()], {});
    expect(localStorage.length).toBe(0);
    expect(service.load('')).toBeNull();
  });

  it('un guardado corrupto se descarta y se limpia en vez de romper la caja', () => {
    localStorage.setItem(KEY, '{no es json');
    expect(service.load(UID)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('un guardado sin partidas se trata como inexistente', () => {
    localStorage.setItem(KEY, JSON.stringify({ lines: [], manualDiscounts: {}, savedAt: '2026-08-08' }));
    expect(service.load(UID)).toBeNull();
  });

  it('clear borra solo el ticket de ese cajero', () => {
    service.save(UID, [line()], {});
    service.clear(UID);
    expect(service.load(UID)).toBeNull();
  });
});
