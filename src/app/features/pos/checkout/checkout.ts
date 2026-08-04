import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { EMPTY, Subject, catchError, debounceTime, distinctUntilChanged, interval, switchMap, takeWhile } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { getApiErrorMessage } from '../../../core/api/api.utils';
import { NotificationService } from '../../../core/notifications/notification.service';
import { CartLine, Customer, PaymentMethod, Sale } from '../../../shared/models';
import {
  CONTROLLED_GROUP_RULES,
  ControlledGroupRule,
  getControlledRule,
  resolveControlledRequirements,
  validatePrescription,
} from '../../../shared/utils/controlled';
import { previewTaxSummary } from '../../../shared/utils/taxes';
import { CashDrawerService } from '../services/cash-drawer.service';
import { CustomerService } from '../services/customer.service';
import {
  MercadoPagoService,
  POINT_ORDER_PENDING_STATUSES,
  PointDevice,
  PointOrder,
} from '../services/mercado-pago.service';
import { SaleService, newIdempotencyKey } from '../services/sale.service';
import { roundMoney } from '../../../shared/utils/money';
import { resolveTender } from '../../../shared/utils/tender';

const CASH_QUICK_AMOUNTS = [0, 10, 20, 50, 100, 200];

/**
 * Enfoca y selecciona el `input` real: `pInputText` es el input mismo, mientras que
 * `p-inputnumber` monta un wrapper con el input dentro.
 */
function focusInput(host: HTMLElement | undefined): void {
  const input =
    host instanceof HTMLInputElement ? host : (host?.querySelector('input') ?? null);
  input?.focus();
  input?.select();
}

@Component({
  selector: 'app-checkout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    FormsModule,
    TranslatePipe,
    ButtonModule,
    CheckboxModule,
    DialogModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
  ],
  templateUrl: './checkout.html',
  host: {
    // Teclado primero: F9 cobra, Alt+1/2/3 cambia método. Se escucha en documento
    // porque el diálogo de PrimeNG monta su propio contenedor fuera del componente.
    '(document:keydown.f9)': 'confirmFromHotkey($event)',
    '(document:keydown)': 'onMethodHotkey($event)',
  },
})
export class Checkout {
  private readonly saleService = inject(SaleService);
  private readonly customerService = inject(CustomerService);
  private readonly mercadoPago = inject(MercadoPagoService);
  private readonly notifications = inject(NotificationService);
  private readonly cashDrawer = inject(CashDrawerService);
  private readonly customerSearch$ = new Subject<string>();

  // `read: ElementRef` para tomar el host y buscar el `input` real de PrimeNG.
  private readonly amountInput = viewChild('amountInput', { read: ElementRef<HTMLElement> });
  private readonly prescriptionInput = viewChild('prescriptionInput', {
    read: ElementRef<HTMLElement>,
  });

  readonly visible = input(false);
  readonly cart = input<CartLine[]>([]);
  readonly subtotal = input(0);
  readonly discountTotal = input(0);
  readonly total = input(0);
  readonly cashSessionId = input('');

  readonly closed = output<void>();
  readonly completed = output<Sale>();

  readonly paymentMethods: { labelKey: string; value: PaymentMethod; icon: string }[] = [
    { labelKey: 'payment.cash', value: 'cash', icon: 'pi pi-wallet' },
    { labelKey: 'payment.card', value: 'card', icon: 'pi pi-credit-card' },
    { labelKey: 'payment.mixed', value: 'mixed', icon: 'pi pi-arrows-h' },
  ];

  readonly paymentMethod = signal<PaymentMethod>('cash');
  readonly amountReceived = signal<number>(0);
  /** Monto que se cobra con tarjeta en pago mixto; el resto va en efectivo. */
  readonly cardAmountInput = signal<number>(0);
  readonly submitting = signal(false);
  /**
   * Llave de idempotencia del cobro en curso: se genera al abrir el diálogo y se
   * reusa en cada reintento de "Confirmar venta", así un timeout no duplica la venta.
   */
  private idempotencyKey = newIdempotencyKey();
  /** Intentos de cobro enviados a la terminal para este mismo cobro. */
  private cardAttempt = 0;

