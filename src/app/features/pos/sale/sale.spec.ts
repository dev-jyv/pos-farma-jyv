import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';

import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScanSoundService } from '../../../core/audio/scan-sound.service';
import { ServiceCatalogService } from '../services/service-catalog.service';
import { AuthService } from '../../../core/auth/auth.service';
import { SyncScheduler } from '../../../core/sync/sync-scheduler.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import {
  CouponDto,
  PharmacyService,
  Product,
  ProductBatch,
  Sale as SaleModel,
  ServiceProvider,
} from '../../../shared/models';
import { BatchService } from '../services/batch.service';
import { CartStorageService } from '../services/cart-storage.service';
import { CashSessionService } from '../services/cash-session.service';
import { HeldSaleStorageService } from '../services/held-sale-storage.service';
import { ProductService } from '../services/product.service';
import { ProductStockService } from '../services/product-stock.service';
import { PromoService } from '../services/promo.service';
import { CouponService } from '../services/coupon.service';
import { SaleService } from '../services/sale.service';
import { TicketPrintService } from '../ticket/ticket-print.service';
import { Sale } from './sale';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    sku: 'SKU1',
    barcode: '7501001',
    name: 'Paracetamol',
    salePrice: 50,
    stock: 10,
    controlledGroup: null,
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

function batch(overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: 'b1',
    productId: 'p1',
    lotNumber: 'L1',
    // Lejos del umbral de caducidad para no disparar el aviso en las pruebas base.
    expiryDate: new Date(Date.now() + 365 * 86_400_000),
    quantity: 10,
    ...overrides,
  };
}

