import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { debounceTime, from, Observable, Subject, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { environment } from '../../../../environments/environment';
import { getApiErrorMessage } from '../../../core/api/api.utils';
import { ScanSoundService } from '../../../core/audio/scan-sound.service';
import { AuthService } from '../../../core/auth/auth.service';
import { SyncScheduler } from '../../../core/sync/sync-scheduler.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import {
  CartLine,
  CartLineCoupon,
  CartLinePromotion,
  CartProductLine,
  CartServiceLine,
  CouponDto,
  HeldSale,
  PharmacyService,
  ServiceProvider,
  Product,
  ProductBatch,
  Sale as SaleModel,
  SaleCoupon,
  SaleItem,
  hasBoxSale,
  isSaleProductItem,
} from '../../../shared/models';
import {
  fullBoxes,
  isBoxLine,
  isProductLine,
  lineGross,
  lineKey,
  lineMaxQuantity,
  lineName,
  linePieces,
  linePiecesPerUnit,
  lineUnitPrice,
  stockLabel,
} from '../../../shared/utils/cart-line';
import { getControlledRule } from '../../../shared/utils/controlled';
import { roundMoney } from '../../../shared/utils/money';
import { BatchService } from '../services/batch.service';
import { CartStorageService } from '../services/cart-storage.service';
import { CashSessionService } from '../services/cash-session.service';
import { HeldSaleStorageService } from '../services/held-sale-storage.service';
import { ProductService } from '../services/product.service';
import { ServiceCatalogService } from '../services/service-catalog.service';
import { PromoService, PromotionStepHint } from '../services/promo.service';
import {
  COUPON_MAYBE_EXHAUSTED_MESSAGE,
  COUPON_NOT_FOUND_MESSAGE,
  CouponIssue,
  CouponService,
} from '../services/coupon.service';
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
/**
 * Tope de descuento para quien no es administrador. Espejo de
 * `MAX_NON_ADMIN_DISCOUNT_RATE` en el backend: si el POS deja pasar más, la venta
 * se cobra y el servidor la rechaza con 403 al sincronizar.
 */
const MAX_CASHIER_DISCOUNT_RATE = 0.2;

const MIN_SEARCH_LENGTH = 2;

/**
 * Cuánto espera la caja el pull de promociones tras un cobro con promo cerrada.
 * Hay un cliente enfrente: sin red, se recalcula con lo que ya hay en SQLite.
 */
const PROMOTION_RECOVERY_TIMEOUT_MS = 8_000;

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - startOfToday().getTime()) / 86_400_000);
}

/** Unidad que el cajero elige al agregar o en la línea (SPEC 46). */
export type SaleUnitChoice = 'piece' | 'box';

/**
 * Copia del producto para el carrito, sin `saleUnit`: esa marca solo dice que el
 * código escaneado fue el de la caja, la unidad de la línea vive en la línea.
 */
function cartProduct(product: Product): Product {
  if (product.saleUnit === undefined) {
    return product;
  }
  const { saleUnit: _unidad, ...rest } = product;
  return rest;
}

