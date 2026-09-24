import { Injectable, computed, signal } from '@angular/core';

import { CartLine, CartLinePromotion, CartProductLine, PromotionDto } from '../../../shared/models';
import { isProductLine, lineKey, lineUnitPrice } from '../../../shared/utils/cart-line';
import { pickBestPromotion } from '../../../shared/utils/promotions';
import { PROMOTIONS_SYNCED_EVENT } from '../../../core/sync/sync-events';

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
      const manual = Math.max(0, manualByKey[lineKey(line)] ?? 0);
      const lineTotal = lineUnitPrice(line) * line.quantity;
      const discountAmount = Math.min(lineTotal, (promotion?.discountAmount ?? 0) + manual);
      if (!isProductLine(line)) {
        return { ...line, discountAmount };
      }
      return { ...line, discountAmount, promotion };
    });
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
    const remoteId = line.product.remoteId ?? line.product.id;
    const now = Date.now();
    return this.promotions().filter(
      (promotion) =>
        promotion.productIds.includes(remoteId) &&
        Date.parse(promotion.startsAt) <= now &&
        (!promotion.endsAt || Date.parse(promotion.endsAt) >= now),
    );
  }
}
