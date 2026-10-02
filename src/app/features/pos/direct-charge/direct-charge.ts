import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { TagModule } from 'primeng/tag';
import { EMPTY, Observable, catchError, finalize, interval, switchMap, takeWhile } from 'rxjs';

import { getApiErrorMessage } from '../../../core/api/api.utils';
import { NotificationService } from '../../../core/notifications/notification.service';
import { DirectCharge, DirectChargeChannel, DirectChargeStatus } from '../../../shared/models';
import { roundMoney } from '../../../shared/utils/money';
import { DirectChargeService } from '../services/direct-charge.service';
import { MercadoPagoService, PointDevice } from '../services/mercado-pago.service';
import { newIdempotencyKey } from '../services/sale.service';

/** Cuántos cobros recientes se listan; la caja consulta el turno, no el mes. */
const RECENT_LIMIT = 25;

/**
 * Cobro directo: dinero que entra por Mercado Pago **sin** venta detrás
 * (servicios, abonos, cobros a terceros), por terminal Point o por link de pago.
 * Se guarda en la colección `directCharges` del backend y por diseño no aparece
 * en ventas, inventario, arqueo de caja ni reportes: es un registro paralelo.
 */
@Component({
  selector: 'app-direct-charge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    NgTemplateOutlet,
    FormsModule,
    TranslatePipe,
    ButtonModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TableModule,
    TabsModule,
    TagModule,
  ],
  templateUrl: './direct-charge.html',
  host: {
    // F9 envía el cobro, igual que en el diálogo de cobro de una venta.
    '(document:keydown.f9)': 'submitFromHotkey($event)',
  },
})
export class DirectChargeScreen {
  private readonly directCharges = inject(DirectChargeService);
  private readonly mercadoPago = inject(MercadoPagoService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  /** Pestaña activa; también decide contra qué endpoint se cobra. */
  readonly channel = signal<DirectChargeChannel>('point');

  readonly amount = signal<number | null>(null);
  readonly concept = signal('');

  readonly devices = signal<PointDevice[]>([]);
  readonly selectedDeviceId = signal<string | null>(null);
  readonly devicesLoading = signal(false);
  readonly devicesError = signal<string | null>(null);
  readonly activatingPdv = signal(false);

  /** Cobro en curso (o el último resuelto), tal como lo devuelve el backend. */
  readonly charge = signal<DirectCharge | null>(null);
  readonly submitting = signal(false);
  readonly polling = signal(false);
  readonly canceling = signal(false);
  readonly linkCopied = signal(false);

  readonly recent = signal<DirectCharge[]>([]);
  readonly recentLoading = signal(false);
  readonly recentError = signal<string | null>(null);

  /**
   * Llave de idempotencia del cobro en curso. Se genera una vez y se reusa en
   * cada reintento del POST: un timeout no debe cobrar dos veces.
   */
  private idempotencyKey = newIdempotencyKey();

  readonly deviceOptions = computed(() =>
    this.devices().map((device) => ({
      ...device,
      label: `${device.id} · ${device.operatingMode || '—'}`,
    })),
  );
  readonly selectedDevice = computed(
    () => this.devices().find((device) => device.id === this.selectedDeviceId()) ?? null,
  );

  readonly amountValue = computed(() => roundMoney(this.amount() ?? 0));
  readonly conceptValue = computed(() => this.concept().trim());

  readonly pending = computed(() => this.charge()?.status === 'pending');
  readonly approved = computed(() => this.charge()?.status === 'approved');
  /** Link de pago del cobro en línea en curso. */
  readonly paymentLink = computed(() => this.charge()?.online?.initPoint ?? null);
  /**
   * QR del link como data URL. El cliente lo escanea con su teléfono en el
   * mostrador: dictar o teclear una URL de Mercado Pago no es opción en caja.
   */
  readonly qrDataUrl = signal<string | null>(null);

  /** Por qué todavía no se puede enviar el cobro, en el orden en que se resuelve. */
  readonly blockers = computed<string[]>(() => {
    const reasons: string[] = [];
    if (this.amountValue() <= 0) {
      reasons.push('Captura el monto a cobrar.');
    }
    if (this.conceptValue().length < 3) {
      reasons.push('Escribe el concepto del cobro (mínimo 3 caracteres).');
    }
    if (this.channel() === 'point' && !this.selectedDeviceId()) {
      reasons.push('Selecciona una terminal Mercado Pago.');
    }
    return reasons;
  });

  readonly canSubmit = computed(
    () => !this.submitting() && !this.pending() && !this.approved() && this.blockers().length === 0,
  );

  constructor() {
    this.loadDevices();
    this.loadRecent();

    // El QR se regenera cuando cambia el link (cobro nuevo) y se borra al
    // cerrarse el cobro: un QR vivo de un cobro muerto se escanea igual.
    effect(() => {
      const link = this.paymentLink();
      if (!link) {
        this.qrDataUrl.set(null);
        return;
      }
      // Carga diferida: `qrcode` es CommonJS y arrastra ~90 kB con bailout de
      // optimización. Importarlo aquí lo saca del arranque de la pantalla —solo
      // pesa cuando de verdad hay un link de pago que dibujar.
      void import('qrcode')
        .then(({ toDataURL }) => toDataURL(link, { width: 220, margin: 1 }))
        .then((dataUrl) => this.qrDataUrl.set(dataUrl))
        .catch(() => this.qrDataUrl.set(null));
    });
  }

  statusSeverity(status: DirectChargeStatus): 'success' | 'warn' | 'danger' | 'secondary' {
    if (status === 'approved') {
      return 'success';
    }
    if (status === 'pending') {
      return 'warn';
    }
    return status === 'failed' ? 'danger' : 'secondary';
  }

  /**
   * Cambiar de pestaña con un cobro vivo dejaría una order o un link cobrando
   * por su cuenta: primero hay que resolverlo (aprobado, cancelado o fallido).
   */
  selectChannel(channel: DirectChargeChannel): void {
    if (channel === this.channel()) {
      return;
    }
    if (this.pending()) {
      this.notifications.error(
        'Hay un cobro en curso. Espera a que se resuelva o cancélalo antes de cambiar de método.',
      );
      return;
    }
    this.channel.set(channel);
    this.newCharge();
  }

  loadDevices(): void {
    this.devicesLoading.set(true);
    this.devicesError.set(null);
    this.mercadoPago
      .listDevices()
      .pipe(finalize(() => this.devicesLoading.set(false)))
      .subscribe({
        next: (devices) => {
          this.devices.set(devices);
          this.selectedDeviceId.set(this.mercadoPago.preferredDevice(devices)?.id ?? null);
          if (devices.length === 0) {
            this.devicesError.set(
              'No hay terminales vinculadas a la cuenta de Mercado Pago. Verifica que la Point esté encendida, asociada a la misma cuenta del Access Token y en modo PDV.',
            );
          }
        },
        error: (error: unknown) => {
          this.devices.set([]);
          this.selectedDeviceId.set(null);
          this.devicesError.set(getApiErrorMessage(error));
        },
      });
  }

  activatePdv(): void {
    const device = this.selectedDevice();
    if (!device) {
      return;
    }
    this.activatingPdv.set(true);
    this.mercadoPago
      .setDeviceOperatingMode(device.id, 'PDV')
      .pipe(finalize(() => this.activatingPdv.set(false)))
      .subscribe({
        next: (updated) => {
          this.devices.update((list) =>
            list.map((item) => (item.id === updated.id ? updated : item)),
          );
          this.notifications.success('Terminal activada en modo PDV.');
        },
        error: (error: unknown) => this.notifications.error(getApiErrorMessage(error)),
      });
  }

  loadRecent(): void {
    this.recentLoading.set(true);
    this.recentError.set(null);
    this.directCharges
      .list({ limit: RECENT_LIMIT })
      .pipe(finalize(() => this.recentLoading.set(false)))
      .subscribe({
        next: (charges) => this.recent.set(charges),
        // Banda persistente y no toast: una lista con datos viejos parece al día.
        error: (error: unknown) => this.recentError.set(getApiErrorMessage(error)),
      });
  }

  submitFromHotkey(event: Event): void {
    event.preventDefault();
    if (this.canSubmit()) {
      this.submit();
      return;
    }
    const [firstBlocker] = this.blockers();
    if (firstBlocker) {
      this.notifications.error(firstBlocker);
    }
  }

  submit(): void {
    if (!this.canSubmit()) {
      return;
    }
    const request: Observable<DirectCharge> =
      this.channel() === 'online'
        ? this.directCharges.createOnline({
            idempotencyKey: this.idempotencyKey,
            amount: this.amountValue(),
            concept: this.conceptValue(),
          })
        : this.directCharges.create({
            idempotencyKey: this.idempotencyKey,
            deviceId: this.selectedDeviceId()!,
            amount: this.amountValue(),
            concept: this.conceptValue(),
          });

    this.submitting.set(true);
    this.linkCopied.set(false);
    request.pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: (charge) => {
        this.charge.set(charge);
        this.mergeRecent(charge);
        if (charge.status === 'pending') {
          this.pollCharge(charge.id);
        }
      },
      error: (error: unknown) => this.notifications.error(getApiErrorMessage(error)),
    });
  }

  /**
   * Mercado Pago no avisa al POS, así que el estado se consulta. El backend es
   * quien pregunta (order Point o pago del link) y persiste el cambio; aquí solo
   * se refresca.
   */
  private pollCharge(id: string): void {
    this.polling.set(true);
    interval(2000)
      .pipe(
        switchMap(() => this.directCharges.get(id).pipe(catchError(() => EMPTY))),
        takeWhile((charge) => charge.status === 'pending', true),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((charge) => {
        this.charge.set(charge);
        this.mergeRecent(charge);
        if (charge.status === 'pending') {
          return;
        }
        this.polling.set(false);
        if (charge.status === 'approved') {
          this.notifications.success(`Cobro ${charge.folio} aprobado.`);
          return;
        }
        if (charge.status === 'failed') {
          this.notifications.error(
            charge.statusDetail
              ? `Mercado Pago rechazó el cobro: ${charge.statusDetail}`
              : 'Mercado Pago reportó un error en el cobro.',
          );
        }
      });
  }

  /** Copia el link de pago para pegarlo en WhatsApp, correo o donde el cliente lo lea. */
  async copyLink(): Promise<void> {
    const link = this.paymentLink();
    if (!link) {
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      this.linkCopied.set(true);
      this.notifications.success('Link de pago copiado.');
    } catch {
      // Sin permiso de portapapeles el link sigue visible y seleccionable.
      this.notifications.error('No se pudo copiar el link. Cópialo manualmente.');
    }
  }

  openLink(): void {
    const link = this.paymentLink();
    if (link) {
      window.open(link, '_blank', 'noopener');
    }
  }

  cancel(): void {
    const charge = this.charge();
    if (!charge || charge.status !== 'pending') {
      return;
    }
    this.canceling.set(true);
    this.directCharges
      .cancel(charge.id)
      .pipe(finalize(() => this.canceling.set(false)))
      .subscribe({
        next: (canceled) => {
          this.charge.set(canceled);
          this.mergeRecent(canceled);
          this.polling.set(false);
          this.notifications.success(
            canceled.channel === 'online' ? 'Link de pago cancelado.' : 'Cobro cancelado en la terminal.',
          );
        },
        error: (error: unknown) => this.notifications.error(getApiErrorMessage(error)),
      });
  }

  /** Deja el formulario listo para el siguiente cobro, con llave nueva. */
  newCharge(): void {
    this.idempotencyKey = newIdempotencyKey();
    this.charge.set(null);
    this.polling.set(false);
    this.linkCopied.set(false);
    this.amount.set(null);
    this.concept.set('');
  }

  private mergeRecent(charge: DirectCharge): void {
    this.recent.update((list) => {
      const index = list.findIndex((item) => item.id === charge.id);
      if (index === -1) {
        return [charge, ...list].slice(0, RECENT_LIMIT);
      }
      const next = [...list];
      next[index] = charge;
      return next;
    });
  }
}
