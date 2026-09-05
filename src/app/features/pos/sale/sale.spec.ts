import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScanSoundService } from '../../../core/audio/scan-sound.service';
import { ServiceCatalogService } from '../services/service-catalog.service';
import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import {
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
  let batches: ProductBatch[];
  let isAdmin: ReturnType<typeof signal<boolean>>;
  let canSell: ReturnType<typeof signal<boolean>>;
  let isOpen: ReturnType<typeof signal<boolean>>;
  let servicios: PharmacyService[];
  let doctores: ServiceProvider[];
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
    servicios = [servicio()];
    doctores = [{ id: 'dr-1', name: 'Dra. Ruiz' }];
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

    await build();
  });

  /**
   * Reconstruible: las pruebas de arranque (qué pasa al ENTRAR sin turno)
   * necesitan fijar `isOpen`/`isAdmin` antes de que corra el constructor.
   */
  async function build(): Promise<void> {
    TestBed.resetTestingModule();
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
          // `cashOnHand` lo consume el diálogo de apertura que monta esta pantalla.
          useValue: {
            isOpen,
            current: signal(null),
            refreshCurrent: () => of(null),
            cashOnHand: () => of(0),
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
        // El loader de i18n de pruebas es vacío, así que el rótulo llega como
        // llave; lo que se comprueba es que la tarjeta declare comisión y que
        // exija doctor, no la traducción.
        expect(tarjeta.textContent).toContain('sale.services.commission');
        expect(tarjeta.textContent).toContain('sale.services.performer');
        expect(tarjeta.getAttribute('aria-label')).toBe('Consulta general');
      });

      it('un servicio sin comisión no la anuncia', async () => {
        servicios = [servicio({ commissionRate: 0 })];
        await build();
        fixture.detectChanges();
        await abrirPestaña();

        expect(tarjetas()[0].textContent).not.toContain('sale.services.commission');
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
        expect(vacio!.textContent).toContain('sale.services.noResults');
        expect(vacio!.textContent).not.toContain('sale.services.empty');
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
});
