import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { debounceTime, from, Subject, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { environment } from '../../../../environments/environment';
import { getApiErrorMessage } from '../../../core/api/api.utils';
import { ScanSoundService } from '../../../core/audio/scan-sound.service';
import { AuthService } from '../../../core/auth/auth.service';
import { SyncScheduler } from '../../../core/sync/sync-scheduler.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import {
  CartLine,
  CartServiceLine,
  HeldSale,
  PharmacyService,
  ServiceProvider,
  Product,
  ProductBatch,
  Sale as SaleModel,
  SaleItem,
  isSaleProductItem,
} from '../../../shared/models';
import {
  isProductLine,
  lineGross,
  lineKey,
  lineMaxQuantity,
  lineName,
  lineUnitPrice,
} from '../../../shared/utils/cart-line';
import { getControlledRule } from '../../../shared/utils/controlled';
import { BatchService } from '../services/batch.service';
import { CartStorageService } from '../services/cart-storage.service';
import { CashSessionService } from '../services/cash-session.service';
import { HeldSaleStorageService } from '../services/held-sale-storage.service';
import { ProductService } from '../services/product.service';
import { ServiceCatalogService } from '../services/service-catalog.service';
import { PromoService } from '../services/promo.service';
import { SaleService } from '../services/sale.service';
import { Checkout } from '../checkout/checkout';
import { CashSessionDialog } from '../cash-session/cash-session-dialog';
import { PerformerDialog } from './performer-dialog';
import { TicketPrintService } from '../ticket/ticket-print.service';
import { SubstitutesDialog } from './substitutes-dialog';

/**
 * Longitud mínima para consultar el catálogo. El backend resuelve la búsqueda
 * leyendo hasta 500 productos y filtrando en memoria, así que cada pulsación
 * cuesta; con menos de dos caracteres el resultado además no discrimina nada.
 */
const MIN_SEARCH_LENGTH = 2;

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - startOfToday().getTime()) / 86_400_000);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return target.isContentEditable;
}

