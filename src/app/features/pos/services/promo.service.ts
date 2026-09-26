import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, signal } from '@angular/core';

import {
  CartLine,
  CartLinePromotion,
  CartProductLine,
  Product,
  PromotionDto,
  PromotionRule,
} from '../../../shared/models';
import { isProductLine, lineKey, lineUnitPrice } from '../../../shared/utils/cart-line';
import {
  isSupportedRule,
  pickBestPromotion,
  promotionCostCents,
} from '../../../shared/utils/promotions';
import { PROMOTIONS_SYNCED_EVENT } from '../../../core/sync/sync-events';
import { getApiErrorMessage } from '../../../core/api/api.utils';

/** Mismo texto que `badRequest(...)` en `backend-farma-jyv` (`sales.service.ts`). */
const CLOSED_PROMOTION_PATTERN = /La promoción "(.+)" no está vigente/;

/**
 * Nombre de la promoción si el error es el rechazo del backend por una promo que
 * ya cerró (400 `La promoción "X" no está vigente`); `null` para cualquier otro.
 * Se reconoce por el texto porque el backend no manda un código para este caso.
 */
export function closedPromotionFromError(error: unknown): string | null {
  if (error instanceof HttpErrorResponse && error.status !== 400) {
    return null;
  }
  return CLOSED_PROMOTION_PATTERN.exec(getApiErrorMessage(error))?.[1] ?? null;
}

/** Sugerencia de venta adicional para una partida (ver `nextStepHint`). */
export interface PromotionStepHint {
  /** Piezas de más que tendría que llevar. */
  extraQty: number;
  /** Lo que pagaría por **todas** las piezas (las que lleva más las extra). */
  totalForAll: number;
  /** Ahorro de esas piezas contra el precio de lista. */
  savings: number;
}

/**
 * Cuántas piezas de más vale la pena revisar para una regla: un "paso" completo.
 * Más allá el patrón se repite (otro paquete del NxM, otro escalón), así que no
 * hay un k mayor que dé una mejora que uno menor no haya dado ya.
 */
function stepHorizon(rule: PromotionRule): number {
  if (rule.type === 'tiered') {
    return Math.max(...rule.tiers.map((tier) => tier.quantity));
  }
  return rule.type === 'nxm' ? rule.buy : rule.minQty;
}

/**
 * Aplica las promociones del admin al carrito. Las reglas vienen del SQLite
 * local (`GET /promotions/sync` → `electron/db/promotions.js`), no de un archivo
 * de configuración: así un cambio de precio del admin llega a la caja en el
 * siguiente sync sin reinstalar.
 *
 * El cálculo lo hace el motor compartido (`shared/utils/promotions.ts`, copia
 * del backend). El backend lo vuelve a calcular al registrar la venta; la caja
 * solo manda `promotionId`.
 */
@Injectable({ providedIn: 'root' })
export class PromoService {
  private readonly promotions = signal<PromotionDto[]>([]);
  /** Cambia cada vez que llegan promociones: el ticket abierto se recalcula con ella. */
  readonly version = computed(() => this.promotions());
  private reloadSequence = 0;

  constructor() {
    void this.reload();
    if (typeof window !== 'undefined') {
      window.addEventListener(PROMOTIONS_SYNCED_EVENT, () => void this.reload());
    }
  }

  /** Relee las promociones vigentes del almacén local. */
  async reload(): Promise<void> {
    const store = window.electronAPI?.promotions;
    if (!store) {
      // Sin almacén (navegador, pruebas) la caja cobra a precio de lista.
      return;
    }
    // Solo cuenta la lectura más reciente: la del arranque puede terminar después
    // que la que dispara el sync y dejar la lista vieja (una baja sin aplicar).
    const request = ++this.reloadSequence;
    try {
      const rows = (await store.listActive()) ?? [];
      if (request === this.reloadSequence) {
        this.promotions.set(rows);
      }
    } catch {
      // Una lectura fallida no borra lo que ya se tenía: mejor la promo de hace
      // un rato que cobrar a precio de lista algo que está en promoción.
    }
  }

  /** Solo para pruebas y para el modo navegador. */
  setPromotions(promotions: PromotionDto[]): void {
    this.promotions.set(promotions);
  }

  /**
   * `manualByKey` se indexa por `lineKey`, no por id de producto: dos líneas de
   * servicio del mismo tipo pueden convivir en el ticket (una por doctor) y
   * necesitan descuentos independientes.
   */
  apply(lines: CartLine[], manualByKey: Record<string, number> = {}): CartLine[] {
    return lines.map((line) => {
      const promotion = this.promotionFor(line);
      // Una línea en promoción no admite descuento manual: el precio lo fijó la
      // gerencia al crear la promo. El manual guardado se conserva y vuelve a
      // contar si la promo deja de aplicar (baja la cantidad, se retira).
      const manual = promotion ? 0 : Math.max(0, manualByKey[lineKey(line)] ?? 0);
      const lineTotal = lineUnitPrice(line) * line.quantity;
      const discountAmount = Math.min(lineTotal, (promotion?.discountAmount ?? 0) + manual);
      if (!isProductLine(line)) {
        return { ...line, discountAmount };
      }
      return { ...line, discountAmount, promotion };
    });
  }