describe('Sale', () => {
  let fixture: ComponentFixture<Sale>;
  let component: Sale;
  let notifyError: ReturnType<typeof vi.fn>;
  let notifySuccess: ReturnType<typeof vi.fn>;
  let notifyWarn: ReturnType<typeof vi.fn>;
  let batches: ProductBatch[];
  let isAdmin: ReturnType<typeof signal<boolean>>;
  let canSell: ReturnType<typeof signal<boolean>>;
  let isOpen: ReturnType<typeof signal<boolean>>;
  let servicios: PharmacyService[];
  /** Resultado de `ProductService.search`; `null` = el producto por defecto. */
  let searchResults: Product[] | null;
  /**
   * `ProductService.getByBarcode` (SPEC 66). Por defecto imita la SQLite:
   * código de barras o SKU exactos, y después el código de la caja.
   */
  let barcodeLookup: (code: string) => Observable<Product | null>;
  /** Cupones de la SQLite simulada, por código normalizado. */
  let cupones: Record<string, CouponDto>;
  let doctores: ServiceProvider[];
  /** `ProductStockService.refresh` (SPEC 57); por defecto no consulta (`null` en el acto). */
  let refreshStock: ReturnType<typeof vi.fn>;
  let saleServiceMock: {
    pendingCount: ReturnType<typeof signal<number>>;
    pendingSales: ReturnType<typeof signal<unknown[]>>;
    void: ReturnType<typeof vi.fn>;
    flushQueue: ReturnType<typeof vi.fn>;
    discardSale: ReturnType<typeof vi.fn>;
    findByIdempotencyKey: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    localStorage.clear();
    notifyError = vi.fn();
    syncSchedulerMock = {
      settleStaleShift: vi.fn(() => Promise.resolve(false)),
      settlingStaleShift: signal(false),
      pullPromotions: vi.fn(() => Promise.resolve(true)),
    };
    notifyWarn = vi.fn();
    notifySuccess = vi.fn();
    batches = [batch()];
    refreshStock = vi.fn(() => null);
    searchResults = null;
    barcodeLookup = (code: string) => {
      const catalogo = searchResults ?? [product()];
      const pieza = catalogo.find((item) => item.barcode === code || item.sku === code);
      if (pieza) {
        return of(pieza);
      }
      const caja = catalogo.find((item) => item.boxBarcode === code);
      return of(caja ? (caja.boxQuantity ? { ...caja, saleUnit: 'box' as const } : caja) : null);
    };
    cupones = {};
    servicios = [servicio()];
    doctores = [{ id: 'dr-1', name: 'Dra. Ruiz' }];
    isAdmin = signal(false);
    canSell = signal(true);
    isOpen = signal(true);
    saleServiceMock = {
      pendingCount: signal(0),
      pendingSales: signal<unknown[]>([]),
      void: vi.fn(() => of({ id: 'v1', folio: 'V-1' } as SaleModel)),
      flushQueue: vi.fn(),
      discardSale: vi.fn(() => Promise.resolve()),
      findByIdempotencyKey: vi.fn(() => Promise.resolve(null)),
    };

    await build();
  });

  /**
   * Reconstruible: las pruebas de arranque (qué pasa al ENTRAR sin turno)
   * necesitan fijar `isOpen`/`isAdmin` antes de que corra el constructor.
   */
  /**
   * Liquidación del turno rezagado. Por defecto no hay ninguno, que es el caso
   * normal; las pruebas del bloqueo la reemplazan antes de construir.
   */
  let syncSchedulerMock: {
    settleStaleShift: ReturnType<typeof vi.fn>;
    settlingStaleShift: WritableSignal<boolean>;
    pullPromotions: ReturnType<typeof vi.fn>;
  };

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        providePrimeNG({}),
        MessageService,
        {
          provide: NotificationService,
          useValue: { error: notifyError, success: notifySuccess, warn: notifyWarn },
        },
        {
          provide: ProductService,
          useValue: {
            search: () => of(searchResults ?? [product()]),
            getByBarcode: (code: string) => barcodeLookup(code),
            invalidate: vi.fn(),
          },
        },
        {
          provide: CouponService,
          useFactory: () => {
            const service = new CouponService();
            service.findByCode = async (code: string) =>
              cupones[code.replace(/\s+/g, '').toUpperCase()] ?? null;
            return service;
          },
        },
        { provide: BatchService, useValue: { listByProduct: () => of(batches) } },
        { provide: ProductStockService, useValue: { refresh: refreshStock } },
        { provide: SaleService, useValue: saleServiceMock },
        { provide: SyncScheduler, useValue: syncSchedulerMock },
        {
          provide: CashSessionService,
          // `cashOnHandDetail` lo consume el diálogo de apertura que monta esta pantalla.
          useValue: {
            isOpen,
            current: signal(null),
            refreshCurrent: () => of(null),
            cashOnHandDetail: () => of({ amount: 0, lastClosedAt: null, countedAtLastClose: null, movementsSinceClose: 0 }),
          },
        },
        {
          provide: AuthService,
          useValue: { isAdmin, canSell, user: signal({ uid: 'u1', email: 'caja@farmajyv.mx' }) },
        },
        { provide: TicketPrintService, useValue: { printSale: vi.fn(), printProductLabel: vi.fn() } },
        { provide: ScanSoundService, useValue: { ok: vi.fn(), warn: vi.fn(), error: vi.fn() } },
        {
          provide: ServiceCatalogService,
          useValue: {
            services: signal(servicios),
            providers: signal(doctores),
            loading: signal(false),
            hasServices: signal(servicios.length > 0),
            refresh: () => of(servicios),
            search: (term: string) =>
              servicios.filter((s) => s.name.toLowerCase().includes(term.toLowerCase())),
            findByCode: (code: string) =>
              servicios.find((s) => s.code.toLowerCase() === code.trim().toLowerCase()) ?? null,
            providerById: (id: string) => doctores.find((d) => d.id === id) ?? null,
          },
        },
        PromoService,
        CartStorageService,
        HeldSaleStorageService,
      ],
    });

    fixture = TestBed.createComponent(Sale);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  /**
   * Al cajero se le pide el turno de entrada porque sin él no puede vender.
   * El admin entra a consultar, mover efectivo o dar entrada de stock, y para
   * él ese diálogo —que no se puede cerrar— era una puerta tapiada.
   */
  /**
   * Turno que quedó abierto de un día anterior. Sustituye al auto-cierre de
   * medianoche: ahora se liquida al entrar —movimientos y ventas primero, el
   * cierre al final— con la pantalla bloqueada, y solo cuando termina se ofrece
   * abrir el turno nuevo.
   */
  describe('liquidación del turno rezagado antes de abrir', () => {
    /** Liquidación que no termina hasta que la prueba lo decide. */
    function conLiquidacionEnVuelo() {
      let terminar!: () => void;
      const enVuelo = new Promise<boolean>((resolve) => {
        terminar = () => resolve(true);
      });
      const bloqueo = signal(false);
      syncSchedulerMock = {
        pullPromotions: vi.fn(() => Promise.resolve(true)),
        // Enciende el bloqueo solo cuando de verdad hay turno rezagado, igual
        // que el sincronizador real: si se encendiera antes, el modal
        // parpadearía en cada entrada a Ventas.
        settleStaleShift: vi.fn(() => {
          bloqueo.set(true);
          return enVuelo.then((valor) => {
            bloqueo.set(false);
            return valor;
          });
        }),
        settlingStaleShift: bloqueo,
      };
      return () => terminar();
    }

    it('no ofrece abrir turno mientras se liquida el anterior', async () => {
      isOpen.set(false);
      const terminar = conLiquidacionEnVuelo();
      await build();

      // Abrir un turno nuevo encima del de ayer es justo lo que no debe pasar.
      expect(component.settlingStaleShift()).toBe(true);
      expect(component.cashSessionDialogVisible()).toBe(false);

      terminar();
      // La cadena `finalize` + `switchMap` encadena varios turnos de microtareas.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.settlingStaleShift()).toBe(false);
      expect(component.cashSessionDialogVisible()).toBe(true);
    });

    /**
     * El caso normal —no hay turno rezagado— es el 99 % de las entradas a
     * Ventas. El bloqueo se encendía al **empezar** a averiguarlo, así que el
     * modal parpadeaba en cada entrada: un pantallazo sin motivo.
     */
    it('sin turno rezagado no parpadea el bloqueo al entrar', async () => {
      isOpen.set(false);
      await build();

      expect(component.settlingStaleShift()).toBe(false);
      expect(fixture.nativeElement.querySelector('[data-testid="settling-stale-shift"]')).toBeNull();
    });

    it('el bloqueo se ve en pantalla y no se puede descartar', async () => {
      isOpen.set(false);
      conLiquidacionEnVuelo();
      await build();

      const bloqueo = fixture.nativeElement.querySelector('[data-testid="settling-stale-shift"]');
      expect(bloqueo).not.toBeNull();
    });

    it('si la liquidación falla, la caja no se queda bloqueada', async () => {
      // Lo que no subió queda en cola o en bloqueados, visible en la barra.
      isOpen.set(false);
      syncSchedulerMock = {
        settleStaleShift: vi.fn(() => Promise.reject(new Error('sin red'))),
        settlingStaleShift: signal(false),
        pullPromotions: vi.fn(() => Promise.resolve(true)),
      };
      await build();

      expect(component.settlingStaleShift()).toBe(false);
      expect(component.cashSessionDialogVisible()).toBe(true);
    });
  });

  describe('entrar sin turno abierto', () => {
    it('al cajero se le abre el diálogo de apertura', async () => {
      isOpen.set(false);
      await build();

      expect(component.cashSessionDialogVisible()).toBe(true);
    });

    it('al admin no: entra directo', async () => {
      isOpen.set(false);
      isAdmin.set(true);
      await build();

      expect(component.cashSessionDialogVisible()).toBe(false);
    });

    it('el admin sigue sin poder vender hasta abrir turno', async () => {
      isOpen.set(false);
      isAdmin.set(true);
      await build();

      component.addToCart(product());

      expect(component.cart()).toHaveLength(0);
      expect(component.cashSessionDialogVisible()).toBe(true);
    });
  });

  describe('totales', () => {
    it('suma subtotal, descuento y total del ticket', () => {
      component.addToCart(product(), 2);
      component.addToCart(product({ id: 'p2', sku: 'SKU2', salePrice: 30 }), 1);

      expect(component.subtotal()).toBe(130);
      expect(component.itemCount()).toBe(3);
      expect(component.total()).toBe(130);
    });

    it('el total nunca baja de cero por más descuento que se capture', () => {
      // Un descuento total lo autoriza un administrador (arriba del 20%).
      isAdmin.set(true);
      component.addToCart(product(), 1);
      component.updateLineDiscount('product:p1', 999);

      expect(component.cart()[0].discountAmount).toBe(50);
      expect(component.total()).toBe(0);
    });
  });

  describe('agregar al carrito', () => {
    it('acumula la cantidad al repetir el mismo producto', () => {
      component.addToCart(product(), 1);
      component.addToCart(product(), 2);

      expect(component.cart()).toHaveLength(1);
      expect(component.cart()[0].quantity).toBe(3);
    });

    it('un producto sin stock no entra al ticket', () => {
      component.addToCart(product({ stock: 0 }));
      expect(component.cart()).toHaveLength(0);
      expect(notifyError).toHaveBeenCalled();
    });

    it('no deja pasar del stock disponible', () => {
      component.addToCart(product({ stock: 2 }), 2);
      component.addToCart(product({ stock: 2 }), 1);

      expect(component.cart()[0].quantity).toBe(2);
      expect(notifyError).toHaveBeenCalledWith('Sin stock suficiente para agregar otra unidad.');
    });

    it('con todo el stock vencido no vende', () => {
      // Fecha fija y lejana: la caducidad se compara por día de México (SPEC 57) y
      // «ayer» a las 18:00+ cae en el día UTC de hoy, que todavía se vende.
      batches = [batch({ expiryDate: new Date('2020-01-01T00:00:00.000Z') })];
      component.addToCart(product());

      expect(component.cart()).toHaveLength(0);
      expect(notifyError).toHaveBeenCalledWith('El stock disponible está vencido.');
    });

    it('avisa cuando el lote más próximo está por caducar, pero sí vende', () => {
      batches = [batch({ expiryDate: new Date(Date.now() + 5 * 86_400_000) })];
      component.addToCart(product());

      expect(component.cart()).toHaveLength(1);
      expect(notifyError.mock.calls.some(([message]) => String(message).includes('Caducidad próxima'))).toBe(true);
    });

    it('un controlado avisa que requiere receta al agregarlo, no al cobrar', () => {
      component.addToCart(product({ controlledGroup: 'II' }));

      expect(component.cart()).toHaveLength(1);
      expect(notifyError.mock.calls.some(([message]) => String(message).includes('receta'))).toBe(true);
    });

    it('sin turno abierto no se puede vender', () => {
      isOpen.set(false);
      component.addToCart(product());

      expect(component.cart()).toHaveLength(0);
      expect(component.cashSessionDialogVisible()).toBe(true);
    });

    describe('stock fresco antes de negar (SPEC 57)', () => {
      const flush = async () => {
        for (let i = 0; i < 5; i += 1) {
          await Promise.resolve();
        }
      };

      it('con stock local 0 y servidor 5, agregar 2 piezas funciona tras la consulta', async () => {
        const fresco = product({ remoteId: 'RmtP1', stock: 5 });
        refreshStock.mockImplementation(() => {
          batches = [batch({ quantity: 5 })];
          return Promise.resolve({ product: fresco, batches });
        });

        component.addToCart(product({ remoteId: 'RmtP1', stock: 0 }), 2);
        await flush();

        expect(refreshStock).toHaveBeenCalledTimes(1);
        expect(component.cart()).toHaveLength(1);
        expect(component.cart()[0].quantity).toBe(2);
        expect(notifyError).not.toHaveBeenCalledWith('Producto sin stock disponible.');
      });

      it('también al pasar del stock local con piezas ya en el ticket', async () => {
        batches = [batch({ quantity: 2 })];
        component.addToCart(product({ remoteId: 'RmtP1', stock: 2 }), 2);
        refreshStock.mockImplementation(() => {
          batches = [batch({ quantity: 6 })];
          return Promise.resolve({ product: product({ remoteId: 'RmtP1', stock: 6 }), batches });
        });

        component.addToCart(product({ remoteId: 'RmtP1', stock: 2 }), 3);
        await flush();

        expect(component.cart()[0].quantity).toBe(5);
      });

      it('si no consulta (sin red, sin remoteId o en antirrebote) niega en el acto como siempre', () => {
        component.addToCart(product({ remoteId: 'RmtP1', stock: 0 }));

        expect(refreshStock).toHaveBeenCalledTimes(1);
        expect(component.cart()).toHaveLength(0);
        expect(notifyError).toHaveBeenCalledWith('Producto sin stock disponible.');
      });

      it('si el servidor tampoco tiene, niega sin volver a consultar', async () => {
        refreshStock.mockImplementation(() =>
          Promise.resolve({ product: product({ remoteId: 'RmtP1', stock: 1 }), batches: [batch({ quantity: 1 })] }),
        );
        batches = [batch({ quantity: 1 })];

        component.addToCart(product({ remoteId: 'RmtP1', stock: 1 }), 3);
        await flush();

        expect(refreshStock).toHaveBeenCalledTimes(1);
        expect(component.cart()).toHaveLength(0);
        expect(notifyError).toHaveBeenCalledWith('Sin stock suficiente para agregar otra unidad.');
      });

      it('subir la cantidad en el ticket también consulta antes de negar', async () => {
        component.addToCart(product({ remoteId: 'RmtP1', stock: 2 }), 1);
        refreshStock.mockImplementation(() =>
          Promise.resolve({ product: product({ remoteId: 'RmtP1', stock: 8 }), batches: [batch({ quantity: 8 })] }),
        );

        component.updateQuantity('product:p1', 4);
        await flush();

        const [linea] = component.cart();
        expect(linea.quantity).toBe(4);
        expect(linea.kind === 'product' ? linea.product.stock : null).toBe(8);
      });
    });

    describe('caducidad por día de México (SPEC 57)', () => {
      afterEach(() => vi.useRealTimers());

      it('un lote que caduca hoy se vende hasta las 20:00 hora de México (y después)', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        // 2026-11-06 20:00 en México = 2026-11-07 02:00 UTC.
        vi.setSystemTime(new Date('2026-11-07T02:00:00Z'));
        batches = [batch({ expiryDate: new Date('2026-11-06T00:00:00Z'), quantity: 3 })];

        component.addToCart(product());

        expect(component.cart()).toHaveLength(1);
        expect(notifyError).not.toHaveBeenCalledWith('El stock disponible está vencido.');
        expect(
          notifyError.mock.calls.some(([message]) => String(message).includes('vence el 6/11/2026 (0 días)')),
        ).toBe(true);
      });

      it('al día siguiente en México ya no se vende', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-07T06:30:00Z'));
        batches = [batch({ expiryDate: new Date('2026-11-06T00:00:00Z'), quantity: 3 })];

        component.addToCart(product());

        expect(component.cart()).toHaveLength(0);
        expect(notifyError).toHaveBeenCalledWith('El stock disponible está vencido.');
      });
    });

    it('un rol sin permiso de venta se entera aquí y no con un 403 al cobrar', () => {
      canSell.set(false);
      component.addToCart(product());

      expect(component.cart()).toHaveLength(0);
      expect(notifyError).toHaveBeenCalledWith('Tu rol no tiene permiso para registrar ventas.');
    });
  });

  describe('cantidades', () => {
    beforeEach(() => component.addToCart(product(), 2));

    it('bajar de 1 quita la partida', () => {
      component.updateQuantity('product:p1', 0);
      expect(component.cart()).toHaveLength(0);
    });

    it('un campo vacío no se interpreta como cero', () => {
      component.updateQuantity('product:p1', null);
      expect(component.cart()[0].quantity).toBe(2);
    });

    it('no deja capturar más del stock', () => {
      component.updateQuantity('product:p1', 99);
      expect(component.cart()[0].quantity).toBe(2);
      expect(notifyError).toHaveBeenCalledWith('Cantidad supera el stock disponible.');
    });

    it('al rechazar una cantidad, el campo vuelve a mostrar la que sí se cobra', () => {
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        'input[type="number"][aria-label^="Cantidad de"]',
      )!;
      // El cajero teclea «99» con 2 en el ticket: se rechaza, pero el campo quedaba en 99.
      input.value = '99';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      expect(component.cart()[0].quantity).toBe(2);
      expect(input.value).toBe('2');
    });

    it('bumpQuantity suma y resta sobre la partida', () => {
      component.bumpQuantity('product:p1', 1);
      expect(component.cart()[0].quantity).toBe(3);
      component.bumpQuantity('product:p1', -1);
      expect(component.cart()[0].quantity).toBe(2);
    });
  });

  describe('descuentos', () => {
    beforeEach(() => component.addToCart(product(), 2));

    it('un descuento arriba del 20% exige administrador', () => {
      component.updateLineDiscount('product:p1', 30);

      expect(component.cart()[0].discountAmount).toBe(0);
      expect(notifyError).toHaveBeenCalledWith(
        'Descuento mayor a 20% requiere autorización de un administrador.',
      );
    });

    /**
     * Regresión: el descuento se guarda como importe absoluto y se reaplica en
     * cada cambio del carrito. 5 piezas de $50 con $50 de descuento son el 20%
     * exacto; al dejarlo en 2 piezas pasaba al 50% sin que nada lo revisara. La
     * venta se cobraba y el backend la rechazaba con 403 al sincronizar: dinero
     * cobrado que no quedaba registrado.
     */
    it('bajar la cantidad recorta el descuento al 20% de la línea', () => {
      component.updateQuantity('product:p1', 5);
      component.updateLineDiscount('product:p1', 50); // 20% de 5 × $50
      expect(component.cart()[0].discountAmount).toBe(50);

      component.updateQuantity('product:p1', 2);

      // 20% de 2 × $50 = $20.
      expect(component.cart()[0].discountAmount).toBe(20);
      expect(component.total()).toBe(80);
      expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('20% de la línea'));
    });

    it('el administrador conserva su descuento al cambiar la cantidad', () => {
      isAdmin.set(true);
      component.updateQuantity('product:p1', 5);
      component.updateLineDiscount('product:p1', 200);

      component.updateQuantity('product:p1', 2);

      // Su tope es la línea completa, no el 20%.
      expect(component.cart()[0].discountAmount).toBe(100);
    });

    it('subir la cantidad no toca el descuento: el porcentaje baja', () => {
      component.updateLineDiscount('product:p1', 20); // 20% de 2 × $50
      component.updateQuantity('product:p1', 4);

      expect(component.cart()[0].discountAmount).toBe(20);
    });

    /**
     * Una línea en promoción no admite descuento manual: el precio lo fijó la
     * gerencia. Un 2x1 (50 %) tampoco pide administrador por el tope del 20 %.
     */
    it('con un 2x1 el descuento queda bloqueado en el de la promo', () => {
      TestBed.inject(PromoService).setPromotions([
        {
          id: 'promo-1',
          name: '2x1',
          rule: { type: 'nxm', buy: 2, pay: 1 },
          productIds: ['p1'],
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: null,
          isActive: true,
        },
      ]);
      component.updateQuantity('product:p1', 2);
      expect(component.cart()[0].discountAmount).toBe(50);

      // El 2x1 (50 %) no pide administrador, y el manual no se le suma.
      component.updateLineDiscount('product:p1', 60);
      expect(component.cart()[0].discountAmount).toBe(50);
      expect(component.total()).toBe(50);
    });

    it('el administrador sí puede forzarlo', () => {
      isAdmin.set(true);
      component.updateLineDiscount('product:p1', 30);
      expect(component.cart()[0].discountAmount).toBe(30);
    });

    it('quitar la partida también borra su descuento manual', () => {
      component.updateLineDiscount('product:p1', 10);
      component.removeFromCart('product:p1');
      component.addToCart(product(), 1);

      expect(component.cart()[0].discountAmount).toBe(0);
    });
  });

  describe('ventas en pausa', () => {
    it('pausar guarda el ticket y deja la caja lista para otro', () => {
      component.addToCart(product(), 2);
      component.holdSale();

      expect(component.cart()).toHaveLength(0);
      expect(component.heldSales()).toHaveLength(1);
    });

    it('retomar exige que el ticket actual esté vacío', () => {
      component.addToCart(product(), 1);
      component.holdSale();
      component.addToCart(product({ id: 'p2', sku: 'SKU2' }), 1);

      component.resumeHeldSale(component.heldSales()[0].id);

      expect(notifyError).toHaveBeenCalledWith('Guarda o termina la venta actual antes de retomar otra.');
      expect(component.heldSales()).toHaveLength(1);
    });

    it('retomar restaura las partidas y saca la venta de la lista', () => {
      component.addToCart(product(), 2);
      component.holdSale();

      component.resumeHeldSale(component.heldSales()[0].id);

      expect(component.cart()).toHaveLength(1);
      expect(component.heldSales()).toHaveLength(0);
    });

    /**
     * Regresión F5: el manual se deducía al retomar como `discountAmount − promo
     * de ahora`. Si el sync retiraba la promo con la venta en pausa, los $50 del
     * 2x1 volvían como descuento manual del 50 % y el backend rechazaba la venta.
     */
    it('retomar tras retirarse la promo no convierte su descuento en manual', () => {
      const promos = TestBed.inject(PromoService);
      promos.setPromotions([
        {
          id: 'promo-1',
          name: '2x1',
          rule: { type: 'nxm', buy: 2, pay: 1 },
          productIds: ['p1'],
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: null,
          isActive: true,
        },
      ]);
      component.addToCart(product(), 2);
      expect(component.cart()[0].discountAmount).toBe(50);
      component.holdSale();

      promos.setPromotions([]);
      component.resumeHeldSale(component.heldSales()[0].id);

      expect(component.cart()[0].discountAmount).toBe(0);
      expect(component.total()).toBe(100);
    });

    it('una venta pausada vieja (sin manual guardado) se recorta al tope al retomar', () => {
      component.addToCart(product(), 2);
      component.updateLineDiscount('product:p1', 20);
      component.holdSale();
      const [held] = component.heldSales();
      // Forma de una venta pausada antes de guardar el manual aparte, con un
      // descuento que ya no cabe en el tope.
      component.heldSales.set([
        {
          ...held,
          manualDiscounts: undefined,
          lines: held.lines.map((line) => ({ ...line, discountAmount: 50 })),
        },
      ]);

      component.resumeHeldSale(held.id);

      expect(component.cart()[0].discountAmount).toBe(20);
    });
  });

  describe('atajos con diálogo abierto', () => {
    it('Esc con el cobro abierto no vacía el ticket', () => {
      component.addToCart(product(), 1);
      component.checkoutVisible.set(true);

      component.onEscape(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(component.cart()).toHaveLength(1);
    });

    it('F9 con un diálogo abierto no reabre el cobro', () => {
      component.cashSessionDialogVisible.set(true);
      component.addToCart(product(), 1);

      component.openCheckout(new KeyboardEvent('keydown', { key: 'F9' }));

      expect(component.checkoutVisible()).toBe(false);
    });

    it('F9 con el ticket vacío no abre el cobro', () => {
      component.openCheckout(new KeyboardEvent('keydown', { key: 'F9' }));
      expect(component.checkoutVisible()).toBe(false);
    });
  });

  describe('venta completada', () => {
    const sale = { id: 'v1', folio: 'V-000001', cashierId: 'u1' } as SaleModel;

    it('limpia el ticket y guarda la última venta', () => {
      component.addToCart(product(), 1);
      component.onSaleCompleted(sale);

      expect(component.cart()).toHaveLength(0);
      expect(component.checkoutVisible()).toBe(false);
      expect(component.lastSale()?.folio).toBe('V-000001');
      expect(notifySuccess).toHaveBeenCalled();
    });

    it('descuenta el stock visible en la búsqueda tras cobrar', () => {
      component.results.set([product({ stock: 2 })]);
      component.onSaleCompleted({
        ...sale,
        items: [{ productId: 'p1', quantity: 1 } as SaleModel['items'][number]],
      });

      expect(component.results()[0].stock).toBe(1);
    });

    it('una venta aún en cola no se puede anular', () => {
      component.onSaleCompleted({ ...sale, id: 'local-1', pendingPush: true } as SaleModel);

      expect(component.lastSaleQueueId()).toBe('local-1');
      component.voidLastSale('Cliente desistió');
      expect(saleServiceMock.void).not.toHaveBeenCalled();
    });

    it('un rechazo al anular se avisa en vez de dar la anulación por hecha', () => {
      saleServiceMock.void = vi.fn(() => throwError(() => new Error('Solo un administrador puede anular')));
      component.onSaleCompleted(sale);

      component.voidLastSale('Cliente desistió');

      expect(notifyError).toHaveBeenCalledWith('Solo un administrador puede anular');
    });
  });

  describe('cola offline', () => {
    /**
     * Las rechazadas viven en el shell (una sola insignia para ventas, gastos y
     * catálogo). Esta pantalla solo abre las que siguen en cola, y hasta ahora
     * ese diálogo no tenía quién lo abriera: el método existía sin botón.
     */
    it('sin ventas en cola no abre el diálogo de pendientes', () => {
      component.reviewPendingSales();
      expect(component.pendingDialogVisible()).toBe(false);
    });

    it('con ventas en cola abre el diálogo', () => {
      saleServiceMock.pendingSales.set([
        { queueId: 'k1', folioHint: '1 art. · $25.00', total: 25, waitingFor: null },
      ]);
      component.reviewPendingSales();
      expect(component.pendingDialogVisible()).toBe(true);
    });

    it('forzar el envío delega en el servicio', () => {
      component.flushPendingSales();
      expect(saleServiceMock.flushQueue).toHaveBeenCalled();
    });
  });

  describe('búsqueda del catálogo', () => {
    it('con una sola letra no consulta al servidor', async () => {
      const search = vi.fn(() => of([product()]));
      TestBed.inject(ProductService).search = search as never;

      component.onSearchChange('p');
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(search).not.toHaveBeenCalled();
      expect(component.results()).toEqual([]);
    });

    it('sin turno abierto tampoco consulta', async () => {
      const search = vi.fn(() => of([product()]));
      TestBed.inject(ProductService).search = search as never;
      isOpen.set(false);

      component.onSearchChange('paracetamol');
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(search).not.toHaveBeenCalled();
    });

    it('limpiar la búsqueda cancela la consulta pendiente del debounce', async () => {
      const search = vi.fn((term: string) => of([product()]));
      TestBed.inject(ProductService).search = search as never;

      component.onSearchChange('paracetamol');
      component.clearSearch();
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Tras escanear, el término tecleado ya no le sirve a nadie.
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][0]).toBe('');
    });
  });

  /**
   * Servicios: consultas y procedimientos que se cobran en el mismo ticket que
   * los medicamentos pero no son mercancía.
   */
  describe('servicios en el ticket', () => {
    it('un servicio que exige doctor no entra al ticket hasta elegirlo', () => {
      component.addServiceToCart(servicio());

      expect(component.performerDialogVisible()).toBe(true);
      expect(component.cart()).toHaveLength(0);
    });

    it('al elegir el doctor, la partida entra con su comisión', () => {
      component.addServiceToCart(servicio());
      component.onPerformerChosen({ id: 'dr-1', name: 'Dra. Ruiz' });

      const [linea] = component.cart();
      expect(linea.kind).toBe('service');
      expect(linea.kind === 'service' && linea.provider?.id).toBe('dr-1');
      expect(component.performerDialogVisible()).toBe(false);
    });

    it('cancelar el diálogo no agrega nada', () => {
      component.addServiceToCart(servicio());
      component.onPerformerDismissed();

      expect(component.cart()).toHaveLength(0);
      expect(component.performerDialogVisible()).toBe(false);
    });

    it('un servicio que no exige doctor entra directo', () => {
      component.addServiceToCart(servicio({ requiresPerformer: false }));

      expect(component.performerDialogVisible()).toBe(false);
      expect(component.cart()).toHaveLength(1);
    });

    it('recuerda el último doctor del turno para no preguntar dos veces igual', () => {
      component.addServiceToCart(servicio());
      component.onPerformerChosen({ id: 'dr-1', name: 'Dra. Ruiz' });

      expect(component.lastProviderId()).toBe('dr-1');
    });

    it('el mismo servicio con el mismo doctor acumula cantidad', () => {
      component.addServiceToCart(servicio({ requiresPerformer: false }));
      component.addServiceToCart(servicio({ requiresPerformer: false }));

      expect(component.cart()).toHaveLength(1);
      expect(component.cart()[0].quantity).toBe(2);
    });

    /** El doctor es parte de la identidad: dos doctores, dos comisiones. */
    it('el mismo servicio con dos doctores son dos partidas', () => {
      component.addServiceToCart(servicio());
      component.onPerformerChosen({ id: 'dr-1', name: 'Dra. Ruiz' });
      component.addServiceToCart(servicio());
      component.onPerformerChosen({ id: 'dr-2', name: 'Dr. Zavala' });

      expect(component.cart()).toHaveLength(2);
    });

    it('cambiar el doctor de una partida la reemplaza, no la duplica', () => {
      component.addServiceToCart(servicio());
      component.onPerformerChosen({ id: 'dr-1', name: 'Dra. Ruiz' });

      const linea = component.cart()[0];
      if (linea.kind !== 'service') throw new Error('se esperaba una partida de servicio');
      component.changeLineProvider(linea);
      component.onPerformerChosen({ id: 'dr-2', name: 'Dr. Zavala' });

      expect(component.cart()).toHaveLength(1);
      const actualizada = component.cart()[0];
      expect(actualizada.kind === 'service' && actualizada.provider?.id).toBe('dr-2');
    });

    it('un servicio no se puede agregar sin turno abierto', async () => {
      isOpen.set(false);
      isAdmin.set(true);
      await build();

      component.addServiceToCart(servicio({ requiresPerformer: false }));

      expect(component.cart()).toHaveLength(0);
    });

    it('el "+" de un servicio no está limitado por stock', () => {
      component.addServiceToCart(servicio({ requiresPerformer: false }));
      const clave = component.keyOf(component.cart()[0]);

      component.updateQuantity(clave, 999);

      expect(component.cart()[0].quantity).toBe(999);
      expect(notifyError).not.toHaveBeenCalled();
    });

    it('el ticket suma medicamentos y servicios juntos', () => {
      component.addToCart(product());
      component.addServiceToCart(servicio({ requiresPerformer: false }));

      // 50 del medicamento + 200 del servicio.
      expect(component.total()).toBe(250);
      expect(component.cart()).toHaveLength(2);
    });

    describe('pestaña de servicios', () => {
      it('arranca en medicamentos', () => {
        expect(component.catalogTab()).toBe('products');
      });

      it('Alt+S la abre solo si hay servicios en el catálogo', () => {
        component.onServicesTabHotkey(new KeyboardEvent('keydown'));
        expect(component.catalogTab()).toBe('services');
      });

      it('Option+S de macOS (event.key "ß") abre la pestaña: el atajo va por event.code', () => {
        component.onTabHotkeys(new KeyboardEvent('keydown', { key: 'ß', code: 'KeyS', altKey: true }));
        expect(component.catalogTab()).toBe('services');

        component.onTabHotkeys(new KeyboardEvent('keydown', { key: 'µ', code: 'KeyM', altKey: true }));
        expect(component.catalogTab()).toBe('products');
      });

      it('sin Alt, S no cambia de pestaña', () => {
        component.onTabHotkeys(new KeyboardEvent('keydown', { key: 's', code: 'KeyS' }));
        expect(component.catalogTab()).toBe('products');
      });

      it('sin servicios en el catálogo, Alt+S no hace nada', async () => {
        servicios = [];
        await build();

        component.onServicesTabHotkey(new KeyboardEvent('keydown'));
        expect(component.catalogTab()).toBe('products');
      });

      /**
       * Candado del orden de despliegue: contra un backend viejo el pull de
       * servicios falla y el catálogo local queda vacío. Con el catálogo vacío
       * no hay forma de meter un servicio al ticket —ni por pestaña ni por
       * escáner—, así que un ticket mixto no puede llegar a un backend que no
       * lo entienda y terminar en `unreconciledSales`.
       */
      it('con el catálogo vacío, teclear un código de servicio no agrega nada', async () => {
        servicios = [];
        await build();

        component.onSearchChange('CONS-01');
        component.onSearchKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));

        expect(component.cart().some((line) => line.kind === 'service')).toBe(false);
      });

      /**
       * Regresión crítica: un cajero que dejó la pestaña en Servicios tiene que
       * poder seguir escaneando cajas de medicamento sin darse cuenta.
       */
      it('escanear con la pestaña de servicios activa agrega el MEDICAMENTO', () => {
        component.catalogTab.set('services');
        component.onSearchChange('PARA-500');
        component.onSearchKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));

        expect(component.cart()).toHaveLength(1);
        expect(component.cart()[0].kind).toBe('product');
      });

      it('si no hay medicamento con ese código, cae al código de servicio', () => {
        servicios = [servicio({ requiresPerformer: false, code: 'CONS-01' })];
        component.onSearchChange('CONS-01');
        component.onSearchKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));

        expect(component.cart()).toHaveLength(1);
        expect(component.cart()[0].kind).toBe('service');
      });
    });

    /**
     * La pestaña de servicios, en el DOM: tarjetas que se tocan con el dedo en
     * la tableta del mostrador. Que la tarjeta exista no basta — tiene que
     * quedar deshabilitada sin turno y meter la partida al pulsarla.
     */
    describe('pestaña de servicios — DOM', () => {
      function host(): HTMLElement {
        return fixture.nativeElement as HTMLElement;
      }

      function tarjetas(): HTMLButtonElement[] {
        return [...host().querySelectorAll<HTMLButtonElement>('[data-testid="service-card"]')];
      }

      async function abrirPestaña(): Promise<void> {
        host().querySelector<HTMLButtonElement>('[data-testid="tab-services"]')!.click();
        fixture.detectChanges();
        await fixture.whenStable();
      }

      beforeEach(() => fixture.detectChanges());

      it('las pestañas solo existen si la farmacia tiene servicios', async () => {
        expect(host().querySelector('[data-testid="tab-services"]')).not.toBeNull();

        servicios = [];
        await build();
        fixture.detectChanges();

        expect(host().querySelector('[data-testid="tab-services"]')).toBeNull();
      });

      it('el clic en la pestaña cambia la lista a servicios', async () => {
        await abrirPestaña();

        expect(component.catalogTab()).toBe('services');
        expect(tarjetas()).toHaveLength(1);
      });

      it('la tarjeta muestra nombre, precio, código y la comisión', async () => {
        await abrirPestaña();

        const tarjeta = tarjetas()[0];
        expect(tarjeta.textContent).toContain('Consulta general');
        expect(tarjeta.textContent).toContain('200.00');
        expect(tarjeta.textContent).toContain('CONS-01');
        // Lo que se comprueba es que la tarjeta declare comisión y que exija doctor.
        expect(tarjeta.textContent).toContain('Comisión');
        expect(tarjeta.textContent).toContain('Realizó');
        expect(tarjeta.getAttribute('aria-label')).toBe('Consulta general');
      });

      it('un servicio sin comisión no la anuncia', async () => {
        servicios = [servicio({ commissionRate: 0 })];
        await build();
        fixture.detectChanges();
        await abrirPestaña();

        expect(tarjetas()[0].textContent).not.toContain('Comisión');
      });

      it('la tarjeta tiene su propio buscador, con etiqueta accesible', async () => {
        await abrirPestaña();

        expect(host().querySelector('label[for="service-search"]')).not.toBeNull();
        expect(host().querySelector('#service-search')).not.toBeNull();
      });

      it('el buscador filtra las tarjetas', async () => {
        servicios = [servicio(), servicio({ id: 'sv-2', code: 'CUR-01', name: 'Curación' })];
        await build();
        fixture.detectChanges();
        await abrirPestaña();
        expect(tarjetas()).toHaveLength(2);

        component.serviceSearchTerm.set('cura');
        fixture.detectChanges();
        await fixture.whenStable();

        expect(tarjetas()).toHaveLength(1);
        expect(tarjetas()[0].textContent).toContain('Curación');
      });

      /**
       * Dos vacíos distintos: "el catálogo está vacío" manda a pedir alta de
       * servicios; "tu búsqueda no encontró nada" manda a borrar el texto.
       * Decir lo primero cuando pasó lo segundo hacía perder el viaje.
       */
      it('sin coincidencias avisa de la búsqueda, no de que el catálogo esté vacío', async () => {
        await abrirPestaña();
        component.serviceSearchTerm.set('resonancia magnética');
        fixture.detectChanges();
        await fixture.whenStable();

        const vacio = host().querySelector('[data-testid="services-empty"]');
        expect(tarjetas()).toHaveLength(0);
        expect(vacio!.textContent).toContain('Ningún servicio coincide');
        expect(vacio!.textContent).not.toContain('No hay servicios en el catálogo.');
      });

      it('sin turno abierto la tarjeta está deshabilitada y no agrega nada', async () => {
        isOpen.set(false);
        isAdmin.set(true);
        await build();
        fixture.detectChanges();
        await abrirPestaña();

        expect(tarjetas()[0].disabled).toBe(true);
        tarjetas()[0].click();
        expect(component.cart()).toHaveLength(0);
      });

      it('con turno, el clic en un servicio que exige doctor abre el selector sin meter la partida', async () => {
        await abrirPestaña();

        tarjetas()[0].click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(component.performerDialogVisible()).toBe(true);
        expect(component.cart()).toHaveLength(0);
        expect(host().querySelector('[data-testid="performer-option"]')).not.toBeNull();
      });

      it('elegir al doctor en el selector real mete la partida atribuida', async () => {
        await abrirPestaña();
        tarjetas()[0].click();
        fixture.detectChanges();
        await fixture.whenStable();

        host().querySelector<HTMLButtonElement>('[data-testid="performer-option"]')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(component.cart()).toHaveLength(1);
        const [linea] = component.cart();
        expect(linea.kind === 'service' && linea.provider?.id).toBe('dr-1');
      });

      it('un servicio que no exige doctor entra al ticket con un solo clic', async () => {
        servicios = [servicio({ requiresPerformer: false })];
        await build();
        fixture.detectChanges();
        await abrirPestaña();

        tarjetas()[0].click();

        expect(component.performerDialogVisible()).toBe(false);
        expect(component.cart()).toHaveLength(1);
      });

      /**
       * Un ticket recuperado de `localStorage` (o en pausa) puede traer la
       * partida sin doctor: el cobro lo bloquea, y sin este botón el cajero no
       * tenía forma de asignarlo — solo quitar la partida y recapturarla.
       */
      describe('partida de servicio sin doctor', () => {
        beforeEach(async () => {
          localStorage.setItem(
            'pos.current-cart.u1',
            JSON.stringify({
              lines: [
                { kind: 'service', service: servicio(), provider: null, quantity: 1, discountAmount: 0 },
              ],
              manualDiscounts: {},
              savedAt: new Date().toISOString(),
            }),
          );
          await build();
          fixture.detectChanges();
        });

        it('se recupera con el aviso de que falta quién lo realizó', () => {
          expect(component.cart()).toHaveLength(1);
          expect(host().querySelector('[data-testid="assign-performer"]')).not.toBeNull();
        });

        it('el aviso es pulsable y abre el selector de doctor', async () => {
          host().querySelector<HTMLButtonElement>('[data-testid="assign-performer"]')!.click();
          fixture.detectChanges();
          await fixture.whenStable();

          expect(component.performerDialogVisible()).toBe(true);
        });

        it('al elegir doctor, la partida queda atribuida y sin duplicarse', async () => {
          host().querySelector<HTMLButtonElement>('[data-testid="assign-performer"]')!.click();
          fixture.detectChanges();
          await fixture.whenStable();

          host().querySelector<HTMLButtonElement>('[data-testid="performer-option"]')!.click();
          fixture.detectChanges();
          await fixture.whenStable();

          expect(component.cart()).toHaveLength(1);
          const [linea] = component.cart();
          expect(linea.kind === 'service' && linea.provider?.id).toBe('dr-1');
          expect(host().querySelector('[data-testid="assign-performer"]')).toBeNull();
          expect(host().querySelector('[data-testid="change-performer"]')).not.toBeNull();
        });
      });

      it('una partida con doctor ofrece cambiarlo', async () => {
        await abrirPestaña();
        tarjetas()[0].click();
        fixture.detectChanges();
        await fixture.whenStable();
        host().querySelector<HTMLButtonElement>('[data-testid="performer-option"]')!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        const cambiar = host().querySelector<HTMLButtonElement>('[data-testid="change-performer"]');
        expect(cambiar).not.toBeNull();
        expect(cambiar!.getAttribute('aria-label')).toBeTruthy();

        cambiar!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(component.performerDialogVisible()).toBe(true);
      });
    });

    /**
     * Con el selector de doctor encima, los atajos de la venta no son de esta
     * pantalla: `Esc` cancela la elección, y si además llegara al atajo global
     * vaciaría el ticket que se estaba cobrando.
     */
    describe('atajos con el selector de doctor abierto', () => {
      beforeEach(() => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        component.addToCart(product());
        component.addServiceToCart(servicio());
        expect(component.performerDialogVisible()).toBe(true);
      });

      it('Esc no vacía el ticket', () => {
        component.onEscape(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(component.cart()).toHaveLength(1);
      });

      it('Esc tampoco limpia la búsqueda a media elección', () => {
        component.onSearchChange('para');

        component.onEscape(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(component.searchTerm()).toBe('para');
      });

      it('Del no quita la última partida', () => {
        component.onDeleteLine(new KeyboardEvent('keydown', { key: 'Delete' }));

        expect(component.cart()).toHaveLength(1);
      });

      it('+ y − no cambian la cantidad', () => {
        component.onSignedQtyKey(new KeyboardEvent('keydown', { key: '+' }));

        expect(component.cart()[0].quantity).toBe(1);
      });

      it('F9 no abre el cobro encima del selector', () => {
        component.openCheckout(new KeyboardEvent('keydown', { key: 'F9' }));

        expect(component.checkoutVisible()).toBe(false);
      });

      it('F6 no pausa la venta', () => {
        component.holdSaleFromHotkey(new KeyboardEvent('keydown', { key: 'F6' }));

        expect(component.heldSales()).toHaveLength(0);
        expect(component.cart()).toHaveLength(1);
      });

      it('Alt+S y Alt+M no cambian de pestaña detrás del modal', () => {
        component.onServicesTabHotkey(new KeyboardEvent('keydown'));
        expect(component.catalogTab()).toBe('products');

        component.catalogTab.set('services');
        component.onProductsTabHotkey(new KeyboardEvent('keydown'));
        expect(component.catalogTab()).toBe('services');
      });
    });

    describe('atajos de pestaña sin diálogos', () => {
      it('Alt+M vuelve a medicamentos', () => {
        component.catalogTab.set('services');

        component.onProductsTabHotkey(new KeyboardEvent('keydown'));

        expect(component.catalogTab()).toBe('products');
      });

      it('Alt+M/Alt+S tampoco se disparan con el diálogo de turno abierto', async () => {
        isOpen.set(false);
        await build();
        expect(component.cashSessionDialogVisible()).toBe(true);

        component.onServicesTabHotkey(new KeyboardEvent('keydown'));

        expect(component.catalogTab()).toBe('products');
      });
    });
  });
  describe('descartar una venta pendiente', () => {
    it('solo lo hace un administrador', () => {
      isAdmin.set(false);

      component.discardPendingSale({ queueId: 'v1', folioHint: '1 art. · $20.00' });

      expect(component.discardPendingTarget()).toBeNull();
      expect(saleServiceMock.discardSale).not.toHaveBeenCalled();
    });

    it('pide el motivo antes de borrar: puede ser una venta ya cobrada (SPEC 62)', () => {
      isAdmin.set(true);

      component.discardPendingSale({ queueId: 'v1', folioHint: '1 art. · $20.00' });

      expect(component.discardPendingTarget()?.queueId).toBe('v1');
      expect(saleServiceMock.discardSale).not.toHaveBeenCalled();
      component.cancelDiscardPending();
      expect(component.discardPendingTarget()).toBeNull();
    });

    it('con motivo, la descarta por el id local', async () => {
      isAdmin.set(true);

      component.discardPendingSale({ queueId: 'v1', folioHint: '1 art. · $20.00' });
      await component.confirmDiscardPending('Venta de prueba');

      expect(saleServiceMock.discardSale).toHaveBeenCalledWith('v1', 'Venta de prueba');
      expect(component.discardPendingTarget()).toBeNull();
    });

    it('si la caja la rechaza (ya salió al servidor) avisa y no la quita', async () => {
      isAdmin.set(true);
      saleServiceMock.discardSale.mockRejectedValueOnce(new Error('Ya está en el servidor; anúlala.'));

      component.discardPendingSale({ queueId: 'v1', folioHint: '1 art. · $20.00' });
      await component.confirmDiscardPending('Venta de prueba');

      expect(notifyError).toHaveBeenCalledWith('Ya está en el servidor; anúlala.');
      expect(component.discardPendingTarget()?.queueId).toBe('v1');
    });
  });


  /**
   * El ticket abierto sigue a las promociones: antes solo se recalculaba al
   * tocarlo, así que una promo que llegaba con el ticket armado no aplicaba y
   * una retirada o vencida seguía descontando.
   */
  describe('ticket abierto y cambios de promociones', () => {
    const promo2x1 = {
      id: 'promo-1',
      name: '2x1',
      rule: { type: 'nxm' as const, buy: 2, pay: 1 },
      productIds: ['p1'],
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: null,
      isActive: true,
    };

    it('una promo que llega con el ticket armado se aplica', () => {
      component.addToCart(product(), 2);
      TestBed.inject(PromoService).setPromotions([promo2x1]);
      TestBed.tick();
      expect(component.cart()[0].discountAmount).toBe(50);
    });

    it('una promo retirada por el sync deja de descontar', () => {
      TestBed.inject(PromoService).setPromotions([promo2x1]);
      TestBed.tick();
      component.addToCart(product(), 2);
      TestBed.inject(PromoService).setPromotions([]);
      TestBed.tick();
      const [line] = component.cart() as Array<{ discountAmount: number; promotion?: unknown }>;
      expect(line.discountAmount).toBe(0);
      expect(line.promotion ?? null).toBeNull();
    });

    it('al abrir el cobro se descarta una promo que venció con el ticket abierto', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
        TestBed.inject(PromoService).setPromotions([
          { ...promo2x1, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-25T10:05:00Z' },
        ]);
        TestBed.tick();
        component.addToCart(product(), 2);
        expect(component.cart()[0].discountAmount).toBe(50);

        vi.setSystemTime(new Date('2026-09-25T10:10:00Z'));
        component.openCheckout();
        expect(component.cart()[0].discountAmount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('con el cobro abierto un sync no cambia el total; al cancelar sí se aplica', () => {
      component.addToCart(product(), 2);
      component.openCheckout();
      expect(component.checkoutVisible()).toBe(true);

      TestBed.inject(PromoService).setPromotions([promo2x1]);
      TestBed.tick();
      // El diálogo muestra `total()` en vivo: cambiarlo a media venta deja mal
      // el cambio calculado o la order de la terminal creada por otro monto.
      expect(component.total()).toBe(100);

      component.checkoutVisible.set(false);
      TestBed.tick();
      expect(component.total()).toBe(50);
    });

    it('si entra una promo, el manual se deja de aplicar y vuelve si la promo sale', () => {
      component.addToCart(product(), 2);
      component.updateLineDiscount('product:p1', 20); // 20 % de $100, sin promo
      TestBed.inject(PromoService).setPromotions([promo2x1]);
      TestBed.tick();
      expect(component.cart()[0].discountAmount).toBe(50);

      TestBed.inject(PromoService).setPromotions([]);
      TestBed.tick();
      expect(component.cart()[0].discountAmount).toBe(20);
    });
  });
  /**
   * Autorrecuperación ante una promo que cerró al cobrar: el cobro no registró
   * nada, así que la pantalla baja promociones, espera a que `PromoService` las
   * relea, recalcula y pide volver a cobrar con el total nuevo.
   */
  describe('promoción cerrada al cobrar', () => {
    const promo2x1 = {
      id: 'promo-1',
      name: '2x1',
      rule: { type: 'nxm' as const, buy: 2, pay: 1 },
      productIds: ['p1'],
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: null,
      isActive: true,
    };

    it('baja promociones, espera la relectura, recalcula y avisa el total nuevo', async () => {
      const promos = TestBed.inject(PromoService);
      promos.setPromotions([promo2x1]);
      TestBed.tick();
      component.addToCart(product(), 2);
      expect(component.total()).toBe(50);
      component.openCheckout();

      // El pull trae la baja; `reload` la lee del SQLite (aquí, el mock).
      const orden: string[] = [];
      syncSchedulerMock.pullPromotions.mockImplementation(async () => {
        orden.push('pull');
        return true;
      });
      const reload = vi.spyOn(promos, 'reload').mockImplementation(async () => {
        orden.push('reload');
        promos.setPromotions([]);
      });

      await component.onPromotionClosed('2x1');

      expect(orden).toEqual(['pull', 'reload']);
      expect(reload).toHaveBeenCalled();
      expect(component.checkoutVisible()).toBe(false);
      expect(component.total()).toBe(100);
      expect(notifyWarn).toHaveBeenCalledWith(
        'La promoción 2x1 ya terminó. Nuevo total $100.00. Vuelve a cobrar.',
        'Promoción terminada',
      );
      // Nada se registró ni se encoló: el ticket sigue ahí para volver a cobrar.
      expect(component.cart()).toHaveLength(1);
      expect(component.lastSale()).toBeNull();
      expect(notifySuccess).not.toHaveBeenCalled();
    });

    it('sin red no se queda colgada: recalcula con lo que ya tiene', async () => {
      vi.useFakeTimers();
      try {
        const promos = TestBed.inject(PromoService);
        promos.setPromotions([promo2x1]);
        component.addToCart(product(), 2);
        syncSchedulerMock.pullPromotions.mockReturnValue(new Promise(() => undefined));
        vi.spyOn(promos, 'reload').mockImplementation(async () => promos.setPromotions([]));

        const recuperacion = component.onPromotionClosed('2x1');
        expect(component.recoveringPromotion()).toBe(true);
        // Mientras refresca no se puede reabrir el cobro con el precio viejo.
        component.openCheckout();
        expect(component.checkoutVisible()).toBe(false);

        await vi.advanceTimersByTimeAsync(8_000);
        await recuperacion;

        expect(component.recoveringPromotion()).toBe(false);
        expect(component.total()).toBe(100);
        expect(notifyWarn).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('indicadores de promociones en pantalla', () => {
    const tiered = {
      id: 'promo-1',
      name: '2 por $90',
      rule: { type: 'tiered' as const, tiers: [{ quantity: 2, price: 90 }] },
      productIds: ['p1'],
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: null,
      isActive: true,
    };

    it('marca "Promo" en los resultados de búsqueda del producto con promo vigente', () => {
      TestBed.inject(PromoService).setPromotions([tiered]);
      component.results.set([product(), product({ id: 'p2', name: 'Ibuprofeno' })]);
      fixture.detectChanges();

      const badges = fixture.nativeElement.querySelectorAll('[data-testid="search-promo-badge"]');
      expect(badges).toHaveLength(1);
      expect(component.hasPromotion(product())).toBe(true);
      expect(component.hasPromotion(product({ id: 'p2' }))).toBe(false);
    });

    it('sugiere llevar una más bajo la partida, y deja de hacerlo al completar el paquete', () => {
      TestBed.inject(PromoService).setPromotions([tiered]);
      TestBed.tick();
      component.addToCart(product(), 1);
      fixture.detectChanges();

      const hint = fixture.nativeElement.querySelector('[data-testid="promo-step-hint"]');
      expect(hint?.textContent.replace(/\s+/g, ' ').trim()).toBe(
        'Lleva 1 más: 2 por $90 (ahorras $10.00)',
      );

      component.bumpQuantity('product:p1', 1);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="promo-step-hint"]')).toBeNull();
    });

    it('no sugiere piezas que no hay en existencia', () => {
      TestBed.inject(PromoService).setPromotions([tiered]);
      batches = [batch({ quantity: 1 })];
      component.addToCart(product({ stock: 1 }), 1);
      expect(component.stepHintOf(component.cart()[0])).toBeNull();
    });

    it('avisa cuando la partida es de un producto sin sincronizar', () => {
      const w = window as unknown as { electronAPI?: unknown };
      const previo = w.electronAPI;
      w.electronAPI = {};
      try {
        component.addToCart(product({ remoteId: null }), 1);
        component.addToCart(product({ id: 'p2', remoteId: 'r-p2', name: 'Ibuprofeno' }), 1);
        fixture.detectChanges();

        const badges = fixture.nativeElement.querySelectorAll('[data-testid="unsynced-badge"]');
        expect(badges).toHaveLength(1);
        expect(badges[0].getAttribute('aria-label')).toBe(
          'Sin sincronizar: no entra a promociones hasta el próximo sync',
        );
      } finally {
        w.electronAPI = previo;
      }
    });
  });

  /** Venta por caja completa (SPEC 46). */
  describe('venta por caja', () => {
    const conCaja = (overrides: Partial<Product> = {}) =>
      product({ stock: 35, salePrice: 12, boxQuantity: 10, boxPrice: 100, boxBarcode: '17501001', ...overrides });

    beforeEach(() => {
      batches = [batch({ quantity: 35 })];
    });

    it('escanear el código de la caja agrega una línea por caja', () => {
      searchResults = [conCaja()];
      component.onSearchChange('17501001');
      component.onSearchKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));

      const [linea] = component.cart();
      expect(component.keyOf(linea)).toBe('product:p1:box');
      expect(linea.quantity).toBe(1);
      expect(component.total()).toBe(100);
    });

    it('el código de la pieza sigue agregando la pieza', () => {
      searchResults = [conCaja()];
      component.onSearchChange('7501001');
      component.onSearchKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(component.keyOf(component.cart()[0])).toBe('product:p1');
    });

    it('caja y piezas del mismo producto son dos líneas', () => {
      component.addToCart(conCaja(), 1, false, 'box');
      component.addToCart(conCaja(), 3);

      expect(component.cart().map((line) => component.keyOf(line))).toEqual(['product:p1:box', 'product:p1']);
      expect(component.total()).toBe(136);
    });

    it('el stock se valida en piezas sobre las dos líneas', () => {
      component.addToCart(conCaja(), 3, false, 'box'); // 30 piezas
      component.addToCart(conCaja(), 6); // 30 + 6 > 35

      expect(component.cart()).toHaveLength(1);
      expect(notifyError).toHaveBeenCalledWith('Sin stock suficiente para agregar otra unidad.');
      // Con 5 piezas libres no cabe otra caja.
      expect(component.maxFor(component.cart()[0])).toBe(3);
    });

    it('sin una caja completa en existencia no deja agregar la caja', () => {
      component.addToCart(conCaja({ stock: 8 }), 1, false, 'box');

      expect(component.cart()).toHaveLength(0);
      expect(notifyError).toHaveBeenCalledWith(
        'No hay una caja completa de Paracetamol: hay 8 pzas · 0 cajas completas.',
      );
    });

    it('la caja no entra a la promoción del producto', () => {
      TestBed.inject(PromoService).setPromotions([
        {
          id: 'promo-1',
          name: '2x1',
          rule: { type: 'nxm', buy: 2, pay: 1 },
          productIds: ['p1'],
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: null,
          isActive: true,
        },
      ]);
      component.addToCart(conCaja(), 2, false, 'box');

      expect(component.promotionOf(component.cart()[0])).toBeNull();
      expect(component.total()).toBe(200);
    });

    it('el descuento manual de la caja respeta el tope del 20 %', () => {
      component.addToCart(conCaja(), 1, false, 'box');
      component.updateLineDiscount('product:p1:box', 30);

      expect(component.cart()[0].discountAmount).toBe(0);
      expect(notifyError).toHaveBeenCalledWith('Descuento mayor a 20% requiere autorización de un administrador.');

      component.updateLineDiscount('product:p1:box', 20);
      expect(component.cart()[0].discountAmount).toBe(20);
    });

    it('cambiar la línea de pieza a caja deja las cajas completas que caben', () => {
      component.addToCart(conCaja(), 25);
      component.switchLineUnit('product:p1', 'box');

      const [linea] = component.cart();
      expect(component.keyOf(linea)).toBe('product:p1:box');
      expect(linea.quantity).toBe(2);

      component.switchLineUnit('product:p1:box', 'piece');
      expect(component.cart()[0].quantity).toBe(20);
    });

    it('la columna de acciones se ensancha solo si algún resultado se vende por caja', () => {
      const el = fixture.nativeElement as HTMLElement;
      const columna = () => el.querySelector('thead th:last-child');

      component.results.set([conCaja()]);
      fixture.detectChanges();
      expect(columna()?.classList.contains('w-56')).toBe(true);

      component.results.set([{ ...conCaja(), boxQuantity: undefined, boxPrice: undefined }]);
      fixture.detectChanges();
      expect(columna()?.classList.contains('w-28')).toBe(true);
    });

    it('el resultado de búsqueda ofrece Pieza | Caja (N) y las existencias en cajas', () => {
      component.results.set([conCaja()]);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;

      expect(el.querySelector('[data-testid="search-unit-picker"]')?.textContent).toContain('Caja (10)');
      expect(el.querySelector('[data-testid="search-box-stock"]')?.textContent?.trim()).toBe(
        '3 cajas',
      );
      (el.querySelector('[data-testid="search-add-box"]') as HTMLButtonElement).click();
      expect(component.keyOf(component.cart()[0])).toBe('product:p1:box');
    });

    it('la caja se guarda en el ticket autoguardado', () => {
      component.addToCart(conCaja(), 1, false, 'box');
      TestBed.tick();

      const stored = TestBed.inject(CartStorageService).load('u1');
      expect(stored?.lines[0]).toMatchObject({ saleUnit: 'box', quantity: 1 });
    });
  });

  /** Cupones de descuento (SPEC 47). */
  /** Mostrador robusto: borrador con llave, escáner exacto y búsquedas sin carreras (SPEC 66). */
  describe('mostrador robusto (SPEC 66)', () => {
    function borrador(idempotencyKey?: string): void {
      localStorage.setItem(
        'pos.current-cart.u1',
        JSON.stringify({
          lines: [{ kind: 'product', product: product(), quantity: 2, discountAmount: 0 }],
          manualDiscounts: {},
          ...(idempotencyKey ? { idempotencyKey } : {}),
          savedAt: new Date().toISOString(),
        }),
      );
    }

    /** Teclea `code` como el escáner: una ráfaga con 10 ms entre caracteres. */
    function escanear(code: string, terminador = 'Enter'): void {
      let reloj = 1_000_000;
      const ahora = vi.spyOn(Date, 'now').mockImplementation(() => reloj);
      for (const tecla of code) {
        reloj += 10;
        component.onSearchKeydown(new KeyboardEvent('keydown', { key: tecla }));
        component.onSearchChange(component.searchTerm() + tecla);
      }
      reloj += 10;
      component.onSearchKeydown(new KeyboardEvent('keydown', { key: terminador }));
      ahora.mockRestore();
    }

    /** Teclea `code` a mano: 200 ms entre teclas. */
    function teclear(code: string): void {
      let reloj = 1_000_000;
      const ahora = vi.spyOn(Date, 'now').mockImplementation(() => reloj);
      for (const tecla of code) {
        reloj += 200;
        component.onSearchKeydown(new KeyboardEvent('keydown', { key: tecla }));
        component.onSearchChange(component.searchTerm() + tecla);
      }
      reloj += 200;
      component.onSearchKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
      ahora.mockRestore();
    }

    describe('borrador con llave', () => {
      it('un borrador con la llave de una venta existente se descarta al restaurar', async () => {
        borrador('llave-cobrada-1');
        saleServiceMock.findByIdempotencyKey = vi.fn(() =>
          Promise.resolve({ id: 'local-1', folio: 'V-000123' } as SaleModel),
        );
        await build();
        await fixture.whenStable();

        expect(saleServiceMock.findByIdempotencyKey).toHaveBeenCalledWith('llave-cobrada-1');
        expect(component.cart()).toEqual([]);
        expect(notifyWarn).toHaveBeenCalledWith('La venta de este ticket ya se registró (folio V-000123)');
        expect(TestBed.inject(CartStorageService).load('u1')).toBeNull();
      });

      it('con la llave de un cobro que no se registró, el ticket se recupera', async () => {
        borrador('llave-sin-venta');
        await build();
        await fixture.whenStable();

        expect(component.cart()).toHaveLength(1);
        expect(notifyWarn).not.toHaveBeenCalledWith(expect.stringContaining('ya se registró'));
      });

      it('sin llave (nunca se abrió el cobro) se recupera sin consultar', async () => {
        borrador();
        await build();

        expect(component.cart()).toHaveLength(1);
        expect(saleServiceMock.findByIdempotencyKey).not.toHaveBeenCalled();
      });

      it('el borrador guarda la llave del cobro abierto y la olvida con el ticket', () => {
        component.addToCart(product(), 1);
        component.chargeKey.set('llave-abierta');
        TestBed.tick();
        expect(TestBed.inject(CartStorageService).load('u1')?.idempotencyKey).toBe('llave-abierta');

        component.onSaleCompleted({ id: 'v1', folio: 'V-1', items: [] } as unknown as SaleModel);
        component.addToCart(product(), 1);
        TestBed.tick();
        // La llave de la venta registrada no se hereda al ticket siguiente.
        expect(TestBed.inject(CartStorageService).load('u1')?.idempotencyKey).toBeNull();
      });
    });

    describe('escáner exacto', () => {
      it('el escaneo de un código inexistente que coincide en parte con un solo producto no lo agrega', () => {
        // La búsqueda difusa traería al Paracetamol (contiene "750100"), pero
        // el código exacto no existe.
        searchResults = [product({ barcode: '7501001' })];
        escanear('750100');

        expect(component.cart()).toEqual([]);
        expect(notifyError).toHaveBeenCalledWith('Código no encontrado');
        expect(component.searchTerm()).toBe('');
      });

      it('el escaneo de un código exacto agrega el producto', () => {
        escanear('7501001');

        expect(component.cart()).toHaveLength(1);
        expect(component.searchTerm()).toBe('');
      });

      it('el sufijo Tab del escáner se trata como Enter', () => {
        escanear('7501001', 'Tab');

        expect(component.cart()).toHaveLength(1);
      });

      it('un Tab a mano no busca nada', () => {
        component.onSearchChange('7501001');
        const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
        component.onSearchKeydown(tab);

        expect(component.cart()).toEqual([]);
        expect(tab.defaultPrevented).toBe(false);
      });

      it('a mano, una coincidencia parcial única sí se agrega (como antes)', () => {
        searchResults = [product({ barcode: '7501001' })];
        teclear('para');

        expect(component.cart()).toHaveLength(1);
      });

      it('un SKU numérico corto tecleado a mano gana por código exacto', () => {
        searchResults = [product({ id: 'p-12', sku: '12', barcode: '999' }), product({ id: 'p-120', sku: '120' })];
        teclear('12');

        expect(component.cart()).toHaveLength(1);
        expect((component.cart()[0] as { product: Product }).product.id).toBe('p-12');
      });

      it('a mano, sin resultado, el término vuelve a la caja para corregirlo', () => {
        searchResults = [];
        teclear('xyz9');

        expect(component.cart()).toEqual([]);
        expect(component.searchTerm()).toBe('xyz9');
        expect(notifyError).toHaveBeenCalledWith('Producto no encontrado.');
      });
    });

    describe('búsquedas sin carreras', () => {
      it('dos búsquedas seguidas solo aplican la última', () => {
        const pendientes = new Map<string, Subject<Product | null>>();
        barcodeLookup = (code: string) => {
          const respuesta = new Subject<Product | null>();
          pendientes.set(code, respuesta);
          return respuesta;
        };

        escanear('7501001');
        // El término ya se limpió antes de la siguiente: el segundo escaneo no se
        // pega al primero.
        expect(component.searchTerm()).toBe('');
        escanear('7502002');

        // La respuesta del primero llega tarde: no agrega nada.
        pendientes.get('7501001')!.next(product({ id: 'p-viejo', barcode: '7501001' }));
        expect(component.cart()).toEqual([]);

        pendientes.get('7502002')!.next(product({ id: 'p-nuevo', barcode: '7502002' }));
        expect(component.cart()).toHaveLength(1);
        expect((component.cart()[0] as { product: Product }).product.id).toBe('p-nuevo');
      });
    });
  });

  describe('cupones', () => {
    function cupon(overrides: Partial<CouponDto> = {}): CouponDto {
      return {
        id: 'VENTA20',
        code: 'VENTA20',
        name: 'Veinte de descuento',
        scope: 'sale',
        productIds: [],
        discount: { type: 'amount', amount: 20 },
        minPurchase: null,
        startsAt: new Date(Date.now() - 86_400_000).toISOString(),
        endsAt: null,
        maxUses: null,
        usedCount: 0,
        isActive: true,
        ...overrides,
      };
    }

    async function aplicar(code: string): Promise<void> {
      component.openCouponInput();
      component.onCouponCodeInput(code);
      await component.applyCoupon();
    }

    it('un código que no está en la caja lo dice así', async () => {
      component.addToCart(product(), 2);
      await aplicar('nada');

      expect(component.appliedCoupon()).toBeNull();
      expect(notifyError).toHaveBeenCalledWith('Cupón no encontrado — sincroniza o revisa el código');
    });

    it('el código se escribe en mayúsculas', () => {
      component.onCouponCodeInput('venta20');
      expect(component.couponCode()).toBe('VENTA20');
    });

    it('cupón de venta: baja el total, va al descuento total y se quita con ×', async () => {
      cupones['VENTA20'] = cupon();
      component.addToCart(product(), 2);
      await aplicar('venta20');

      expect(component.appliedCoupon()?.code).toBe('VENTA20');
      expect(component.couponSaleDiscount()).toBe(20);
      expect(component.discountTotal()).toBe(20);
      expect(component.total()).toBe(80);
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="coupon-chip"]')?.textContent).toContain(
        'Cupón VENTA20',
      );

      component.removeCoupon();
      expect(component.total()).toBe(100);
    });

    it('cupón de producto: descuenta la línea, deshabilita el manual y no toca la línea en promoción', async () => {
      cupones['PARA10'] = cupon({
        id: 'PARA10',
        code: 'PARA10',
        scope: 'product',
        productIds: ['p1', 'p2'],
        discount: { type: 'percent', percent: 10 },
      });
      TestBed.inject(PromoService).setPromotions([
        {
          id: 'promo-2',
          name: '2x1 ibuprofeno',
          rule: { type: 'nxm', buy: 2, pay: 1 },
          productIds: ['p2'],
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: null,
          isActive: true,
        },
      ]);
      component.addToCart(product(), 2);
      component.updateLineDiscount('product:p1', 10);
      component.addToCart(product({ id: 'p2', name: 'Ibuprofeno' }), 2);
      await aplicar('PARA10');

      const [para, ibu] = component.cart();
      expect(component.couponOf(para)).toEqual({ code: 'PARA10', discountAmount: 10 });
      expect(para.discountAmount).toBe(10);
      expect(component.couponOf(ibu)).toBeNull();
      expect(component.couponSkipped(ibu)).toBe(true);

      // El manual no se puede capturar en la línea con cupón.
      component.updateLineDiscount('product:p1', 5);
      expect(component.cart()[0].discountAmount).toBe(10);

      // Al quitar el cupón vuelve el manual guardado.
      component.removeCoupon();
      expect(component.cart()[0].discountAmount).toBe(10);
      expect(component.couponOf(component.cart()[0])).toBeNull();
    });

    it('si parece agotado avisa pero lo aplica: decide el servidor', async () => {
      cupones['VENTA20'] = cupon({ maxUses: 3, usedCount: 3 });
      component.addToCart(product(), 2);
      await aplicar('VENTA20');

      expect(component.appliedCoupon()).not.toBeNull();
      expect(notifyWarn).toHaveBeenCalledWith('Este cupón puede estar agotado; el servidor lo revisará', 'Cupón VENTA20');
    });

    it('sin alcanzar el mínimo no se aplica', async () => {
      cupones['VENTA20'] = cupon({ minPurchase: 500 });
      component.addToCart(product(), 2);
      await aplicar('VENTA20');

      expect(component.appliedCoupon()).toBeNull();
      expect(notifyError).toHaveBeenCalledWith('El cupón VENTA20 pide una compra mínima de $500.00.');
    });

    it('Esc en el campo del cupón lo cierra sin ofrecer vaciar el ticket', () => {
      component.addToCart(product(), 1);
      component.openCouponInput();
      const confirmSpy = vi.spyOn(window, 'confirm');
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      const stop = vi.spyOn(event, 'stopPropagation');

      component.onCouponKeydown(event);

      expect(stop).toHaveBeenCalled();
      expect(component.couponInputVisible()).toBe(false);
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('un cupón que vence con el ticket abierto se quita al cobrar y avisa el total nuevo', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
        cupones['VENTA20'] = cupon({ startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-03T10:05:00Z' });
        component.addToCart(product(), 2);
        await aplicar('VENTA20');
        expect(component.total()).toBe(80);

        vi.setSystemTime(new Date('2026-11-03T10:10:00Z'));
        component.openCheckout();

        expect(component.checkoutVisible()).toBe(false);
        expect(component.appliedCoupon()).toBeNull();
        expect(component.total()).toBe(100);
        expect(notifyWarn).toHaveBeenCalledWith(
          'El cupón VENTA20 ya venció. Se quitó del ticket. Nuevo total $100.00.',
          'Cupón retirado',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('el cobro que encuentra el cupón vencido no registra nada: se quita y se recalcula', async () => {
      cupones['VENTA20'] = cupon();
      component.addToCart(product(), 2);
      await aplicar('VENTA20');
      component.openCheckout();

      component.onCouponExpired('El cupón VENTA20 ya venció.');

      expect(component.checkoutVisible()).toBe(false);
      expect(component.appliedCoupon()).toBeNull();
      expect(component.total()).toBe(100);
    });

    it('el cupón viaja con el ticket autoguardado y con la venta en pausa', async () => {
      cupones['VENTA20'] = cupon();
      component.addToCart(product(), 2);
      await aplicar('VENTA20');
      TestBed.tick();
      expect(TestBed.inject(CartStorageService).load('u1')?.couponCode).toBe('VENTA20');

      component.holdSale();
      expect(component.appliedCoupon()).toBeNull();
      expect(component.heldSales()[0].couponCode).toBe('VENTA20');

      component.resumeHeldSale(component.heldSales()[0].id);
      await Promise.resolve();
      await Promise.resolve();
      expect(component.appliedCoupon()?.code).toBe('VENTA20');
      expect(component.total()).toBe(80);
    });

    it('al completar la venta el ticket nuevo arranca sin cupón', async () => {
      cupones['VENTA20'] = cupon();
      component.addToCart(product(), 2);
      await aplicar('VENTA20');

      component.onSaleCompleted({ id: 'v1', folio: 'V-1', items: [] } as unknown as SaleModel);

      expect(component.appliedCoupon()).toBeNull();
      expect(component.couponSaleDiscount()).toBe(0);
    });
  });
});