  readonly devices = signal<PointDevice[]>([]);
  readonly selectedDeviceId = signal<string | null>(null);
  readonly cardOrder = signal<PointOrder | null>(null);
  readonly cardPolling = signal(false);
  readonly devicesLoading = signal(false);
  readonly devicesError = signal<string | null>(null);
  readonly activatingPdv = signal(false);

  readonly doctorName = signal('');
  readonly doctorLicense = signal('');
  readonly prescriptionFolio = signal('');
  /** Confirmación física: la receta se quedó en la farmacia (grupos I a III). */
  readonly prescriptionRetained = signal(false);

  readonly customerQuery = signal('');
  readonly customerResults = signal<Customer[]>([]);
  readonly selectedCustomer = signal<Customer | null>(null);
  readonly showNewCustomer = signal(false);
  readonly newCustomerName = signal('');
  readonly newCustomerRfc = signal('');

  /**
   * Cliente y facturación arrancan plegados: la venta de mostrador típica es a
   * público general, y cada campo visible es un campo que el cajero recorre con Tab.
   */
  readonly customerPanelOpen = signal(false);

  readonly requiresInvoice = signal(false);
  readonly billingRfc = signal('');
  readonly billingName = signal('');
  readonly billingUsoCfdi = signal('G03');
  readonly billingEmail = signal('');

  readonly quickAmounts = CASH_QUICK_AMOUNTS;
  readonly usoCfdiOptions = [
    { label: 'G03 — Gastos en general', value: 'G03' },
    { label: 'D01 — Honorarios médicos', value: 'D01' },
    { label: 'S01 — Sin efectos fiscales', value: 'S01' },
  ];

  /**
   * Requisitos COFEPRIS del ticket (receta, folio, retención, libro de control),
   * resueltos con las mismas reglas que aplica el backend antes de registrar la venta.
   */
  readonly controlled = computed(() =>
    resolveControlledRequirements(this.cart().map((line) => line.product)),
  );
  readonly needsPrescription = computed(() => this.controlled().requiresPrescription);
  readonly needsFolio = computed(() => this.controlled().requiresFolio);
  readonly needsRetention = computed(() => this.controlled().requiresRetention);
  readonly controlledGroupLabels = computed(() =>
    this.controlled().groups.map((group) => CONTROLLED_GROUP_RULES[group].label),
  );
  /** Partidas controladas, para que el cajero sepa cuál medicamento exige la receta. */
  readonly controlledLines = computed(() =>
    this.cart()
      .map((line) => ({
        name: line.product.name,
        rule: getControlledRule(line.product.controlledGroup),
      }))
      .filter((line): line is { name: string; rule: ControlledGroupRule } => line.rule !== null),
  );
  readonly prescriptionError = computed(() =>
    validatePrescription(this.controlled(), {
      doctorName: this.doctorName(),
      doctorLicense: this.doctorLicense(),
      folio: this.prescriptionFolio(),
      retained: this.prescriptionRetained(),
    }),
  );

  /**
   * Desglose fiscal del ticket antes de cobrar (base, IVA 16%/0%, IEPS). El precio de
   * catálogo trae impuestos incluidos, así que se calcula hacia atrás igual que el
   * backend; la venta guardada llevará el desglose que él calcule.
   */
  readonly taxSummary = computed(() =>
    previewTaxSummary(
      this.cart().map((line) => ({
        product: line.product,
        grossAmount: line.product.salePrice * line.quantity - line.discountAmount,
      })),
    ),
  );
  readonly deviceOptions = computed(() =>
    this.devices().map((device) => ({
      ...device,
      label: `${device.id} · ${device.operatingMode || '—'}`,
    })),
  );
  readonly selectedDevice = computed(
    () => this.devices().find((device) => device.id === this.selectedDeviceId()) ?? null,
  );
  /**
   * Monto que la tarjeta cubre. En `mixed` manda el monto de la order Point ya
   * creada (es lo que el backend usa para calcular la parte en efectivo); mientras
   * no exista la order se usa lo capturado por el cajero.
   */
  readonly cardAmount = computed<number | null>(() => {
    const method = this.paymentMethod();
    if (method === 'card') {
      return this.total();
    }
    if (method !== 'mixed') {
      return null;
    }
    const order = this.cardOrder();
    return order && this.cardAmountLocked()
      ? roundMoney(Number(order.amount))
      : roundMoney(this.cardAmountInput());
  });

