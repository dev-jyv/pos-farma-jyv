import { describe, expect, it } from 'vitest';

import {
  CartLine,
  CartProductLine,
  CartServiceLine,
  PharmacyService,
  Product,
  ServiceProvider,
} from '../models';
import {
  commissionTotalOf,
  isProductLine,
  isServiceLine,
  lineCommission,
  lineGross,
  lineKey,
  lineMaxQuantity,
  lineName,
  lineNeedsProvider,
  lineTaxable,
  normalizeStoredLine,
  pharmacyTotalOf,
  servicesTotalOf,
  splitCash,
} from './cart-line';

function producto(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    sku: 'PARA-500',
    name: 'Paracetamol 500mg',
    salePrice: 50,
    stock: 10,
    hasIva: true,
    ...overrides,
  } as Product;
}

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

function doctor(overrides: Partial<ServiceProvider> = {}): ServiceProvider {
  return { id: 'dr-1', name: 'Dra. Ruiz', ...overrides };
}

function lineaProducto(overrides: Partial<CartProductLine> = {}): CartProductLine {
  return { kind: 'product', product: producto(), quantity: 2, discountAmount: 0, ...overrides };
}

function lineaServicio(overrides: Partial<CartServiceLine> = {}): CartServiceLine {
  return { kind: 'service', service: servicio(), provider: doctor(), quantity: 1, discountAmount: 0, ...overrides };
}

describe('identidad de la línea', () => {
  it('distingue producto de servicio', () => {
    expect(isProductLine(lineaProducto())).toBe(true);
    expect(isServiceLine(lineaProducto())).toBe(false);
    expect(isServiceLine(lineaServicio())).toBe(true);
  });

  it('un producto y un servicio con el mismo id no colisionan', () => {
    const p = lineaProducto({ product: producto({ id: 'x' }) });
    const s = lineaServicio({ service: servicio({ id: 'x' }) });

    expect(lineKey(p)).not.toBe(lineKey(s));
  });

  /**
   * El doctor forma parte de la identidad: dos consultas del mismo servicio
   * hechas por dos doctores son dos partidas con dos comisiones, no una con
   * cantidad 2.
   */
  it('el mismo servicio con dos doctores son dos líneas distintas', () => {
    const unaDoctora = lineaServicio({ provider: doctor({ id: 'dr-1' }) });
    const otroDoctor = lineaServicio({ provider: doctor({ id: 'dr-2' }) });

    expect(lineKey(unaDoctora)).not.toBe(lineKey(otroDoctor));
  });

  it('un servicio sin doctor tiene clave estable', () => {
    expect(lineKey(lineaServicio({ provider: null }))).toBe('service:sv-1:-');
  });

  it('el nombre sale del producto o del servicio, según la rama', () => {
    expect(lineName(lineaProducto())).toBe('Paracetamol 500mg');
    expect(lineName(lineaServicio())).toBe('Consulta general');
  });
});

describe('cantidad y stock', () => {
  it('un producto está limitado por sus existencias', () => {
    expect(lineMaxQuantity(lineaProducto({ product: producto({ stock: 7 }) }))).toBe(7);
  });

  /** Sin este `null`, el botón "+" quedaría deshabilitado en todo servicio. */
  it('un servicio no tiene tope: no hay existencias que agotar', () => {
    expect(lineMaxQuantity(lineaServicio())).toBeNull();
  });
});

describe('importes', () => {
  it('el importe descuenta lo capturado a mano', () => {
    expect(lineGross(lineaProducto({ quantity: 3, discountAmount: 20 }))).toBe(130);
    expect(lineGross(lineaServicio({ quantity: 2 }))).toBe(400);
  });

  it('separa el total de farmacia del de servicios', () => {
    const carrito: CartLine[] = [lineaProducto(), lineaServicio()];

    expect(pharmacyTotalOf(carrito)).toBe(100);
    expect(servicesTotalOf(carrito)).toBe(200);
    // El invariante que el corte necesita para cuadrar.
    expect(pharmacyTotalOf(carrito) + servicesTotalOf(carrito)).toBe(300);
  });

  it('un carrito solo de farmacia deja los servicios en cero', () => {
    expect(servicesTotalOf([lineaProducto()])).toBe(0);
  });
});

describe('comisiones', () => {
  it('un producto nunca genera comisión', () => {
    expect(lineCommission(lineaProducto())).toBe(0);
  });

  it('se calcula sobre el importe neto de la línea', () => {
    // 200 − 20 = 180, al 40 % = 72.
    expect(lineCommission(lineaServicio({ discountAmount: 20 }))).toBe(72);
  });

  it('si el servicio no define tasa, se usa la del doctor', () => {
    const linea = lineaServicio({
      service: servicio({ commissionRate: 0 }),
      provider: doctor({ defaultCommissionRate: 25 }),
    });

    expect(lineCommission(linea)).toBe(50);
  });

  it('sin tasa en ninguno de los dos, no hay comisión', () => {
    const linea = lineaServicio({ service: servicio({ commissionRate: 0 }), provider: doctor() });
    expect(lineCommission(linea)).toBe(0);
  });

  it('suma la comisión de todo el ticket', () => {
    expect(commissionTotalOf([lineaProducto(), lineaServicio()])).toBe(80);
  });
});

