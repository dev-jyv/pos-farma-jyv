import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScanSoundService } from '../../../core/audio/scan-sound.service';
import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { Product, ProductBatch, Sale as SaleModel } from '../../../shared/models';
import { BatchService } from '../services/batch.service';
import { CartStorageService } from '../services/cart-storage.service';
import { CashSessionService } from '../services/cash-session.service';
import { HeldSaleStorageService } from '../services/held-sale-storage.service';
import { ProductService } from '../services/product.service';
import { PromoService } from '../services/promo.service';
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
  let batches: ProductBatch[];
  let isAdmin: ReturnType<typeof signal<boolean>>;
  let canSell: ReturnType<typeof signal<boolean>>;
  let isOpen: ReturnType<typeof signal<boolean>>;
  let saleServiceMock: {
    pendingCount: ReturnType<typeof signal<number>>;
    pendingSales: ReturnType<typeof signal<unknown[]>>;
    blockedSales: ReturnType<typeof signal<unknown[]>>;
    void: ReturnType<typeof vi.fn>;
    flushQueue: ReturnType<typeof vi.fn>;
    retryBlockedSale: ReturnType<typeof vi.fn>;
    discardBlockedSale: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    localStorage.clear();
    notifyError = vi.fn();
    notifySuccess = vi.fn();
    batches = [batch()];
    isAdmin = signal(false);
    canSell = signal(true);
    isOpen = signal(true);
    saleServiceMock = {
      pendingCount: signal(0),
      pendingSales: signal<unknown[]>([]),
      blockedSales: signal<unknown[]>([]),
      void: vi.fn(() => of({ id: 'v1', folio: 'V-1' } as SaleModel)),
      flushQueue: vi.fn(),
      retryBlockedSale: vi.fn(),
      discardBlockedSale: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: notifySuccess } },
        { provide: ProductService, useValue: { search: () => of([product()]), invalidate: vi.fn() } },
        { provide: BatchService, useValue: { listByProduct: () => of(batches) } },
        { provide: SaleService, useValue: saleServiceMock },
        {
          provide: CashSessionService,
          useValue: { isOpen, current: signal(null), fetchCurrent: () => of(null) },
        },
        {
          provide: AuthService,
          useValue: { isAdmin, canSell, user: signal({ uid: 'u1', email: 'caja@farmajyv.mx' }) },
        },
        { provide: TicketPrintService, useValue: { printSale: vi.fn(), printProductLabel: vi.fn() } },
        { provide: ScanSoundService, useValue: { ok: vi.fn(), warn: vi.fn(), error: vi.fn() } },
        PromoService,
        CartStorageService,
        HeldSaleStorageService,
      ],
    });

    fixture = TestBed.createComponent(Sale);
    component = fixture.componentInstance;
    await fixture.whenStable();
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
      component.updateLineDiscount('p1', 999);

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
      batches = [batch({ expiryDate: new Date(Date.now() - 86_400_000) })];
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
      component.updateQuantity('p1', 0);
      expect(component.cart()).toHaveLength(0);
    });

    it('un campo vacío no se interpreta como cero', () => {
      component.updateQuantity('p1', null);
      expect(component.cart()[0].quantity).toBe(2);
    });

    it('no deja capturar más del stock', () => {
      component.updateQuantity('p1', 99);
      expect(component.cart()[0].quantity).toBe(2);
      expect(notifyError).toHaveBeenCalledWith('Cantidad supera el stock disponible.');
    });

    it('bumpQuantity suma y resta sobre la partida', () => {
      component.bumpQuantity('p1', 1);
      expect(component.cart()[0].quantity).toBe(3);
      component.bumpQuantity('p1', -1);
      expect(component.cart()[0].quantity).toBe(2);
    });
  });

  describe('descuentos', () => {
    beforeEach(() => component.addToCart(product(), 2));

    it('un descuento arriba del 20% exige administrador', () => {
      component.updateLineDiscount('p1', 30);

      expect(component.cart()[0].discountAmount).toBe(0);
      expect(notifyError).toHaveBeenCalledWith(
        'Descuento mayor a 20% requiere autorización de un administrador.',
      );
    });

    it('el administrador sí puede forzarlo', () => {
      isAdmin.set(true);
      component.updateLineDiscount('p1', 30);
      expect(component.cart()[0].discountAmount).toBe(30);
    });

    it('quitar la partida también borra su descuento manual', () => {
      component.updateLineDiscount('p1', 10);
      component.removeFromCart('p1');
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
      component.onSaleCompleted({ ...sale, id: 'offline-key-1' } as SaleModel);

      expect(component.lastSaleQueueId()).toBe('key-1');
      component.voidLastSale();
      expect(saleServiceMock.void).not.toHaveBeenCalled();
    });

    it('un rechazo al anular se avisa en vez de dar la anulación por hecha', () => {
      saleServiceMock.void = vi.fn(() => throwError(() => new Error('Solo un administrador puede anular')));
      component.onSaleCompleted(sale);

      component.voidLastSale();

      expect(notifyError).toHaveBeenCalledWith('Solo un administrador puede anular');
    });
  });

  describe('cola offline', () => {
    it('sin ventas bloqueadas no abre el diálogo de revisión', () => {
      component.reviewBlockedSales();
      expect(component.blockedDialogVisible()).toBe(false);
    });

    it('con ventas bloqueadas abre el diálogo', () => {
      saleServiceMock.blockedSales.set([{ queueId: 'k1', folioHint: '1 art.', reason: 'Turno cerrado' }]);
      component.reviewBlockedSales();
      expect(component.blockedDialogVisible()).toBe(true);
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
});
