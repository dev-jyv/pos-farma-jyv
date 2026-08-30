import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { debounceTime, distinctUntilChanged, Subject, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { environment } from '../../../../environments/environment';
import { getApiErrorMessage } from '../../../core/api/api.utils';
import { ScanSoundService } from '../../../core/audio/scan-sound.service';
import { AuthService } from '../../../core/auth/auth.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CartLine, HeldSale, Product, ProductBatch, Sale as SaleModel } from '../../../shared/models';
import { getControlledRule } from '../../../shared/utils/controlled';
import { BatchService } from '../services/batch.service';
import { CartStorageService } from '../services/cart-storage.service';
import { CashSessionService } from '../services/cash-session.service';
import { HeldSaleStorageService } from '../services/held-sale-storage.service';
import { ProductService } from '../services/product.service';
import { PromoService } from '../services/promo.service';
import { SaleService } from '../services/sale.service';
import { Checkout } from '../checkout/checkout';
import { CashSessionDialog } from '../cash-session/cash-session-dialog';
import { CashMovementDialog } from '../cash-session/cash-movement-dialog';
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
    Checkout,
    CashSessionDialog,
    CashMovementDialog,
    SubstitutesDialog,
  ],
  templateUrl: './sale.html',
  host: {
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
  private readonly batchService = inject(BatchService);
  private readonly saleService = inject(SaleService);
  private readonly cashSessionService = inject(CashSessionService);
  private readonly authService = inject(AuthService);
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
  readonly cashMovementDialogVisible = signal(false);
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
    this.cart().reduce((sum, line) => sum + line.product.salePrice * line.quantity, 0),
  );
  readonly discountTotal = computed(() =>
    this.cart().reduce((sum, line) => sum + line.discountAmount, 0),
  );
  readonly total = computed(() => Math.max(0, this.subtotal() - this.discountTotal()));
  readonly itemCount = computed(() => this.cart().reduce((sum, line) => sum + line.quantity, 0));
  readonly lastLineId = computed(() => {
    const lines = this.cart();
    return lines.length ? lines[lines.length - 1].product.id : null;
  });
  /**
   * `queueId` de la última venta si aún no llegó al servidor. `enqueueOffline` embebe
   * la llave de la cola en el id (`offline-<queueId>`), así que un id con ese prefijo
   * significa a la vez "no sincronizada" y "esta es su entrada en la cola".
   */
  readonly lastSaleQueueId = computed(() => {
    const id = this.lastSale()?.id ?? '';
    return id.startsWith('offline-') ? id.slice('offline-'.length) : null;
  });

  constructor() {
    this.search$
      .pipe(
        debounceTime(500),
        distinctUntilChanged(),
        // El término vacío corta la cadena sin salir a la red (`ProductService`
        // lo resuelve con una lista vacía) y sirve para cancelar el pendiente.
        switchMap((term) => this.productService.search(term)),
        takeUntilDestroyed(),
      )
      .subscribe((products) => this.results.set(products));

    this.cashSessionService.fetchCurrent().subscribe(() => {
      if (!this.cashSessionOpen()) {
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
      this.cashMovementDialogVisible() ||
      this.blockedDialogVisible() ||
      this.pendingDialogVisible() ||
      this.substitutesVisible()
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
      const scanned =
        products.find(
          (product) =>
            product.sku?.toLowerCase() === normalized ||
            product.barcode?.toLowerCase() === normalized,
        ) ?? (products.length === 1 ? products[0] : null);

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
    const line = this.cart().find((item) => item.product.id === productId);
    if (!line) {
      return;
    }
    if (quantity > line.product.stock) {
      this.sounds.error();
      this.notifications.error('Cantidad supera el stock disponible.');
      return;
    }
    this.setCart(
      this.cart().map((item) => (item.product.id === productId ? { ...item, quantity } : item)),
    );
  }

  bumpQuantity(productId: string, delta: number): void {
    const line = this.cart().find((item) => item.product.id === productId);
    if (!line) {
      return;
    }
    this.updateQuantity(productId, line.quantity + delta);
  }

  updateLineDiscount(productId: string, rawAmount: number): void {
    const line = this.cart().find((item) => item.product.id === productId);
    if (!line) {
      return;
    }
    const lineTotal = line.product.salePrice * line.quantity;
    const promo = this.promoService.promoOnlyDiscount(line);
    const totalDiscount = Math.min(Math.max(0, rawAmount), lineTotal);
    const manual = Math.max(0, totalDiscount - promo);
    const percentage = lineTotal === 0 ? 0 : (totalDiscount / lineTotal) * 100;
    if (percentage > 20 && !this.isAdmin()) {
      this.notifications.error('Descuento mayor a 20% requiere autorización de un administrador.');
      return;
    }
    this.manualDiscounts.update((map) => ({ ...map, [productId]: manual }));
    this.setCart(this.cart());
  }

  removeFromCart(productId: string): void {
    const line = this.cart().find((item) => item.product.id === productId);
    if (line && line.quantity > 5 && !window.confirm(`Quitar ${line.quantity} × ${line.product.name}?`)) {
      return;
    }
    this.manualDiscounts.update((map) => {
      const next = { ...map };
      delete next[productId];
      return next;
    });
    this.setCart(this.cart().filter((item) => item.product.id !== productId));
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
      manuals[line.product.id] = Math.max(0, line.discountAmount - promo);
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
    // El stock que se acaba de descontar no debe volver a pintarse desde la
    // caché de búsquedas: la siguiente consulta va al servidor.
    this.productService.invalidate();
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
    this.saleService.void(sale.id).subscribe({
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

  /** Ajusta el stock visible en la lista de búsqueda sin esperar otra consulta. */
  private adjustResultsStock(
    items: Array<{ productId: string; quantity: number }> | undefined,
    sign: 1 | -1,
  ): void {
    if (!items?.length) {
      return;
    }
    const deltas = new Map<string, number>();
    for (const item of items) {
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

    const existing = this.cart().find((line) => line.product.id === product.id);
    const nextQty = (existing?.quantity ?? 0) + addQty;
    if (nextQty > sellableQty || nextQty > product.stock) {
      this.sounds.error();
      this.notifications.error('Sin stock suficiente para agregar otra unidad.');
      return;
    }

    const nextLines = existing
      ? this.cart().map((line) =>
          line.product.id === product.id ? { ...line, quantity: nextQty } : line,
        )
      : [...this.cart(), { product, quantity: addQty, discountAmount: 0 }];

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