@Component({
  selector: 'app-sale',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    FormsModule,
    TranslatePipe,
    ButtonModule,
    DialogModule,
    InputTextModule,
    TableModule,
    TooltipModule,
    Checkout,
    CashSessionDialog,
    PerformerDialog,
    SubstitutesDialog,
  ],
  templateUrl: './sale.html',
  host: {
    '(document:keydown.alt.m)': 'onProductsTabHotkey($event)',
    '(document:keydown.alt.s)': 'onServicesTabHotkey($event)',
    '(document:keydown.f2)': 'focusSearch($event)',
    '(document:keydown.f4)': 'focusLastQty($event)',
    '(document:keydown.f6)': 'holdSaleFromHotkey($event)',
    '(document:keydown.f9)': 'openCheckout($event)',
    '(document:keydown.escape)': 'onEscape($event)',
    '(document:keydown.delete)': 'onDeleteLine($event)',
    '(document:keydown.backspace)': 'onDeleteLine($event)',
    '(document:keydown)': 'onSignedQtyKey($event)',
  },
})
export class Sale {
  private readonly productService = inject(ProductService);
  private readonly serviceCatalog = inject(ServiceCatalogService);
  private readonly batchService = inject(BatchService);
  private readonly saleService = inject(SaleService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly authService = inject(AuthService);
  private readonly syncScheduler = inject(SyncScheduler);
  private readonly notifications = inject(NotificationService);
  private readonly ticketPrint = inject(TicketPrintService);
  private readonly sounds = inject(ScanSoundService);
  private readonly promoService = inject(PromoService);
  private readonly heldStorage = inject(HeldSaleStorageService);
  private readonly cartStorage = inject(CartStorageService);
  private readonly search$ = new Subject<string>();

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly lastQtyInput = viewChild<ElementRef<HTMLInputElement>>('lastQtyInput');

  readonly searchTerm = signal('');
  readonly results = signal<Product[]>([]);
  readonly cart = signal<CartLine[]>([]);
  readonly heldSales = signal<HeldSale[]>([]);
  readonly manualDiscounts = signal<Record<string, number>>({});
  readonly checkoutVisible = signal(false);
  readonly cashSessionDialogVisible = signal(false);
  /**
   * Se está liquidando el turno que quedó abierto de un día anterior: suben sus
   * movimientos, sus ventas y su cierre. Bloquea la pantalla hasta terminar —
   * operar encima significaría cobrar contra un turno que se está cerrando.
   *
   * La señal vive en el sincronizador y no aquí: solo él sabe si de verdad hay
   * un turno rezagado, y encenderla antes de saberlo hacía parpadear el modal
   * en cada entrada a Ventas.
   */
  readonly settlingStaleShift = this.syncScheduler.settlingStaleShift;
  readonly blockedDialogVisible = signal(false);
  readonly pendingDialogVisible = signal(false);
  readonly lastSale = signal<SaleModel | null>(null);
  readonly substitutesVisible = signal(false);
  readonly substitutesSource = signal<Product | null>(null);
  readonly substitutes = signal<Product[]>([]);

  readonly isAdmin = this.authService.isAdmin;
  readonly canSell = this.authService.canSell;
  readonly cashSessionOpen = this.cashSessionService.isOpen;
  readonly cashSession = this.cashSessionService.current;
  readonly pendingOfflineSales = this.saleService.pendingCount;
  readonly pendingSales = this.saleService.pendingSales;
  readonly blockedSales = this.saleService.blockedSales;

  readonly subtotal = computed(() =>
    this.cart().reduce((sum, line) => sum + lineUnitPrice(line) * line.quantity, 0),
  );
  readonly discountTotal = computed(() =>
    this.cart().reduce((sum, line) => sum + line.discountAmount, 0),
  );
  readonly total = computed(() => Math.max(0, this.subtotal() - this.discountTotal()));
  readonly itemCount = computed(() => this.cart().reduce((sum, line) => sum + line.quantity, 0));
  readonly lastLineId = computed(() => {
    const lines = this.cart();
    return lines.length ? lineKey(lines[lines.length - 1]) : null;
  });

  /* ── Lectura de una línea desde la plantilla ──────────────────────────── */
  // Expuestas como propiedades para que `sale.html` no tenga que ramificar por
  // tipo de partida en cada celda.
  /** Pestaña activa de la lista de resultados. */
  readonly catalogTab = signal<'products' | 'services'>('products');
  readonly serviceSearchTerm = signal('');
  readonly serviceResults = computed(() =>
    this.serviceCatalog.search(this.serviceSearchTerm()),
  );
  readonly hasServices = this.serviceCatalog.hasServices;
  /** Servicio esperando a que se elija el doctor. */
  private readonly pendingService = signal<{
    service: PharmacyService;
    quantity: number;
    fromScanner: boolean;
    replacingKey?: string;
  } | null>(null);
  readonly performerDialogVisible = signal(false);
  readonly pendingServiceName = computed(() => this.pendingService()?.service.name ?? '');
  /** Último doctor usado en el turno; se preselecciona en el diálogo. */
  readonly lastProviderId = signal<string | null>(null);

  readonly keyOf = lineKey;
  readonly nameOf = lineName;
  readonly unitPriceOf = lineUnitPrice;
  readonly maxQuantityOf = lineMaxQuantity;
  readonly grossOf = lineGross;
  readonly isProduct = isProductLine;
  /**
   * Id local de la última venta si aún no sincronizó (`pendingPush`). Toda venta nace
   * local-first, así que esto ya no depende de un prefijo en el id: es directo el
   * flag que pone `SaleService.create()` al escribir en SQLite.
   */
  readonly lastSaleQueueId = computed(() => {
    const sale = this.lastSale();
    return sale?.pendingPush ? sale.id : null;
  });

  constructor() {
    this.search$
      .pipe(
        debounceTime(500),
        // Sin `distinctUntilChanged()` a propósito: con él, borrar a menos del
        // mínimo y volver a teclear el MISMO término que antes (p. ej. "para" →
        // "p" → "para") lo descartaba como duplicado y la búsqueda no volvía a
        // dispararse — bug real encontrado en pruebas. El catálogo es local
        // (SQLite vía IPC), así que repetir la consulta no cuesta nada.
        // El término vacío corta la cadena sin salir a la red (`ProductService`
        // lo resuelve con una lista vacía) y sirve para cancelar el pendiente.
        switchMap((term) => this.productService.search(term)),
        takeUntilDestroyed(),
      )
      .subscribe((products) => this.results.set(products));

    // Catálogo de servicios y doctores: local, cacheado una vez por turno. Si la
    // farmacia no tiene servicios, la pestaña ni aparece.
    this.serviceCatalog.refresh().subscribe();

    const uid = this.authService.user()?.uid ?? '';
    /**
     * Antes de nada: si quedó un turno abierto de un día anterior, se liquida
     * **completo** —movimientos y ventas primero, cierre al final— y recién
     * entonces se lee el turno actual y se ofrece abrir uno nuevo. Sustituye al
     * auto-cierre de medianoche, que cerraba el turno con sus hijos todavía en
     * cola y los condenaba a "el turno de caja ya está cerrado".
     */
    from(
      this.syncScheduler
        .settleStaleShift(uid, this.authService.user()?.email ?? undefined)
        // Que la liquidación falle no puede dejar la caja bloqueada: lo que no
        // subió queda en cola o en bloqueados, visible en la barra.
        .catch(() => false),
    )
      .pipe(switchMap(() => this.cashSessionService.refreshCurrent(uid)))
      .subscribe(() => {
      // Al cajero se le pide el turno de entrada: sin él no puede vender, y
      // dejarlo pasar solo retrasa el descubrimiento hasta el primer cobro. El
      // admin entra sin abrir caja —viene a consultar, mover efectivo o dar
      // entrada de stock—; si va a vender, la barra le ofrece abrir turno y
      // `ensureShiftOpen()` lo detiene igual.
      if (!this.cashSessionOpen() && !this.isAdmin()) {
        this.cashSessionDialogVisible.set(true);
      }
      this.loadHeldSales();
      this.restoreCart();
      queueMicrotask(() => this.searchInput()?.nativeElement.focus());
    });

    // Autoguardado del ticket: la sesión puede caerse a las 24:00 o por un 401 y el
    // cajero no debería reescanear la venta al volver a entrar.
    effect(() => {
      const lines = this.cart();
      const uid = this.authService.user()?.uid ?? '';
      this.cartStorage.save(uid, lines, this.manualDiscounts());
    });
  }

  promoDiscount(line: CartLine): number {
    return this.promoService.promoOnlyDiscount(line);
  }

  clearCart(): void {
    if (this.cart().length === 0) {
      return;
    }
    if (!window.confirm('¿Vaciar el ticket actual?')) {
      return;
    }
    this.cart.set([]);
    this.manualDiscounts.set({});
  }

  holdSaleFromHotkey(event: Event): void {
    if (this.dialogOpen) {
      return;
    }
    event.preventDefault();
    this.holdSale();
  }

  /**
   * Con un diálogo abierto, los atajos de la pantalla de venta no deben dispararse:
   * `Esc` cierra el diálogo, y si además llegara aquí vaciaría el ticket que el cajero
   * estaba cobrando. Igual para `Del` y `+/−` sobre las líneas.
   */
  private get dialogOpen(): boolean {
    return (
      this.checkoutVisible() ||
      this.cashSessionDialogVisible() ||
      this.blockedDialogVisible() ||
      this.pendingDialogVisible() ||
      this.substitutesVisible() ||
      // El selector de doctor también cuenta: se abre desde el escáner con el
      // foco de vuelta en la búsqueda, y sin esto un `Esc` para cancelar la
      // elección además vaciaba el ticket que se estaba cobrando.
      this.performerDialogVisible()
    );
  }

  onEscape(event: Event): void {
    if (this.dialogOpen) {
      return;
    }
    if (this.searchTerm() || this.results().length > 0) {
      event.preventDefault();
      this.clearSearch();
      return;
    }
    if (this.cart().length > 0) {
      event.preventDefault();
      this.clearCart();
    }
  }

  onDeleteLine(event: Event): void {
    if (this.dialogOpen) {
      return;
    }
    if (isTypingTarget(event.target) && this.searchTerm()) {
      return;
    }
    if (isTypingTarget(event.target) && !(event.target instanceof HTMLInputElement && event.target === this.searchInput()?.nativeElement)) {
      return;
    }
    if (this.searchTerm()) {
      return;
    }
    const lastId = this.lastLineId();
    if (!lastId) {
      return;
    }
    event.preventDefault();
    this.removeFromCart(lastId);
  }

  onSignedQtyKey(event: KeyboardEvent): void {
    if (this.dialogOpen) {
      return;
    }
    if (event.key !== '+' && event.key !== '-' && event.key !== '=') {
      return;
    }
    if (isTypingTarget(event.target)) {
      return;
    }
    const lastId = this.lastLineId();
    if (!lastId) {
      return;
    }
    event.preventDefault();
    this.bumpQuantity(lastId, event.key === '-' ? -1 : 1);
  }

  focusLastQty(event: Event): void {
    if (this.dialogOpen) {
      return;
    }
    event.preventDefault();
    queueMicrotask(() => {
      const input = this.lastQtyInput()?.nativeElement;
      input?.focus();
      input?.select();
    });
  }

  onSearchChange(term: string): void {
    this.searchTerm.set(term);
    if (!this.cashSessionOpen()) {
      this.results.set([]);
      return;
    }
    // Con una sola letra el servidor recorre el catálogo para devolver medio
    // mostrador: no es una búsqueda útil y sí una consulta cara por pulsación.
    if (term.trim().length < MIN_SEARCH_LENGTH) {
      this.results.set([]);
      return;
    }
    this.search$.next(term);
  }

  onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.clearSearch();
      return;
    }
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    if (!this.ensureShiftOpen()) {
      return;
    }
    let raw = this.searchTerm().trim();
    if (!raw) {
      return;
    }