  /** Reparto efectivo/tarjeta con la misma regla que aplica el backend. */
  readonly tender = computed(() =>
    resolveTender({
      paymentMethod: this.paymentMethod(),
      total: this.total(),
      amountReceived: this.paymentMethod() === 'card' ? null : this.amountReceived(),
      cardAmount: this.cardAmount(),
    }),
  );

  readonly cashDue = computed(() => this.tender().cashDue);
  readonly change = computed(() => this.tender().change);
  readonly shortfall = computed(() => this.tender().shortfall);
  readonly cashSatisfied = computed(() => this.tender().cashSatisfied);
  readonly tenderError = computed(() => this.tender().error);
  /** Lo que se manda a la terminal: el total, o solo la parte con tarjeta en mixto. */
  readonly cardChargeAmount = computed(() =>
    this.paymentMethod() === 'mixed' ? roundMoney(this.cardAmountInput()) : this.total(),
  );
  readonly cardOrderApproved = computed(() => this.cardOrder()?.status === 'processed');
  /**
   * El monto con tarjeta queda fijo mientras la order está viva (en curso o
   * aprobada). Si la terminal falló o expiró se libera para reintentar con otro
   * reparto sin tener que cerrar el diálogo.
   */
  readonly cardAmountLocked = computed(() => {
    const order = this.cardOrder();
    if (!order) {
      return false;
    }
    return order.status === 'processed' || POINT_ORDER_PENDING_STATUSES.includes(order.status);
  });
  readonly prescriptionOk = computed(() => this.prescriptionError() === null);
  /**
   * Hay datos de receta que guardar. Se manda también cuando el grupo no la exige
   * (grupos V/VI) si el cajero la capturó: es trazabilidad que ya escribió a mano.
   */
  readonly hasPrescriptionData = computed(
    () => this.doctorName().trim().length > 0 && this.doctorLicense().trim().length > 0,
  );
  readonly billingOk = computed(() => {
    if (!this.requiresInvoice()) {
      return true;
    }
    return this.billingRfc().trim().length >= 12 && this.billingName().trim().length > 0;
  });
  readonly itemCount = computed(() =>
    this.cart().reduce((sum, line) => sum + line.quantity, 0),
  );

  /**
   * Por qué no se puede cobrar todavía, en el orden en que el cajero lo resuelve.
   * Un botón deshabilitado sin motivo visible es la queja número uno en caja.
   */
  readonly blockers = computed<string[]>(() => {
    const reasons: string[] = [];
    const prescription = this.prescriptionError();
    if (prescription) {
      reasons.push(prescription);
    }
    const tender = this.tenderError();
    if (tender) {
      reasons.push(tender);
    }
    if (
      (this.paymentMethod() === 'card' || this.paymentMethod() === 'mixed') &&
      !this.cardOrderApproved()
    ) {
      reasons.push('Falta que la terminal apruebe el cobro con tarjeta.');
    }
    if (this.cashDue() > 0 && !this.cashSatisfied()) {
      reasons.push(`Falta efectivo: $${this.shortfall().toFixed(2)}.`);
    }
    if (this.requiresInvoice() && !this.billingOk()) {
      reasons.push('Para facturar se requiere RFC (12–13 caracteres) y razón social.');
    }
    return reasons;
  });