describe('doctor obligatorio', () => {
  it('un servicio que lo exige y no lo tiene bloquea el cobro', () => {
    expect(lineNeedsProvider(lineaServicio({ provider: null }))).toBe(true);
  });

  it('con doctor asignado, no bloquea', () => {
    expect(lineNeedsProvider(lineaServicio())).toBe(false);
  });

  it('un servicio que no lo exige nunca bloquea', () => {
    const linea = lineaServicio({ service: servicio({ requiresPerformer: false }), provider: null });
    expect(lineNeedsProvider(linea)).toBe(false);
  });

  it('un producto nunca bloquea por doctor', () => {
    expect(lineNeedsProvider(lineaProducto())).toBe(false);
  });
});

describe('impuestos', () => {
  it('un producto entrega sus propias banderas fiscales', () => {
    expect(lineTaxable(lineaProducto())).toMatchObject({ hasIva: true });
  });

  it.each([
    ['exempt', false, true],
    ['zero', false, true],
    ['iva16', true, false],
  ] as const)('traduce taxMode "%s" a las banderas que entiende taxes.ts', (taxMode, hasIva, hasIvaZero) => {
    const flags = lineTaxable(lineaServicio({ service: servicio({ taxMode }) }));

    expect(flags.hasIva).toBe(hasIva);
    expect(flags.hasIvaZero).toBe(hasIvaZero);
  });

  it('conserva el IEPS del servicio', () => {
    const flags = lineTaxable(lineaServicio({ service: servicio({ hasIeps: true, iepsRate: 0.08 }) }));

    expect(flags).toMatchObject({ hasIeps: true, iepsRate: 0.08 });
  });
});

/** Regla del usuario: el efectivo cubre primero los servicios. */
describe('reparto del efectivo: servicios primero', () => {
  it('pago 100% en efectivo de un ticket mixto', () => {
    expect(splitCash(500, 200)).toEqual({ servicesCashAmount: 200, pharmacyCashAmount: 300 });
  });

  it('si el efectivo no alcanza para los servicios, todo va a servicios', () => {
    expect(splitCash(150, 200)).toEqual({ servicesCashAmount: 150, pharmacyCashAmount: 0 });
  });

  it('un ticket sin servicios deja todo el efectivo en farmacia', () => {
    expect(splitCash(500, 0)).toEqual({ servicesCashAmount: 0, pharmacyCashAmount: 500 });
  });

  it('un ticket 100% servicios en efectivo no atribuye nada a farmacia', () => {
    expect(splitCash(200, 200)).toEqual({ servicesCashAmount: 200, pharmacyCashAmount: 0 });
  });

  it('sin efectivo (tarjeta pura) ambos quedan en cero', () => {
    expect(splitCash(0, 200)).toEqual({ servicesCashAmount: 0, pharmacyCashAmount: 0 });
  });

  it('el reparto siempre suma el efectivo cobrado', () => {
    for (const [efectivo, servicios] of [[500, 200], [150, 200], [1, 0.5], [333.33, 111.11]]) {
      const { servicesCashAmount, pharmacyCashAmount } = splitCash(efectivo, servicios);
      expect(Math.round((servicesCashAmount + pharmacyCashAmount) * 100) / 100).toBe(efectivo);
    }
  });
});

/**
 * Un ticket autoguardado o en pausa ANTES de los servicios no trae `kind`. Sin
 * esta normalización, el primer cajero que recupere un ticket viejo se
 * encuentra la pantalla rota.
 */
describe('rehidratar una línea guardada', () => {
  it('una línea vieja sin `kind` se lee como producto', () => {
    const linea = normalizeStoredLine({ product: producto(), quantity: 2, discountAmount: 5 });

    expect(linea).toMatchObject({ kind: 'product', quantity: 2, discountAmount: 5 });
  });

  it('una línea de servicio se rehidrata con su doctor', () => {
    const linea = normalizeStoredLine({
      kind: 'service',
      service: servicio(),
      provider: doctor(),
      quantity: 1,
      discountAmount: 0,
    });

    expect(linea).toMatchObject({ kind: 'service', provider: { id: 'dr-1' } });
  });

  it('un servicio guardado sin doctor sigue siendo válido', () => {
    const linea = normalizeStoredLine({ kind: 'service', service: servicio(), quantity: 1 });
    expect(linea).toMatchObject({ kind: 'service', provider: null });
  });

  it('descarta basura en vez de propagarla al carrito', () => {
    expect(normalizeStoredLine(null)).toBeNull();
    expect(normalizeStoredLine({})).toBeNull();
    expect(normalizeStoredLine({ product: producto(), quantity: 0 })).toBeNull();
    expect(normalizeStoredLine({ product: producto(), quantity: -1 })).toBeNull();
    expect(normalizeStoredLine({ kind: 'service', quantity: 1 })).toBeNull();
    expect(normalizeStoredLine({ quantity: 1 })).toBeNull();
  });

  it('el descuento ausente se lee como cero', () => {
    expect(normalizeStoredLine({ product: producto(), quantity: 1 })).toMatchObject({ discountAmount: 0 });
  });
});