    let qty = 1;
    const qtyMatch = raw.match(/^(\d+)\*(.+)$/);
    if (qtyMatch) {
      qty = Math.min(999, Math.max(1, Number(qtyMatch[1])));
      raw = qtyMatch[2].trim();
    }
    if (!raw) {
      this.sounds.error();
      return;
    }

    this.productService.search(raw).subscribe((products) => {
      this.results.set(products);
      const normalized = raw.toLowerCase();
      // Prioridad, en este orden y por una razón en cada paso:
      // 1) coincidencia EXACTA de sku/código de barras: es lo que dispara el
      //    escáner y no puede perder nunca contra nada;
      // 2) coincidencia exacta del código de un servicio: si el cajero teclea
      //    "CONS-01", quiso la consulta, aunque la búsqueda de medicamentos
      //    haya devuelto por casualidad un único resultado difuso;
      // 3) resultado único de la búsqueda de medicamentos.
      const exacto = products.find(
        (product) =>
          product.sku?.toLowerCase() === normalized ||
          product.barcode?.toLowerCase() === normalized,
      );
      if (!exacto) {
        const service = this.serviceCatalog.findByCode(raw);
        if (service) {
          this.addServiceToCart(service, qty, true);
          this.clearSearch();
          queueMicrotask(() => this.searchInput()?.nativeElement.focus());
          return;
        }
      }
      const scanned = exacto ?? (products.length === 1 ? products[0] : null);

      if (!scanned) {
        this.sounds.error();
        this.notifications.error(
          products.length === 0
            ? 'Producto no encontrado.'
            : 'Hay varios resultados: elige uno de la lista.',
        );
        return;
      }

      this.addToCart(scanned, qty, true);
      this.clearSearch();
      queueMicrotask(() => this.searchInput()?.nativeElement.focus());
    });
  }

  focusSearch(event: Event): void {
    if (this.dialogOpen) {
      return;
    }
    event.preventDefault();
    const input = this.searchInput()?.nativeElement;
    input?.focus();
    input?.select();
  }

  clearSearch(): void {
    this.searchTerm.set('');
    this.results.set([]);
    // Cancela la búsqueda que quedó en el debounce: tras escanear, esa consulta
    // ya no le sirve a nadie y llegaría a pintar resultados de un término borrado.
    this.search$.next('');
  }

  addToCart(product: Product, qty = 1, fromScanner = false): void {
    if (!this.ensureShiftOpen()) {
      return;
    }
    const addQty = Math.max(1, Math.floor(qty));
    if (product.stock < 1) {
      this.sounds.error();
      this.openSubstitutes(product, 'Producto sin stock disponible.');
      return;
    }

    this.batchService.listByProduct(product.id).subscribe({
      next: (batches) => this.commitAdd(product, addQty, batches, fromScanner),
      error: () => this.commitAdd(product, addQty, null, fromScanner),
    });
  }

  selectSubstitute(product: Product): void {
    this.substitutesVisible.set(false);
    this.substitutesSource.set(null);
    this.addToCart(product);
  }

  closeSubstitutes(): void {
    this.substitutesVisible.set(false);
    this.substitutesSource.set(null);
    this.substitutes.set([]);
  }

  updateQuantity(productId: string, rawQuantity: number | null): void {
    // Campo vacío mientras el cajero reescribe la cantidad: no es un 0 deliberado.
    if (rawQuantity === null || !Number.isFinite(rawQuantity)) {
      return;
    }
    const quantity = Math.floor(rawQuantity);
    if (quantity < 1) {
      // Bajar de 1 es quitar la partida. Salir en silencio dejaba el `−` (y el atajo
      // `-`) sin efecto y sin explicación: el cajero repetía la tecla sin entender.
      this.removeFromCart(productId);
      return;
    }
    const line = this.cart().find((item) => lineKey(item) === productId);
    if (!line) {
      return;
    }
    // Un servicio no tiene existencias que agotar: `lineMaxQuantity` devuelve
    // `null` y la cantidad no se limita.
    const max = lineMaxQuantity(line);
    if (max !== null && quantity > max) {
      this.sounds.error();
      this.notifications.error('Cantidad supera el stock disponible.');
      return;
    }
    this.setCart(
      this.cart().map((item) => (lineKey(item) === productId ? { ...item, quantity } : item)),
    );
  }

  /* ── Servicios ────────────────────────────────────────────────────────── */

  /** `Alt+S` no debe abrir una pestaña que no existe si no hay servicios. */
  onServicesTabHotkey(event: Event): void {
    // Con un diálogo encima el atajo no es de esta pantalla: cambiar de pestaña
    // detrás del modal mueve la lista que el cajero va a encontrar al cerrarlo.
    if (this.dialogOpen || !this.hasServices()) {
      return;
    }
    event.preventDefault();
    this.catalogTab.set('services');
  }

  /** `Alt+M` vuelve a medicamentos, con el mismo candado de diálogo abierto. */
  onProductsTabHotkey(event: Event): void {
    if (this.dialogOpen) {
      return;
    }
    event.preventDefault();
    this.catalogTab.set('products');
  }

  /**
   * Agrega un servicio al ticket. No pasa por `addToCart`: ese camino valida
   * stock, pide lotes, aplica FEFO y avisa de caducidad, y ninguna de esas
   * cuatro cosas existe en un servicio.
   */
  addServiceToCart(service: PharmacyService, quantity = 1, fromScanner = false): void {
    if (!this.ensureShiftOpen()) {
      return;
    }
    // Si exige doctor, se pregunta ANTES de que la partida entre al ticket: la
    // comisión es parte de la partida y el corte la necesita atribuida.
    if (service.requiresPerformer) {
      this.pendingService.set({ service, quantity, fromScanner });
      this.performerDialogVisible.set(true);
      return;
    }
    this.commitServiceLine(service, null, quantity, fromScanner);
  }

  onPerformerChosen(provider: ServiceProvider): void {
    const pendiente = this.pendingService();
    this.performerDialogVisible.set(false);
    this.pendingService.set(null);
    if (!pendiente) {
      return;
    }
    // Se recuerda para el resto del turno: lo normal es que sea el mismo doctor
    // toda la jornada, y así el diálogo se resuelve con un Enter.
    this.lastProviderId.set(provider.id);
    this.commitServiceLine(
      pendiente.service,
      provider,
      pendiente.quantity,
      pendiente.fromScanner,
      pendiente.replacingKey,
    );
  }

  onPerformerDismissed(): void {
    this.performerDialogVisible.set(false);
    this.pendingService.set(null);
  }

  /** Reabre el selector para cambiar el doctor de una línea ya agregada. */
  changeLineProvider(line: CartServiceLine): void {
    this.pendingService.set({
      service: line.service,
      quantity: line.quantity,
      fromScanner: false,
      replacingKey: lineKey(line),
    });
    this.performerDialogVisible.set(true);
  }

  private commitServiceLine(
    service: PharmacyService,
    provider: ServiceProvider | null,
    quantity: number,
    fromScanner: boolean,
    // Se recibe explícito y no se lee de `pendingService`: quien llama ya lo
    // limpió, y leerlo de ahí dejaba la línea vieja en el ticket (partida
    // duplicada al cambiar de doctor).
    replacingKey?: string,
  ): void {
    const nueva: CartServiceLine = { kind: 'service', service, provider, quantity, discountAmount: 0 };
    const reemplaza = replacingKey ?? null;
    const clave = lineKey(nueva);

    let lineas = this.cart();
    if (reemplaza) {
      // Cambiar de doctor cambia la identidad de la línea, así que se sustituye
      // en su sitio en vez de mutarla.
      lineas = lineas.filter((line) => lineKey(line) !== reemplaza);
    }
    const existente = lineas.find((line) => lineKey(line) === clave);
    this.setCart(
      existente
        ? lineas.map((line) =>
            lineKey(line) === clave ? { ...line, quantity: line.quantity + quantity } : line,
          )
        : [...lineas, nueva],
    );
    if (fromScanner) {
      this.sounds.ok();
    }
  }

  bumpQuantity(productId: string, delta: number): void {
    const line = this.cart().find((item) => lineKey(item) === productId);
    if (!line) {
      return;
    }
    this.updateQuantity(productId, line.quantity + delta);
  }

  /**
   * El input de descuento es un binding no controlado (`[value]`, no
   * `[ngModel]`) a propósito: cuando el valor final que se aplica coincide con
   * el que ya tenía la línea (p. ej. un `-5` que se clampa de vuelta a `0`, o
   * un intento >20% que se rechaza), Angular no vuelve a escribir el DOM
   * porque el valor de `line.discountAmount` no cambió entre renders — el
   * `<input>` se quedaba mostrando literalmente lo que el cajero tecleó en vez
   * de lo que en verdad se cobra (bug real, encontrado en pruebas). Por eso
   * aquí se reescribe `inputEl.value` a mano en cada rama, sin depender de que
   * el binding detecte un cambio.
   */
  updateLineDiscount(productId: string, rawAmount: number, inputEl?: HTMLInputElement): void {
    const line = this.cart().find((item) => lineKey(item) === productId);
    if (!line) {
      return;
    }
    const lineTotal = lineUnitPrice(line) * line.quantity;
    const promo = this.promoService.promoOnlyDiscount(line);
    const totalDiscount = Math.min(Math.max(0, rawAmount), lineTotal);
    const manual = Math.max(0, totalDiscount - promo);
    const percentage = lineTotal === 0 ? 0 : (totalDiscount / lineTotal) * 100;
    if (percentage > 20 && !this.isAdmin()) {
      this.notifications.error('Descuento mayor a 20% requiere autorización de un administrador.');
      if (inputEl) {
        inputEl.value = String(line.discountAmount);
      }
      return;
    }
    this.manualDiscounts.update((map) => ({ ...map, [productId]: manual }));
    this.setCart(this.cart());
    if (inputEl) {
      inputEl.value = String(totalDiscount);
    }
  }

  removeFromCart(productId: string): void {
    const line = this.cart().find((item) => lineKey(item) === productId);
    if (line && line.quantity > 5 && !window.confirm(`Quitar ${line.quantity} × ${lineName(line)}?`)) {
      return;
    }
    this.manualDiscounts.update((map) => {
      const next = { ...map };
      delete next[productId];
      return next;
    });
    this.setCart(this.cart().filter((item) => lineKey(item) !== productId));
  }

  holdSale(): void {
    if (this.cart().length === 0) {
      return;
    }
    const held: HeldSale = {
      id: crypto.randomUUID(),
      label: `Venta en pausa ${new Date().toLocaleTimeString()}`,
      lines: this.cart(),
      heldAt: new Date(),
    };
    this.heldSales.update((list) => {
      const next = [...list, held];
      this.persistHeld(next);
      return next;
    });
    this.cart.set([]);
    this.manualDiscounts.set({});
  }

  resumeHeldSale(id: string): void {
    if (this.cart().length > 0) {
      this.notifications.error('Guarda o termina la venta actual antes de retomar otra.');
      return;
    }
    const held = this.heldSales().find((item) => item.id === id);
    if (!held) {
      return;
    }
    const manuals: Record<string, number> = {};
    for (const line of held.lines) {
      const promo = this.promoService.promoOnlyDiscount(line);
      manuals[lineKey(line)] = Math.max(0, line.discountAmount - promo);
    }
    this.manualDiscounts.set(manuals);
    this.setCart(held.lines);
    this.heldSales.update((list) => {
      const next = list.filter((item) => item.id !== id);
      this.persistHeld(next);
      return next;
    });
  }

  openCheckout(event?: Event): void {
    // F9 con el diálogo abierto lo maneja el propio checkout (confirma el cobro).
    if (this.dialogOpen) {
      return;
    }
    event?.preventDefault();
    if (!this.ensureShiftOpen()) {
      return;
    }
    if (this.cart().length === 0) {
      return;
    }
    this.checkoutVisible.set(true);
  }

  onSaleCompleted(sale: SaleModel): void {
    this.lastSale.set(sale);
    this.cart.set([]);
    this.manualDiscounts.set({});
    this.checkoutVisible.set(false);
    this.adjustResultsStock(sale.items, -1);
    this.refreshResultsAfterStockChange(sale);
    this.notifications.success(`Venta ${sale.folio} registrada.`);
    if (environment.printTicketOnSale) {
      // Esperar a que PrimeNG cierre el diálogo de cobro. Imprimir en el mismo tick
      // (sobre todo tras tarjeta, cuando el modal se cierra al confirmar) hace que
      // Electron/Chrome a veces no muestre el diálogo de impresión.
      window.setTimeout(() => this.printSale(sale), 400);
    }
  }

  printSale(sale: SaleModel = this.lastSale()!): void {
    if (!sale) {
      return;
    }
    this.ticketPrint.printSale(sale, this.authService.user()?.email ?? sale.cashierId);
  }

  printLabel(product: Product): void {
    this.ticketPrint.printProductLabel(product);
  }

  /**
   * Ventas offline que el servidor rechazó (turno cerrado, sin stock, order Point ya
   * usada). No se reintentan solas: el cajero corrige la causa y reintenta, o descarta
   * explícitamente. Descartar en silencio sería perder una venta ya cobrada.
   */
  reviewBlockedSales(): void {
    if (this.blockedSales().length === 0) {
      return;
    }
    this.blockedDialogVisible.set(true);
  }

  retryBlockedSale(queueId: string): void {
    this.saleService.retryBlockedSale(queueId);
    this.notifications.success('Reintentando el envío de la venta.');
    if (this.blockedSales().length === 0) {
      this.blockedDialogVisible.set(false);
    }
  }

  /**
   * Descarta una venta que sigue en cola (sin folio del servidor). **Solo admin**:
   * a diferencia de una rechazada —donde el servidor ya dijo que no la acepta—,
   * esta subiría sola en la próxima sincronización, así que borrarla es tirar una
   * venta que iba a registrarse bien. `discard` repone el stock que descontó.
   */
  discardPendingSale(item: { queueId: string; folioHint: string }): void {
    if (!this.isAdmin()) {
      return;
    }
    const confirmado = window.confirm(
      `¿Descartar la venta pendiente (${item.folioHint})?\n\n` +
        'Se borra de este equipo y nunca llegará al servidor. Si ya se cobró, ' +
        'quedará sin folio ni registro. El stock se repone.',
    );
    if (!confirmado) {
      return;
    }
    this.saleService.discardBlockedSale(item.queueId);
    this.notifications.success('Venta pendiente descartada.');
    if (this.pendingOfflineSales() === 0) {
      this.pendingDialogVisible.set(false);
    }
  }

  discardBlockedSale(queueId: string): void {
    if (!window.confirm('¿Descartar esta venta? Ya no se enviará al servidor.')) {
      return;
    }
    this.saleService.discardBlockedSale(queueId);
    if (this.blockedSales().length === 0) {
      this.blockedDialogVisible.set(false);
    }
  }

  /** Ventas en cola que todavía pueden salir solas; el cajero puede forzar el envío. */
  reviewPendingSales(): void {
    if (this.pendingSales().length === 0) {
      return;
    }
    this.pendingDialogVisible.set(true);
  }

  flushPendingSales(): void {
    this.saleService.flushQueue();
    this.notifications.success('Enviando las ventas pendientes.');
  }

  /**
   * Una venta que sigue en la cola no existe en el servidor: anularla es imposible y
   * lo único correcto es sacarla de la cola antes de que se envíe al reconectar.
   */
  discardLastSaleFromQueue(): void {
    const queueId = this.lastSaleQueueId();
    if (!queueId) {
      return;
    }
    if (!window.confirm('¿Descartar esta venta? Aún no se envió al servidor y no se registrará.')) {
      return;
    }
    this.saleService.discardBlockedSale(queueId);
    this.lastSale.set(null);
    this.notifications.success('Venta descartada de la cola.');
  }

  voidLastSale(): void {
    const sale = this.lastSale();
    if (!sale || this.lastSaleQueueId()) {
      return;
    }
    this.saleService.void(sale).subscribe({
      next: (voided) => {
        this.lastSale.set(voided);
        this.adjustResultsStock(voided.items, 1);
        this.refreshResultsAfterStockChange(voided);
        this.notifications.success('Venta anulada.');
      },
      // Sin handler, un rechazo del servidor dejaba al cajero creyendo que anuló.
      error: (error: unknown) => this.notifications.error(getApiErrorMessage(error)),
    });
  }

  /**
   * Ajusta el stock visible en la lista de búsqueda sin esperar otra consulta.
   * **Solo partidas de producto**: un servicio no tiene existencias, y recorrerlo
   * aquí ensuciaría la cuadrícula del catálogo con deltas que no significan nada.
   */
  private adjustResultsStock(items: SaleItem[] | undefined, sign: 1 | -1): void {
    if (!items?.length) {
      return;
    }
    const deltas = new Map<string, number>();
    for (const item of items) {
      if (!isSaleProductItem(item)) {
        continue;
      }
      deltas.set(item.productId, (deltas.get(item.productId) ?? 0) + item.quantity * sign);
    }
    this.results.update((list) =>
      list.map((product) => {
        const delta = deltas.get(product.id);
        return delta === undefined
          ? product
          : { ...product, stock: Math.max(0, product.stock + delta) };
      }),
    );
  }

  /**
   * Si la búsqueda sigue abierta, reconsulta el API para alinear con el servidor.
   * En ventas offline el backend aún no descontó: basta el ajuste local.
   */
  private refreshResultsAfterStockChange(sale: SaleModel): void {
    if (sale.id.startsWith('offline-')) {
      return;
    }
    const term = this.searchTerm().trim();
    if (!term) {
      return;
    }
    this.productService.search(term).subscribe((products) => this.results.set(products));
  }

  private commitAdd(
    product: Product,
    addQty: number,
    batches: ProductBatch[] | null,
    fromScanner: boolean,
  ): void {
    let sellableQty = product.stock;
    if (batches) {
      const sellable = this.sellableBatches(batches);
      sellableQty = sellable.reduce((sum, batch) => sum + batch.quantity, 0);
      if (sellableQty < 1) {
        this.sounds.error();
        this.openSubstitutes(product, 'El stock disponible está vencido.');
        return;
      }
      const nearest = sellable[0];
      const days = daysUntil(nearest.expiryDate);
      if (days <= environment.expiryWarningDays) {
        this.sounds.warn();
        this.notifications.error(
          `Caducidad próxima: lote ${nearest.lotNumber} vence el ${nearest.expiryDate.toLocaleDateString('es-MX')} (${days} días).`,
        );
      }
    }

    const existing = this.cart().find(
      (line) => isProductLine(line) && line.product.id === product.id,
    );
    const nextQty = (existing?.quantity ?? 0) + addQty;
    if (nextQty > sellableQty || nextQty > product.stock) {
      this.sounds.error();
      this.notifications.error('Sin stock suficiente para agregar otra unidad.');
      return;
    }

    const nextLines: CartLine[] = existing
      ? this.cart().map((line) =>
          isProductLine(line) && line.product.id === product.id
            ? { ...line, quantity: nextQty }
            : line,
        )
      : [...this.cart(), { kind: 'product', product, quantity: addQty, discountAmount: 0 }];

    this.setCart(nextLines);
    if (!existing) {
      this.warnIfControlled(product);
    }
    if (fromScanner) {
      this.sounds.ok();
    }
  }

  /**
   * Aviso al agregar un controlado: el cajero debe pedir la receta **en el
   * mostrador**, no descubrirlo al cobrar con el paciente ya guardando la cartera.
   */
  private warnIfControlled(product: Product): void {
    const rule = getControlledRule(product.controlledGroup);
    if (!rule?.requiresPrescription) {
      return;
    }
    this.sounds.warn();
    const extra = rule.retainsPrescription
      ? ' Se retiene la receta y se registra en el libro de control.'
      : rule.requiresLedger
        ? ' Queda registrada en el libro de control.'
        : '';
    this.notifications.error(`${product.name}: ${rule.label} — requiere receta médica.${extra}`);
  }

  private setCart(lines: CartLine[]): void {
    this.cart.set(this.promoService.apply(lines, this.manualDiscounts()));
  }

  private openSubstitutes(product: Product, message: string): void {
    this.notifications.error(message);
    const ingredient = product.activeIngredient?.trim();
    if (!ingredient) {
      return;
    }
    this.substitutesSource.set(product);
    this.productService.search(ingredient).subscribe((products) => {
      this.substitutes.set(
        products.filter((item) => item.id !== product.id && item.stock > 0),
      );
      this.substitutesVisible.set(true);
    });
  }

  private sellableBatches(batches: ProductBatch[]): ProductBatch[] {
    const today = startOfToday();
    return batches
      .filter((batch) => batch.quantity > 0 && batch.expiryDate >= today)
      .sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());
  }

  private restoreCart(): void {
    if (this.cart().length > 0) {
      return;
    }
    const uid = this.authService.user()?.uid ?? '';
    const stored = this.cartStorage.load(uid);
    if (!stored) {
      return;
    }
    this.manualDiscounts.set(stored.manualDiscounts);
    this.setCart(stored.lines);
    this.notifications.success(
      `Se recuperó el ticket en curso (${stored.lines.length} ${stored.lines.length === 1 ? 'partida' : 'partidas'}).`,
    );
  }

  private loadHeldSales(): void {
    const uid = this.authService.user()?.uid ?? '';
    this.heldSales.set(this.heldStorage.load(uid));
  }

  private persistHeld(list: HeldSale[]): void {
    const uid = this.authService.user()?.uid ?? '';
    this.heldStorage.save(uid, list);
  }

  private ensureShiftOpen(): boolean {
    // Permiso `sales:write` del backend: un rol de solo lectura (p. ej. doctor)
    // podría entrar al POS, y debe enterarse aquí y no con un 403 al cobrar.
    if (!this.canSell()) {
      this.notifications.error('Tu rol no tiene permiso para registrar ventas.');
      return false;
    }
    if (this.cashSessionOpen()) {
      return true;
    }
    this.notifications.error('Abre un turno de caja antes de vender.');
    this.cashSessionDialogVisible.set(true);
    return false;
  }
}