  readonly canConfirm = computed(() => {
    if (this.submitting() || !this.prescriptionOk() || !this.billingOk() || this.tenderError()) {
      return false;
    }
    if (this.paymentMethod() === 'cash') {
      return this.cashSatisfied();
    }
    if (this.paymentMethod() === 'card') {
      return this.cardOrderApproved();
    }
    // Mixto: la tarjeta debe estar aprobada **y** el efectivo cubrir el resto. Con
    // uno solo de los dos la venta quedaría cobrada a medias.
    return this.cardOrderApproved() && this.cashSatisfied();
  });

  constructor() {
    this.customerSearch$
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((term) => this.customerService.search(term)),
        takeUntilDestroyed(),
      )
      .subscribe((customers) => this.customerResults.set(customers));

    effect(() => {
      if (!this.visible()) {
        return;
      }
      this.reset();
      this.loadDevices();
    });
  }

  /**
   * Al abrir, el foco va al campo que bloquea: la receta cuando el grupo la exige,
   * el efectivo en cualquier otro caso. Así el cobro típico es abrir → teclear → F9.
   */
  onDialogShow(): void {
    if (this.needsPrescription()) {
      focusInput(this.prescriptionInput()?.nativeElement);
      return;
    }
    this.focusAmount();
  }

  /** F9 cobra desde cualquier campo del diálogo, como el F9 que lo abrió. */
  confirmFromHotkey(event: Event): void {
    if (!this.visible()) {
      return;
    }
    event.preventDefault();
    if (this.canConfirm()) {
      this.confirm();
      return;
    }
    const [firstBlocker] = this.blockers();
    if (firstBlocker) {
      this.notifications.error(firstBlocker);
    }
  }

  /**
   * Alt+1/2/3 selecciona método. Con Alt para no comerse los dígitos: el cajero
   * teclea montos y códigos todo el tiempo.
   */
  onMethodHotkey(event: KeyboardEvent): void {
    if (!this.visible() || !event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const index = Number(event.key) - 1;
    const method = this.paymentMethods[index];
    if (!method) {
      return;
    }
    event.preventDefault();
    this.selectPaymentMethod(method.value);
  }

  selectPaymentMethod(method: PaymentMethod): void {
    if (method === this.paymentMethod()) {
      return;
    }
    if (this.cardOrderApproved()) {
      // Cambiar de método con un cobro ya aprobado dejaría dinero cobrado fuera de
      // la venta: el reembolso es una decisión explícita, no un efecto secundario.
      this.notifications.error(
        'La terminal ya aprobó el cobro. Termina la venta o cancela el cobro antes de cambiar el método.',
      );
      return;
    }
    if (this.cardOrder()) {
      // Order viva sin aprobar: se cancela para no dejar un cobro huérfano.
      this.cancelCardPayment();
    }
    this.paymentMethod.set(method);
    if (method === 'cash') {
      this.amountReceived.set(this.total());
    }
    if (method === 'mixed') {
      // Arranca a mitades: el cajero ajusta el monto con tarjeta y el efectivo se recalcula.
      this.cardAmountInput.set(roundMoney(this.total() / 2));
      this.amountReceived.set(this.cashDue());
    }
    if ((method === 'card' || method === 'mixed') && this.devices().length === 0 && !this.devicesLoading()) {
      this.loadDevices();
    }
    // El campo que toca teclear cambia con el método; el foco lo sigue.
    if (method === 'cash' || method === 'mixed') {
      queueMicrotask(() => this.focusAmount());
    }
  }

  private focusAmount(): void {
    focusInput(this.amountInput()?.nativeElement);
  }

  setCardAmount(amount: number): void {
    if (this.cardAmountLocked()) {
      // Mientras la order vive, el monto con tarjeta lo fija la terminal.
      return;
    }
    this.cardAmountInput.set(Math.max(0, roundMoney(amount)));
    this.amountReceived.set(this.cashDue());
  }

  setQuickAmount(amount: number): void {
    if (amount === 0) {
      this.amountReceived.set(this.cashDue());
      return;
    }
    this.amountReceived.update((current) => roundMoney(current + amount));
  }

  onCustomerQuery(term: string): void {
    this.customerQuery.set(term);
    this.customerSearch$.next(term);
  }

  pickCustomer(customer: Customer): void {
    this.selectedCustomer.set(customer);
    this.customerQuery.set(customer.name);
    this.customerResults.set([]);
    if (this.requiresInvoice()) {
      this.billingName.set(customer.name);
      this.billingRfc.set(customer.rfc ?? '');
      this.billingEmail.set(customer.email ?? '');
    }
  }

  clearCustomer(): void {
    this.selectedCustomer.set(null);
    this.customerQuery.set('');
  }

  createCustomer(): void {
    const name = this.newCustomerName().trim();
    if (!name) {
      this.notifications.error('El nombre del cliente es requerido.');
      return;
    }
    this.customerService
      .create({
        name,
        rfc: this.newCustomerRfc().trim() || undefined,
      })
      .subscribe({
        next: (customer) => {
          this.showNewCustomer.set(false);
          this.newCustomerName.set('');
          this.newCustomerRfc.set('');
          this.pickCustomer(customer);
          this.notifications.success('Cliente creado.');
        },
        error: (error) => this.notifications.error(getApiErrorMessage(error)),
      });
  }

  toggleInvoice(checked: boolean): void {
    this.requiresInvoice.set(checked);
    if (checked) {
      const customer = this.selectedCustomer();
      if (customer) {
        this.billingName.set(customer.name);
        this.billingRfc.set(customer.rfc ?? '');
        this.billingEmail.set(customer.email ?? '');
      }
    }
  }

  loadDevices(): void {
    this.devicesLoading.set(true);
    this.devicesError.set(null);
    this.mercadoPago.listDevices().subscribe({
      next: (devices) => {
        this.devices.set(devices);
        this.selectedDeviceId.set(devices[0]?.id ?? null);
        this.devicesLoading.set(false);
        if (devices.length === 0) {
          this.devicesError.set(
            'No hay terminales vinculadas a la cuenta de Mercado Pago. Verifica que la Point esté encendida, asociada a la misma cuenta del Access Token y en modo PDV.',
          );
        }
      },
      error: (error) => {
        this.devices.set([]);
        this.selectedDeviceId.set(null);
        this.devicesLoading.set(false);
        this.devicesError.set(getApiErrorMessage(error));
        this.notifications.error(getApiErrorMessage(error));
      },
    });
  }

  activatePdv(): void {
    const device = this.selectedDevice();
    if (!device) {
      return;
    }
    this.activatingPdv.set(true);
    this.mercadoPago.setDeviceOperatingMode(device.id, 'PDV').subscribe({
      next: (updated) => {
        this.devices.update((list) =>
          list.map((item) => (item.id === updated.id ? updated : item)),
        );
        this.activatingPdv.set(false);
        this.notifications.success('Terminal activada en modo PDV.');
      },
      error: (error) => {
        this.activatingPdv.set(false);
        this.notifications.error(getApiErrorMessage(error));
      },
    });
  }

  startCardPayment(): void {
    const deviceId = this.selectedDeviceId();
    if (!deviceId) {
      this.notifications.error('Selecciona una terminal Mercado Pago.');
      return;
    }
    const amount = this.cardChargeAmount();
    if (this.paymentMethod() === 'mixed' && this.tenderError()) {
      this.notifications.error(this.tenderError()!);
      return;
    }
    // La referencia se ata al cobro (idempotencyKey), no al reloj: la order queda
    // trazable a la venta. El sufijo distingue reintentos, porque una order muerta
    // sigue ocupando su referencia en Mercado Pago.
    this.cardAttempt += 1;
    const reference = `sale-${this.idempotencyKey}-${this.cardAttempt}`;
    this.mercadoPago.createOrder(deviceId, amount, reference).subscribe({
      next: (order) => {
        this.cardOrder.set(order);
        this.pollOrder(order.id);
      },
      error: () => this.notifications.error('No se pudo enviar el cobro a la terminal.'),
    });
  }

  /** Reintenta tras un rechazo de la terminal sin cancelar (la order ya está muerta). */
  retryCardPayment(): void {
    this.cardOrder.set(null);
    this.cardPolling.set(false);
    this.startCardPayment();
  }

  cancelCardPayment(): void {
    const order = this.cardOrder();
    if (!order) {
      return;
    }
    this.mercadoPago.cancelOrder(order.id).subscribe();
    this.cardOrder.set(null);
    this.cardPolling.set(false);
  }

  private pollOrder(orderId: string): void {
    this.cardPolling.set(true);
    interval(2000)
      .pipe(
        switchMap(() => this.mercadoPago.getOrder(orderId).pipe(catchError(() => EMPTY))),
        takeWhile((order) => POINT_ORDER_PENDING_STATUSES.includes(order.status), true),
        takeUntilDestroyed(),
      )
      .subscribe((order) => {
        this.cardOrder.set(order);
        if (!POINT_ORDER_PENDING_STATUSES.includes(order.status)) {
          this.cardPolling.set(false);
        }
        if (order.status === 'processed' && this.paymentMethod() === 'mixed') {
          // El monto real de la order es el que define la parte en efectivo.
          this.amountReceived.set(this.cashDue());
        }
        if (order.status === 'failed' || order.status === 'expired') {
          this.notifications.error('La terminal reportó un error en el cobro.');
        }
      });
  }

  confirm(): void {
    if (!this.canConfirm()) {
      return;
    }
    this.submitting.set(true);
    const customer = this.selectedCustomer();
    const payload = this.saleService.buildPayload(
      this.cart(),
      0,
      this.paymentMethod(),
      this.paymentMethod() === 'card' ? null : this.amountReceived(),
      this.cardOrder()?.id ?? null,
      this.cashSessionId(),
      {
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        prescription: this.hasPrescriptionData()
          ? {
              doctorName: this.doctorName().trim(),
              doctorLicense: this.doctorLicense().trim(),
              folio: this.prescriptionFolio().trim() || undefined,
            }
          : null,
        // Solo se manda cuando el grupo lo exige: es la constancia de que la receta
        // se quedó físicamente en la farmacia.
        prescriptionRetained: this.needsRetention() ? this.prescriptionRetained() : undefined,
        billing: this.requiresInvoice()
          ? {
              rfc: this.billingRfc().trim().toUpperCase(),
              name: this.billingName().trim(),
              usoCfdi: this.billingUsoCfdi(),
              email: this.billingEmail().trim() || undefined,
            }
          : null,
        idempotencyKey: this.idempotencyKey,
      },
    );
    this.saleService
      .create(payload, this.cart(), {
        subtotal: this.subtotal(),
        discountTotal: this.discountTotal(),
        total: this.total(),
        cashDue: this.cashDue(),
        cardAmount: this.cardAmount(),
      })
      .subscribe({
        next: (sale) => {
          this.submitting.set(false);
          if (this.paymentMethod() === 'cash' || this.paymentMethod() === 'mixed') {
            this.cashDrawer.open();
          }
          this.completed.emit(sale);
        },
        error: (error: unknown) => {
          this.submitting.set(false);
          this.notifications.error(getApiErrorMessage(error));
        },
      });
  }

  cancel(): void {
    this.closed.emit();
  }

  private reset(): void {
    // Diálogo abierto = cobro nuevo: llave de idempotencia nueva.
    this.idempotencyKey = newIdempotencyKey();
    this.cardAttempt = 0;
    this.paymentMethod.set('cash');
    this.amountReceived.set(this.total());
    this.cardAmountInput.set(0);
    this.submitting.set(false);
    this.cardOrder.set(null);
    this.cardPolling.set(false);
    this.devicesError.set(null);
    this.doctorName.set('');
    this.doctorLicense.set('');
    this.prescriptionFolio.set('');
    this.prescriptionRetained.set(false);
    this.customerQuery.set('');
    this.customerResults.set([]);
    this.selectedCustomer.set(null);
    this.showNewCustomer.set(false);
    this.requiresInvoice.set(false);
    this.billingRfc.set('');
    this.billingName.set('');
    this.billingUsoCfdi.set('G03');
    this.billingEmail.set('');
  }
}