  /**
   * ¿El producto tiene hoy una promo que esta caja sabe calcular? Para marcarlo
   * en los resultados de búsqueda antes de que el cajero lo agregue.
   */
  hasPromotion(product: Product): boolean {
    return this.candidatesFor(product).some((promotion) => isSupportedRule(promotion.rule));
  }

  /**
   * Nombre de la promo que la partida trae aplicada y que **ya cerró** en este
   * momento (venció o se dio de baja y el pull ya lo trajo). Lo usa el cobro para
   * no registrar una venta con una promo cerrada: la partida se armó cuando sí
   * estaba vigente y el diálogo de cobro puede quedarse abierto un rato.
   *
   * Que ahora gane *otra* promo no cuenta: la aplicada sigue vigente y el backend
   * la acepta (solo recalcula el monto).
   */
  findClosedPromotion(lines: CartLine[]): string | null {
    for (const line of lines) {
      if (!isProductLine(line) || !line.promotion) {
        continue;
      }
      const applied = line.promotion.id;
      if (!this.candidates(line).some((promotion) => promotion.id === applied)) {
        return line.promotion.name;
      }
    }
    return null;
  }

  /**
   * Sugerencia de venta adicional: el menor número de piezas de más con el que
   * el cliente paga **menos por pieza de lo que ya paga** en promedio. Con eso
   * también cuestan menos que su precio de lista, que es lo que se pide.
   *
   * No basta con "más barato que la lista": en un 10 % que ya aplica, cada pieza
   * extra cuesta 90 % de lista siempre, y la sugerencia saldría en cada partida
   * sin ofrecer nada nuevo; lo mismo con otro par de un 2x1 ya completo. La
   * sugerencia es para **alcanzar** un precio mejor, no para repetirlo.
   *
   * Pura: no toca el carrito. Devuelve `null` si no hay mejora (o no hay promo).
   */
  nextStepHint(line: CartLine): PromotionStepHint | null {
    if (!isProductLine(line) || !Number.isInteger(line.quantity) || line.quantity < 1) {
      return null;
    }
    const candidates = this.candidates(line).filter((promotion) => isSupportedRule(promotion.rule));
    if (candidates.length === 0) {
      return null;
    }
    const unitCents = Math.round(lineUnitPrice(line) * 100);
    if (unitCents <= 0) {
      return null;
    }
    // Lo mismo que cobra `apply`: la mejor promo para cada cantidad, sin acumular.
    const costCents = (quantity: number): number =>
      Math.min(
        unitCents * quantity,
        ...candidates.map((promotion) => promotionCostCents(promotion.rule, unitCents, quantity)),
      );
    const quantity = line.quantity;
    const currentCents = costCents(quantity);
    const horizon = Math.max(1, ...candidates.map((promotion) => stepHorizon(promotion.rule)));
    for (let extra = 1; extra <= horizon; extra += 1) {
      const totalCents = costCents(quantity + extra);
      // marginal / extra < actual / cantidad, en enteros para no redondear.
      if ((totalCents - currentCents) * quantity < currentCents * extra) {
        return {
          extraQty: extra,
          totalForAll: totalCents / 100,
          savings: (unitCents * (quantity + extra) - totalCents) / 100,
        };
      }
    }
    return null;
  }

  promoOnlyDiscount(line: CartLine): number {
    return this.promotionFor(line)?.discountAmount ?? 0;
  }

  private promotionFor(line: CartLine): CartLinePromotion | null {
    // Las promociones son del catálogo de farmacia: una consulta médica nunca
    // entra a un 2x1.
    if (!isProductLine(line)) {
      return null;
    }
    const best = pickBestPromotion(this.candidates(line), lineUnitPrice(line), line.quantity);
    return best
      ? { id: best.promotion.id, name: best.promotion.name, discountAmount: best.discountAmount }
      : null;
  }

  /**
   * `productIds` de la promoción son ids **remotos**; el carrito trae el producto
   * local. Un producto dado de alta en esta caja y aún sin sincronizar no tiene
   * `remoteId` y no puede estar en ninguna promoción.
   */
  private candidates(line: CartProductLine): PromotionDto[] {
    return this.candidatesFor(line.product);
  }

  private candidatesFor(product: Product): PromotionDto[] {
    const remoteId = product.remoteId ?? product.id;
    const now = Date.now();
    return this.promotions().filter(
      (promotion) =>
        promotion.productIds.includes(remoteId) &&
        Date.parse(promotion.startsAt) <= now &&
        (!promotion.endsAt || Date.parse(promotion.endsAt) >= now),
    );
  }
}
