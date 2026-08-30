import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../core/notifications/notification.service';
import { Category, Product, PurchaseInvoice } from '../../../shared/models';
import { CategoryService } from '../services/category.service';
import { ProductService } from '../services/product.service';
import { CreateStockEntryPayload, StockEntryService } from '../services/stock-entry.service';
import { StockEntryScreen } from './stock-entry';

function invoice(overrides: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    id: 'inv-1',
    invoiceNumber: 'FAC-123',
    invoiceDate: new Date('2026-08-20T00:00:00.000Z'),
    supplierId: 's1',
    supplierName: 'Distribuidora Norte',
    totalAmount: 4500,
    hasInvoice: true,
    ...overrides,
  };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    name: 'Paracetamol 500mg',
    sku: 'PARA-500',
    salePrice: 45,
    stock: 12,
    categoryId: 'cat-1',
    unit: 'caja',
    minStock: 5,
    hasIva: true,
    hasIvaZero: false,
    hasIeps: false,
    ...overrides,
  } as Product;
}

const categories: Category[] = [
  { id: 'cat-1', name: 'Analgésicos' },
  { id: 'cat-2', name: 'Antibióticos' },
];

/** Mañana, para que la caducidad no quede en el pasado. */
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

describe('StockEntryScreen', () => {
  let fixture: ComponentFixture<StockEntryScreen>;
  let component: StockEntryScreen;
  let listInvoices: () => Observable<PurchaseInvoice[]>;
  /** Se guardan los payloads: son lo que afirma casi cada prueba de guardado. */
  let createCalls: CreateStockEntryPayload[];
  let createEntry: (payload: CreateStockEntryPayload) => Observable<unknown>;
  let invalidate: ReturnType<typeof vi.fn>;
  let searchResults: Product[];
  let notifyError: ReturnType<typeof vi.fn>;
  let notifySuccess: ReturnType<typeof vi.fn>;

  async function build(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: notifySuccess } },
        {
          provide: StockEntryService,
          useValue: {
            listRecentInvoices: () => listInvoices(),
            create: (payload: CreateStockEntryPayload) => {
              createCalls.push(payload);
              return createEntry(payload);
            },
          },
        },
        { provide: CategoryService, useValue: { list: () => of(categories) } },
        { provide: ProductService, useValue: { search: () => of(searchResults), invalidate } },
      ],
    });

    fixture = TestBed.createComponent(StockEntryScreen);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  /** Deja el formulario en condiciones de guardar sobre un producto existente. */
  function fillValidEntry(): void {
    component.selectedInvoiceId.set('inv-1');
    component.selectProduct(product());
    component.lotNumber.set('L-2026-08');
    component.expiryDate.set(tomorrow);
    component.quantity.set(24);
  }

  beforeEach(async () => {
    notifyError = vi.fn();
    notifySuccess = vi.fn();
    invalidate = vi.fn();
    searchResults = [product()];
    listInvoices = () => of([invoice()]);
    createCalls = [];
    createEntry = () => of({ product: product({ stock: 36 }), stock: 36 });
    await build();
  });

  describe('carga', () => {
    it('ofrece las facturas recientes y sus categorías', () => {
      expect(component.invoices()).toHaveLength(1);
      expect(component.invoiceOptions()[0].label).toContain('FAC-123');
      expect(component.categoryOptions()).toHaveLength(2);
    });

    it('sin facturas explica que se dan de alta en el panel', async () => {
      listInvoices = () => of([]);
      await build();

      expect(component.invoicesError()).toContain('panel de administración');
    });

    it('un fallo al listar se muestra como banda persistente', async () => {
      listInvoices = () => throwError(() => new Error('API caída'));
      await build();

      expect(component.invoicesError()).toBe('API caída');
    });
  });

  describe('validación', () => {
    it('al abrir pide factura, producto, lote, caducidad y cantidad', () => {
      expect(component.canSubmit()).toBe(false);
      expect(component.blockers()).toEqual([
        'Elige la factura de la mercancía.',
        'Busca el producto o da de alta uno nuevo.',
        'Captura el número de lote.',
        'Captura la fecha de caducidad.',
        'Captura cuántas piezas entran.',
      ]);
    });

    it('con todo capturado se habilita', () => {
      fillValidEntry();
      expect(component.blockers()).toEqual([]);
      expect(component.canSubmit()).toBe(true);
    });

    it('no recibe mercancía vencida', () => {
      fillValidEntry();
      component.expiryDate.set('2020-01-01');

      expect(component.blockers()).toContain('La caducidad no puede estar en el pasado.');
    });

    it('un producto nuevo exige nombre, SKU, categoría y precio', () => {
      component.selectedInvoiceId.set('inv-1');
      component.startNewProduct();

      const blockers = component.blockers();
      expect(blockers).toContain('El nombre del producto es requerido.');
      expect(blockers).toContain('El SKU es requerido.');
      expect(blockers).toContain('Elige la categoría del producto.');
      expect(blockers).toContain('Captura el precio de venta.');
    });

    it('IVA e IVA cero no pueden ir juntos', () => {
      fillValidEntry();
      component.hasIvaZero.set(true);

      expect(component.blockers()).toContain('Un producto no puede tener IVA e IVA cero a la vez.');
    });

    it('el IEPS exige su tasa', () => {
      fillValidEntry();
      component.hasIeps.set(true);

      expect(component.blockers()).toContain('Captura la tasa de IEPS.');
    });

    it('el código de barras debe tener entre 8 y 14 dígitos', () => {
      fillValidEntry();
      component.barcode.set('123');

      expect(component.blockers()).toContain('El código de barras debe tener entre 8 y 14 dígitos.');
    });
  });

  describe('búsqueda', () => {
    it('con una sola letra no consulta el catálogo', () => {
      component.onSearchChange('p');

      expect(component.results()).toEqual([]);
      expect(component.searching()).toBe(false);
    });

    it('elegir un producto llena todos sus campos', () => {
      component.selectProduct(
        product({ activeIngredient: 'Paracetamol', concentration: '500 mg', iepsRate: 0.08, hasIeps: true }),
      );

      expect(component.name()).toBe('Paracetamol 500mg');
      expect(component.sku()).toBe('PARA-500');
      expect(component.categoryId()).toBe('cat-1');
      expect(component.unit()).toBe('caja');
      expect(component.salePrice()).toBe(45);
      expect(component.minStock()).toBe(5);
      // La tasa se guarda como fracción y se muestra como porcentaje.
      expect(component.iepsPercent()).toBe(8);
      expect(component.currentStock()).toBe(12);
    });

    it('dar de alta uno nuevo arranca en blanco con el término precargado', () => {
      component.onSearchChange('Amoxicilina');
      component.startNewProduct();

      expect(component.isNewProduct()).toBe(true);
      expect(component.name()).toBe('Amoxicilina');
      expect(component.currentStock()).toBe(0);
    });

    it('un término que parece código se precarga como SKU', () => {
      component.onSearchChange('AMOX-500');
      component.startNewProduct();

      expect(component.sku()).toBe('AMOX-500');
      expect(component.name()).toBe('');
    });
  });

  describe('guardar', () => {
    it('suma las piezas al stock actual en el resumen', () => {
      fillValidEntry();
      expect(component.currentStock()).toBe(12);
      expect(component.resultingStock()).toBe(36);
    });

    it('sobre un producto existente manda solo su id si nada cambió', () => {
      fillValidEntry();
      component.submit();

      const payload = createCalls[0];
      expect(payload.productId).toBe('p1');
      // Sin cambios no se manda `productUpdate`: ensuciaría la auditoría.
      expect(payload.productUpdate).toBeUndefined();
      expect(payload.product).toBeUndefined();
    });

    it('manda solo los campos que el cajero cambió', () => {
      fillValidEntry();
      component.salePrice.set(52);

      component.submit();

      const payload = createCalls[0];
      expect(payload.productUpdate).toEqual({ salePrice: 52 });
    });

    it('un producto nuevo viaja completo y con el IEPS en fracción', () => {
      component.selectedInvoiceId.set('inv-1');
      component.startNewProduct();
      component.name.set('Amoxicilina 500mg');
      component.sku.set('AMOX-500');
      component.categoryId.set('cat-2');
      component.salePrice.set(120);
      component.hasIeps.set(true);
      component.iepsPercent.set(8);
      component.lotNumber.set('L-9');
      component.expiryDate.set(tomorrow);
      component.quantity.set(10);

      component.submit();

      const payload = createCalls[0];
      expect(payload.productId).toBeUndefined();
      expect(payload.product).toMatchObject({
        name: 'Amoxicilina 500mg',
        sku: 'AMOX-500',
        categoryId: 'cat-2',
        salePrice: 120,
        hasIeps: true,
        // El backend espera fracción: 8 % es 0.08.
        iepsRate: 0.08,
      });
    });

    it('el costo es opcional y no viaja si está vacío', () => {
      fillValidEntry();
      component.submit();
      expect(createCalls[0].costPrice).toBeUndefined();

      fillValidEntry();
      component.costPrice.set(30.5);
      component.submit();
      expect(createCalls[1].costPrice).toBe(30.5);
    });

    it('tras guardar conserva la factura y limpia la partida', () => {
      fillValidEntry();
      component.submit();

      expect(component.selectedInvoiceId()).toBe('inv-1');
      expect(component.lotNumber()).toBe('');
      expect(component.expiryDate()).toBe('');
      expect(component.quantity()).toBeNull();
      expect(component.mode()).toBe('none');
      expect(component.lastResult()).toEqual({ name: 'Paracetamol 500mg', added: 24, stock: 36 });
    });

    it('invalida la caché del catálogo: el stock nuevo debe verse al vender', () => {
      fillValidEntry();
      component.submit();

      expect(invalidate).toHaveBeenCalled();
      expect(notifySuccess).toHaveBeenCalled();
    });

    it('un rechazo del servidor se avisa y no limpia la captura', () => {
      createEntry = () => throwError(() => new Error('El SKU ya existe'));
      fillValidEntry();

      component.submit();

      expect(notifyError).toHaveBeenCalledWith('El SKU ya existe');
      expect(component.lotNumber()).toBe('L-2026-08');
      expect(component.submitting()).toBe(false);
    });
  });
});