function money(amount: number): string {
  return amount.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    '(document:keydown.f2)': 'focusSearch($event)',
    '(document:keydown.f4)': 'focusLastQty($event)',
    '(document:keydown.f6)': 'holdSaleFromHotkey($event)',
    '(document:keydown.f9)': 'openCheckout($event)',
    '(document:keydown.escape)': 'onEscape($event)',
    '(document:keydown.delete)': 'onDeleteLine($event)',
    '(document:keydown)': 'onDocumentKeydown($event)',
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
  private readonly couponService = inject(CouponService);
  private readonly search$ = new Subject<string>();

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly lastQtyInput = viewChild<ElementRef<HTMLInputElement>>('lastQtyInput');
  private readonly couponInput = viewChild<ElementRef<HTMLInputElement>>('couponInput');

  readonly searchTerm = signal('');
  readonly results = signal<Product[]>([]);
  readonly cart = signal<CartLine[]>([]);
  readonly heldSales = signal<HeldSale[]>([]);
  readonly manualDiscounts = signal<Record<string, number>>({});

  /* ── Cupón (SPEC 47) ──────────────────────────────────────────────────── */
  /** Cupón aplicado al ticket (copia del SQLite local). */
  readonly appliedCoupon = signal<CouponDto | null>(null);
  /** Descuento de un cupón de venta; va como `saleDiscountAmount`. */
  readonly couponSaleDiscount = signal(0);
  /** Lo que descuenta el cupón en este ticket (producto o venta). */
  readonly couponTotal = signal(0);
  /** Por qué el cupón aplicado no descuenta ahora (se quita al cobrar). */
  readonly couponIssue = signal<CouponIssue | null>(null);
  readonly couponInputVisible = signal(false);
  readonly couponCode = signal('');
  readonly couponBusy = signal(false);
  /** Resumen que viaja a la venta local y al ticket. */
  readonly couponSummary = computed<SaleCoupon | null>(() => {
    const coupon = this.appliedCoupon();
    if (!coupon || this.couponTotal() <= 0) {
      return null;
    }
    return { code: coupon.code, name: coupon.name, scope: coupon.scope, discountAmount: this.couponTotal() };
  });
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

  readonly subtotal = computed(() =>
    roundMoney(this.cart().reduce((sum, line) => sum + lineUnitPrice(line) * line.quantity, 0)),
  );
  /** Descuentos de línea: promoción, manual y cupón de producto. */
  readonly lineDiscountTotal = computed(() =>
    roundMoney(this.cart().reduce((sum, line) => sum + line.discountAmount, 0)),
  );
  /** Todos los descuentos, incluido el cupón de venta (`saleDiscountAmount`). */
  readonly discountTotal = computed(() =>
    roundMoney(this.lineDiscountTotal() + this.couponSaleDiscount()),
  );
  readonly total = computed(() => Math.max(0, roundMoney(this.subtotal() - this.discountTotal())));
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
      this.cartStorage.save(uid, lines, this.manualDiscounts(), this.appliedCoupon()?.code ?? null);
    });

    // Bajó un pull de cupones: se relee el aplicado. Una baja o un cambio de
    // vigencia que llega con el ticket abierto se nota antes de cobrar. Igual
    // que con las promociones, nunca con el cobro abierto.
    effect(() => {
      this.couponService.version();
      if (this.checkoutVisible()) {
        return;
      }
      untracked(() => void this.refreshAppliedCoupon());
    });

    // El ticket solo se recalculaba al tocarlo: una promo que llegaba con el
    // ticket ya armado (arranque, sync) no aplicaba, y una retirada seguía
    // descontando. `untracked`: el efecto depende de las promociones y de si el
    // cobro está abierto, no del carrito que él mismo reescribe.
    //
    // **Nunca con el cobro abierto**: el diálogo muestra `total()` en vivo, y un
    // sync a media venta cambiaba el importe con el cambio ya calculado o la
    // order de la terminal ya creada por el monto anterior. Al cerrarse sin
    // cobrar, el efecto vuelve a correr y aplica lo que llegó mientras tanto.
    effect(() => {
      this.promoService.version();
      if (this.checkoutVisible()) {
        return;
      }
      untracked(() => this.repriceCart());
    });
  }

  /**
   * Vuelve a aplicar las promociones al ticket abierto y recorta el manual al
   * tope: si entra una promo, la base del 20 % baja y el manual pudo quedar
   * arriba.
   */
  private repriceCart(): void {
    if (this.cart().length === 0) {
      return;
    }
    this.setCart(this.cart());
    for (const line of this.cart()) {
      this.recortarDescuentoAlTope(lineKey(line));
    }
  }

  promotionOf(line: CartLine): CartLinePromotion | null {
    return isProductLine(line) ? line.promotion ?? null : null;
  }

  /** Parte del cupón de producto en la línea (SPEC 47). */
  couponOf(line: CartLine): CartLineCoupon | null {
    return isProductLine(line) ? line.coupon ?? null : null;
  }

  /** La línea es de un producto del cupón pero ya trae promoción: no lo recibe. */
  couponSkipped(line: CartLine): boolean {
    return this.couponService.skippedForPromotion(line, this.appliedCoupon());
  }

  /* ── Venta por caja (SPEC 46) ─────────────────────────────────────────── */

  readonly hasBox = hasBoxSale;
  readonly isBox = isBoxLine;
  readonly stockLabelOf = stockLabel;
  readonly piecesPerUnitOf = linePiecesPerUnit;

  /**
   * Piezas del producto que ya apartan **otras** líneas del ticket (la caja si
   * se mira la pieza, y al revés). Las dos comparten las mismas existencias.
   */
  private piecesInOtherLines(productId: string, exceptKey: string | null): number {
    return this.cart()
      .filter((line) => isProductLine(line) && line.product.id === productId && lineKey(line) !== exceptKey)
      .reduce((sum, line) => sum + linePieces(line), 0);
  }

  /**
   * Tope de la línea en su unidad, descontando lo que aparta la otra unidad del
   * mismo producto. `null` en un servicio.
   */
  maxFor(line: CartLine): number | null {
    const max = lineMaxQuantity(line);
    if (max === null || !isProductLine(line)) {
      return max;
    }
    const libres = Math.max(0, line.product.stock - this.piecesInOtherLines(line.product.id, lineKey(line)));
    return Math.floor(libres / linePiecesPerUnit(line));
  }

  /**
   * Cambia la unidad de una línea (pieza ↔ caja). Pasar 25 piezas a caja deja
   * las cajas completas que caben (2 de 10); pasar 2 cajas a pieza deja 20
   * piezas. Si ya había una línea de la otra unidad, se suman. El descuento
   * manual no se traslada: era un importe sobre otro precio.
   */
  switchLineUnit(key: string, unit: SaleUnitChoice): void {
    const line = this.cart().find((item) => lineKey(item) === key);
    if (!line || !isProductLine(line)) {
      return;
    }
    const toBox = unit === 'box';
    if (toBox === isBoxLine(line) || (toBox && !hasBoxSale(line.product))) {
      return;
    }
    const perBox = line.product.boxQuantity ?? 1;
    const quantity = toBox ? Math.max(1, Math.floor(line.quantity / perBox)) : line.quantity * perBox;
    const base: CartProductLine = {
      kind: 'product',
      product: line.product,
      quantity,
      discountAmount: 0,
      ...(toBox ? { saleUnit: 'box' as const } : {}),
    };
    const targetKey = lineKey(base);
    const existing = this.cart().find((item) => lineKey(item) === targetKey);
    const merged = { ...base, quantity: quantity + (existing?.quantity ?? 0) };
    const others = this.cart()
      .filter((item) => isProductLine(item) && item.product.id === line.product.id)
      .filter((item) => lineKey(item) !== key && lineKey(item) !== targetKey)
      .reduce((sum, item) => sum + linePieces(item), 0);
    if (linePieces(merged) + others > line.product.stock) {
      this.sounds.error();
      this.notifications.error(
        toBox
          ? `No hay cajas completas suficientes: hay ${stockLabel(line.product)}.`
          : 'Cantidad supera el stock disponible.',
      );
      return;
    }
    this.manualDiscounts.update((map) => {
      const next = { ...map };
      delete next[key];
      return next;
    });
    this.setCart(
      this.cart()
        .filter((item) => lineKey(item) !== targetKey)
        .map((item) => (lineKey(item) === key ? merged : item)),
    );
    this.recortarDescuentoAlTope(targetKey);
  }

  /* ── Cupón (SPEC 47) ──────────────────────────────────────────────────── */

  openCouponInput(): void {
    if (this.appliedCoupon()) {
      return;
    }
    this.couponInputVisible.set(true);
    queueMicrotask(() => this.couponInput()?.nativeElement.focus());
  }

  closeCouponInput(): void {
    this.couponInputVisible.set(false);
    this.couponCode.set('');
    queueMicrotask(() => this.searchInput()?.nativeElement.focus());
  }

  onCouponCodeInput(value: string): void {
    // Mayúsculas al teclear: el código se guarda normalizado y así lo ve el cajero.
    this.couponCode.set(value.toUpperCase());
  }

  onCouponKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Sin esto el `Esc` sube al documento y `onEscape` ofrece vaciar el ticket.
      event.preventDefault();
      event.stopPropagation();
      this.closeCouponInput();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void this.applyCoupon();
    }
  }

  /**
   * Busca el código en la SQLite, lo valida contra el ticket con el reloj de la
   * caja y, si descuenta algo, lo aplica. Si la foto local dice que ya se
   * usaron todos, avisa y aplica igual: el servidor decide (SPEC 47).
   */
  async applyCoupon(): Promise<void> {
    const raw = this.couponCode().trim();
    if (!raw || this.couponBusy()) {
      return;
    }
    this.couponBusy.set(true);
    try {
      const coupon = await this.couponService.findByCode(raw);
      if (!coupon) {
        this.sounds.error();
        this.notifications.error(COUPON_NOT_FOUND_MESSAGE);
        return;
      }
      const prueba = this.couponService.apply(
        this.promoService.apply(this.cart(), this.manualDiscounts()),
        coupon,
      );
      if (prueba.issue) {
        this.sounds.error();
        this.notifications.error(prueba.issue.message);
        return;
      }
      this.appliedCoupon.set(coupon);
      this.setCart(this.cart());
      this.couponInputVisible.set(false);
      this.couponCode.set('');
      this.sounds.ok();
      if (this.couponService.maybeExhausted(coupon)) {
        this.notifications.warn(COUPON_MAYBE_EXHAUSTED_MESSAGE, `Cupón ${coupon.code}`);
      } else {
        this.notifications.success(`Cupón ${coupon.code} aplicado: −$${money(this.couponTotal())}.`);
      }
      queueMicrotask(() => this.searchInput()?.nativeElement.focus());
    } finally {
      this.couponBusy.set(false);
    }
  }

  removeCoupon(): void {
    if (!this.appliedCoupon()) {
      return;
    }
    this.appliedCoupon.set(null);
    // Las líneas recuperan su descuento manual guardado.
    this.setCart(this.cart());
  }

  /**
   * Quita el cupón porque dejó de valer (venció, se dio de baja o ya no
   * descuenta nada en este ticket), recalcula y avisa el total nuevo.
   */
  private dropCoupon(reason: string): void {
    this.appliedCoupon.set(null);
    this.setCart(this.cart());
    this.notifications.warn(
      `${reason} Se quitó del ticket. Nuevo total $${money(this.total())}.`,
      'Cupón retirado',
    );
  }

  /**
   * Antes de cobrar: un cupón que ya no vale con el reloj de la caja (o que ya
   * no descuenta nada) se quita en vez de mandar una venta que el servidor
   * marcaría para revisión. Devuelve `false` si lo quitó.
   */
  private revalidateCoupon(): boolean {
    if (!this.appliedCoupon()) {
      return true;
    }
    this.setCart(this.cart());
    const issue = this.couponIssue();
    if (issue) {
      this.dropCoupon(issue.message);
      return false;
    }
    return true;
  }

  /** Relee de la SQLite el cupón aplicado tras un pull (puede venir dado de baja). */
  private async refreshAppliedCoupon(): Promise<void> {
    const applied = this.appliedCoupon();
    if (!applied) {
      return;
    }
    const fresh = await this.couponService.findByCode(applied.code);
    if (this.appliedCoupon()?.code !== applied.code) {
      return;
    }
    if (!fresh) {
      this.dropCoupon(`El cupón ${applied.code} ya no está en la caja.`);
      return;
    }
    this.appliedCoupon.set(fresh);
    this.setCart(this.cart());
    const issue = this.couponService.windowIssue(fresh);
    if (issue) {
      this.dropCoupon(issue.message);
    }
  }

  /**
   * Vuelve a poner el cupón de un ticket recuperado o de una venta en espera.
   * Se busca otra vez en la SQLite: entre guardarlo y retomarlo pudo vencer.
   */
  private async restoreCoupon(code: string | null | undefined): Promise<void> {
    if (!code) {
      return;
    }
    const coupon = await this.couponService.findByCode(code);
    if (!coupon) {
      this.notifications.warn(`El cupón ${code} ya no está en la caja; el ticket sigue sin él.`, 'Cupón');
      return;
    }
    const issue = this.couponService.windowIssue(coupon);
    if (issue) {
      this.notifications.warn(`${issue.message} El ticket sigue sin él.`, 'Cupón');
      return;
    }
    this.appliedCoupon.set(coupon);
    this.setCart(this.cart());
  }

  /**
   * Cobro rechazado porque el cupón venció con el diálogo abierto: no se
   * registró nada, así que se quita, se recalcula y se pide volver a cobrar.
   */
  onCouponExpired(message: string): void {
    this.checkoutVisible.set(false);
    this.dropCoupon(message);
  }

  /**
   * "Lleva 1 más" bajo la partida. No se ofrece lo que no hay en existencia: la
   * sugerencia se volvería un error de stock al aceptarla.
   */
  stepHintOf(line: CartLine): PromotionStepHint | null {
    const hint = this.promoService.nextStepHint(line);
    if (!hint) {
      return null;
    }
    const max = this.maxFor(line);
    return max !== null && line.quantity + hint.extraQty > max ? null : hint;
  }

  /** Marca "Promo" en los resultados de búsqueda. */
  hasPromotion(product: Product): boolean {
    return this.promoService.hasPromotion(product);
  }

  /**
   * Producto dado de alta en esta caja que aún no sube: las promociones apuntan a
   * ids remotos, así que no entra a ninguna hasta el próximo sync. Solo en
   * Electron: en el navegador no hay altas locales.
   */
  isUnsynced(line: CartLine): boolean {
    return isProductLine(line) && !line.product.remoteId && Boolean(window.electronAPI);
  }

  /**
   * Refrescando promociones tras un cobro rechazado por promo cerrada. Mientras
   * dura, el cobro no se reabre: se cobraría otra vez con el precio viejo.
   */
  readonly recoveringPromotion = signal(false);

  /**
   * Autorrecuperación cuando una promo del ticket cerró al momento de cobrar
   * (la detecta el cobro, o el backend la rechaza en línea). La venta **no** se
   * registró —ni en SQLite ni en la cola—, así que no hay nada que deshacer:
   *
   * 1. se cierra el cobro;
   * 2. se bajan las promociones (pull liviano) y se espera a que `PromoService`
   *    las relea — con tope de tiempo: sin red, se sigue con lo que ya había;
   * 3. se recalcula el ticket y se avisa el total nuevo para volver a cobrar.
   *
   * El cobro nuevo abre el diálogo otra vez, que genera su propia llave de
   * idempotencia: el intento rechazado nunca existió en el servidor.
   */
  async onPromotionClosed(promotionName: string): Promise<void> {
    this.checkoutVisible.set(false);
    this.recoveringPromotion.set(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.syncScheduler.pullPromotions().catch(() => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), PROMOTION_RECOVERY_TIMEOUT_MS);
        }),
      ]);
      await this.promoService.reload();
      this.repriceCart();
    } finally {
      clearTimeout(timeout);
      this.recoveringPromotion.set(false);
    }
    const total = this.total().toLocaleString('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    this.notifications.warn(
      `La promoción ${promotionName} ya terminó. Nuevo total $${total}. Vuelve a cobrar.`,
      'Promoción terminada',
    );
  }

  clearCart(): void {
    if (this.cart().length === 0) {
      return;
    }
    if (!window.confirm('¿Vaciar el ticket actual?')) {
      return;
    }
    this.resetTicket();
  }

  /** Ticket en blanco: líneas, descuentos manuales y cupón. */
  private resetTicket(): void {
    this.cart.set([]);
    this.manualDiscounts.set({});
    this.appliedCoupon.set(null);
    this.couponSaleDiscount.set(0);
    this.couponTotal.set(0);
    this.couponIssue.set(null);
    this.couponInputVisible.set(false);
    this.couponCode.set('');
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
    // Una tecla sostenida repite el evento: sin esto vaciaba el ticket partida
    // por partida.
    if (this.dialogOpen || (event instanceof KeyboardEvent && event.repeat)) {
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

  /** Un solo `keydown` de documento: Angular no admite dos claves iguales en `host`. */
  onDocumentKeydown(event: KeyboardEvent): void {
    this.onTabHotkeys(event);
    this.onSignedQtyKey(event);
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
      // Código de la caja (SPEC 46): entra como caja. Va después del de la
      // pieza y del SKU, que siempre ganan.
      if (!exacto) {
        const caja = products.find(
          (product) => product.boxBarcode?.toLowerCase() === normalized && hasBoxSale(product),
        );
        if (caja) {
          this.addToCart(caja, qty, true, 'box');
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

  /**
   * Agrega al ticket. `unit: 'box'` agrega cajas completas (SPEC 46): `qty`
   * cuenta cajas y el stock se valida en piezas (`cajas × boxQuantity`).
   */
  addToCart(product: Product, qty = 1, fromScanner = false, unit: SaleUnitChoice = 'piece'): void {
    if (!this.ensureShiftOpen()) {
      return;
    }
    const addQty = Math.max(1, Math.floor(qty));
    if (product.stock < 1) {
      this.sounds.error();
      this.openSubstitutes(product, 'Producto sin stock disponible.');
      return;
    }
    const asBox = unit === 'box' && hasBoxSale(product);
    if (unit === 'box' && !asBox) {
      this.sounds.error();
      this.notifications.error(`${product.name} no se vende por caja.`);
      return;
    }
    if (asBox && fullBoxes(product) < 1) {
      this.sounds.error();
      this.notifications.error(
        `No hay una caja completa de ${product.name}: hay ${stockLabel(product)}.`,
      );
      return;
    }

    this.batchService.listByProduct(product.id).subscribe({
      next: (batches) => this.commitAdd(product, addQty, batches, fromScanner, asBox),
      error: () => this.commitAdd(product, addQty, null, fromScanner, asBox),
    });
  }

  /** Botón "Caja (N)" del resultado de búsqueda. */
  addBoxToCart(product: Product, event?: Event): void {
    event?.stopPropagation();
    this.addToCart(product, 1, false, 'box');
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
    // Un servicio no tiene existencias que agotar: `maxFor` devuelve `null` y
    // la cantidad no se limita. Una caja se limita a las cajas completas que
    // quedan después de lo que aparta la línea por pieza (y al revés).
    const max = this.maxFor(line);
    if (max !== null && quantity > max) {
      this.sounds.error();
      this.notifications.error(
        isBoxLine(line)
          ? `No hay cajas completas suficientes: hay ${stockLabel(line.product)}.`
          : 'Cantidad supera el stock disponible.',
      );
      // El campo dispara el cambio con cada tecla: al teclear «20» con 19 en
      // existencia, el «2» entra y el «0» se rechaza. El modelo sigue valiendo 2,
      // así que Angular no reescribe el campo y la pantalla mostraba 20 mientras
      // se cobraba 2. Se devuelve el campo a la cantidad real.
      const input = this.lastQtyInput()?.nativeElement;
      if (input && lineKey(line) === this.lastLineId()) {
        input.value = String(line.quantity);
      }
      return;
    }
    this.setCart(
      this.cart().map((item) => (lineKey(item) === productId ? { ...item, quantity } : item)),
    );
    // El descuento es absoluto y sobrevive al cambio de cantidad: al bajarla, su
    // peso porcentual sube y puede rebasar lo que el rol autoriza.
    this.recortarDescuentoAlTope(productId);
  }

  /* ── Servicios ────────────────────────────────────────────────────────── */

  /**
   * `Alt+M` / `Alt+S`, por `event.code`: en macOS Option+M y Option+S producen
   * 'µ' y 'ß' en `event.key`, y los atajos nunca disparaban.
   */
  onTabHotkeys(event: KeyboardEvent): void {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (event.code === 'KeyM') {
      this.onProductsTabHotkey(event);
    } else if (event.code === 'KeyS') {
      this.onServicesTabHotkey(event);
    }
  }

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
  /**
   * Recorta el descuento manual de una línea al tope que el rol permite.
   *
   * El descuento se guarda como **importe absoluto** y se reaplica en cada
   * cambio del carrito, así que bajar la cantidad sube el porcentaje sin que
   * nadie lo revise: 5 piezas de $100 con $100 de descuento son el 20% exacto,
   * pero al dejarlo en 3 piezas pasa a ser el 33%. El cobro salía adelante y el
   * backend rechazaba la venta con 403 al sincronizar — dinero cobrado que no
   * quedaba registrado. Se recorta en vez de bloquear: el cajero ya tiene al
   * cliente enfrente, y el importe que se cobra es el que el rol autoriza.
   */
  private recortarDescuentoAlTope(productId: string): void {
    if (this.isAdmin()) {
      return;
    }
    const line = this.cart().find((item) => lineKey(item) === productId);
    // Una línea con cupón de producto no lleva manual (SPEC 47): no hay qué recortar.
    if (!line || this.couponOf(line)) {
      return;
    }
    // El tope es para el descuento **manual** y se mide sobre lo que queda
    // después de la promoción, igual que en el backend: la promo la decidió la
    // gerencia y un 2x1 no debe pedir administrador.
    const promo = this.promoService.promoOnlyDiscount(line);
    const base = lineUnitPrice(line) * line.quantity - promo;
    const tope = roundMoney(base * MAX_CASHIER_DISCOUNT_RATE);
    const manual = roundMoney(line.discountAmount - promo);
    if (base <= 0 || manual <= tope) {
      return;
    }
    this.manualDiscounts.update((map) => ({ ...map, [productId]: tope }));
    this.setCart(this.cart());
    this.notifications.error(
      `El descuento manual se ajustó a $${tope.toFixed(2)} (20% de la línea): más requiere autorización de un administrador.`,
    );
  }

  updateLineDiscount(productId: string, rawAmount: number, inputEl?: HTMLInputElement): void {
    const line = this.cart().find((item) => lineKey(item) === productId);
    if (!line) {
      return;
    }
    // El campo se deshabilita con promo o con cupón de producto; esto cubre
    // atajos o un cambio que llegue por otro camino.
    if (this.promotionOf(line) || this.couponOf(line)) {
      if (inputEl) {
        inputEl.value = String(line.discountAmount);
      }
      return;
    }
    const lineTotal = lineUnitPrice(line) * line.quantity;
    const promo = this.promoService.promoOnlyDiscount(line);
    const totalDiscount = Math.min(Math.max(0, rawAmount), lineTotal);
    const manual = Math.max(0, totalDiscount - promo);
    // Solo la parte manual cuenta para el tope, sobre el precio ya con promo.
    const base = lineTotal - promo;
    const percentage = base <= 0 ? 0 : (manual / base) * 100;
    if (percentage > MAX_CASHIER_DISCOUNT_RATE * 100 + 1e-9 && !this.isAdmin()) {
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
      manualDiscounts: { ...this.manualDiscounts() },
      couponCode: this.appliedCoupon()?.code ?? null,
    };
    this.heldSales.update((list) => {
      const next = [...list, held];
      this.persistHeld(next);
      return next;
    });
    this.resetTicket();
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
    const manuals: Record<string, number> = { ...(held.manualDiscounts ?? {}) };
    if (!held.manualDiscounts) {
      // Venta pausada antes de guardar el manual aparte: se deduce como antes.
      for (const line of held.lines) {
        const promo = this.promoService.promoOnlyDiscount(line);
        manuals[lineKey(line)] = Math.max(0, line.discountAmount - promo);
      }
    }
    this.manualDiscounts.set(manuals);
    this.setCart(held.lines);
    // Aun con el manual guardado, la base del tope pudo cambiar (la promo ya no
    // existe o es otra): se recorta al 20 % para no cobrar algo que el backend
    // rechaza al sincronizar.
    for (const line of held.lines) {
      this.recortarDescuentoAlTope(lineKey(line));
    }
    this.refreshStaleProducts();
    void this.restoreCoupon(held.couponCode);
    this.heldSales.update((list) => {
      const next = list.filter((item) => item.id !== id);
      this.persistHeld(next);
      return next;
    });
  }

  /**
   * Un ticket guardado o en pausa trae el producto tal como estaba al capturarse:
   * precio, existencias y grupo controlado de entonces. Se relee del catálogo
   * local y se corrige lo que cambió, avisando al cajero; cobrar con la copia
   * vieja vendía a precio anterior, de más, o sin receta un producto que ya la pide.
   */
  private refreshStaleProducts(): void {
    const ids = this.cart()
      .filter(isProductLine)
      .map((line) => line.product.id);
    if (!ids.length) {
      return;
    }
    let fresh$: Observable<Product[]>;
    try {
      fresh$ = this.productService.getByIds(ids);
    } catch {
      return;
    }
    fresh$.subscribe({
      next: (fresh) => {
        const byId = new Map(fresh.map((product) => [product.id, product]));
        const cambios: string[] = [];
        const lines: CartLine[] = [];
        for (const line of this.cart()) {
          const current = isProductLine(line) ? byId.get(line.product.id) : undefined;
          if (!isProductLine(line) || !current) {
            lines.push(line);
            continue;
          }
          const name = line.product.name;
          if (current.stock <= 0) {
            cambios.push(`${name}: sin existencias, se quitó del ticket`);
            continue;
          }
          if (isBoxLine(line)) {
            // Caja (SPEC 46): el producto pudo dejar de venderse por caja, o ya
            // no alcanzar para una completa.
            if (!hasBoxSale(current)) {
              cambios.push(`${name}: ya no se vende por caja, se quitó del ticket`);
              continue;
            }
            if (fullBoxes(current) < 1) {
              cambios.push(`${name}: no hay una caja completa, se quitó del ticket`);
              continue;
            }
            let boxes = line.quantity;
            if (boxes > fullBoxes(current)) {
              boxes = fullBoxes(current);
              cambios.push(`${name}: solo hay ${stockLabel(current)}`);
            }
            if (current.boxPrice !== line.product.boxPrice) {
              cambios.push(`${name}: la caja ahora cuesta $${(current.boxPrice ?? 0).toFixed(2)}`);
            }
            if (current.boxQuantity !== line.product.boxQuantity) {
              cambios.push(`${name}: la caja ahora trae ${current.boxQuantity} piezas`);
            }
            lines.push({ ...line, product: current, quantity: boxes });
            continue;
          }
          let quantity = line.quantity;
          if (quantity > current.stock) {
            quantity = current.stock;
            cambios.push(`${name}: solo hay ${current.stock} en existencia`);
          }
          if (current.salePrice !== line.product.salePrice) {
            cambios.push(`${name}: el precio ahora es $${current.salePrice.toFixed(2)}`);
          }
          if (
            current.controlledGroup !== line.product.controlledGroup ||
            current.requiresPrescription !== line.product.requiresPrescription
          ) {
            cambios.push(`${name}: cambió su control de receta`);
          }
          lines.push({ ...line, product: current, quantity });
        }
        if (!cambios.length) {
          return;
        }
        this.setCart(lines);
        this.notifications.error(`El ticket se actualizó con el catálogo: ${cambios.join('; ')}.`);
      },
      // Sin catálogo no hay con qué comparar: se deja el ticket como estaba.
      error: () => undefined,
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
    if (this.cart().length === 0 || this.recoveringPromotion()) {
      return;
    }
    // Una promo pudo vencer (o empezar) con el ticket abierto: se cobra con la
    // vigencia de este momento.
    this.repriceCart();
    // Igual con el cupón: si ya no vale, se quita y el cajero ve el total nuevo
    // antes de cobrar (vuelve a pulsar F9).
    if (!this.revalidateCoupon()) {
      return;
    }
    this.checkoutVisible.set(true);
  }

  onSaleCompleted(sale: SaleModel): void {
    this.lastSale.set(sale);
    this.resetTicket();
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
    asBox = false,
  ): void {
    product = cartProduct(product);
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

    // Pieza y caja del mismo producto son dos líneas (SPEC 46) que comparten
    // existencias: el tope se mide en piezas sobre las dos.
    const nueva: CartProductLine = {
      kind: 'product',
      product,
      quantity: addQty,
      discountAmount: 0,
      ...(asBox ? { saleUnit: 'box' as const } : {}),
    };
    const key = lineKey(nueva);
    const perUnit = linePiecesPerUnit(nueva);
    const existing = this.cart().find((line) => lineKey(line) === key);
    const nextQty = (existing?.quantity ?? 0) + addQty;
    const piezas = nextQty * perUnit + this.piecesInOtherLines(product.id, key);
    if (piezas > sellableQty || piezas > product.stock) {
      this.sounds.error();
      this.notifications.error(
        asBox
          ? `Sin stock suficiente para otra caja completa: hay ${stockLabel(product)}.`
          : 'Sin stock suficiente para agregar otra unidad.',
      );
      return;
    }

    const yaEnTicket = this.cart().some(
      (line) => isProductLine(line) && line.product.id === product.id,
    );
    const nextLines: CartLine[] = existing
      ? this.cart().map((line) => (lineKey(line) === key ? { ...line, quantity: nextQty } : line))
      : [...this.cart(), nueva];

    this.setCart(nextLines);
    // El aviso de receta, una vez por producto: la caja del mismo medicamento
    // no lo repite.
    if (!yaEnTicket) {
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

  /**
   * Recalcula el ticket: primero promociones y descuento manual, después el
   * cupón (que se calcula sobre lo que ya dejaron las promociones y nunca toca
   * una línea en promoción).
   */
  private setCart(lines: CartLine[]): void {
    const coupon = this.appliedCoupon();
    const pricing = this.couponService.apply(
      this.promoService.apply(lines, this.manualDiscounts()),
      coupon,
    );
    this.cart.set(pricing.lines);
    this.couponSaleDiscount.set(pricing.saleDiscount);
    this.couponTotal.set(pricing.total);
    this.couponIssue.set(coupon ? pricing.issue : null);
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
    this.refreshStaleProducts();
    void this.restoreCoupon(stored.couponCode);
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
