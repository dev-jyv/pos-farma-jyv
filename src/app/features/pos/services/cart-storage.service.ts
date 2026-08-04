import { Injectable } from '@angular/core';

import { CartLine, Product } from '../../../shared/models';

/**
 * Autoguardado del ticket en curso.
 *
 * La sesión del backend muere a las 24:00 y el interceptor cierra sesión ante un
 * 401: sin esto, el cajero pierde el ticket a medio armar y tiene que reescanear
 * todo. Se guarda por `uid` para no mezclar tickets entre turnos de distintos
 * cajeros en el mismo equipo.
 */

export interface StoredCart {
  lines: CartLine[];
  /** Descuentos capturados a mano por producto (los de promo se recalculan). */
  manualDiscounts: Record<string, number>;
  savedAt: Date;
}

interface StoredCartDto {
  lines: Array<{ product: Product; quantity: number; discountAmount: number }>;
  manualDiscounts: Record<string, number>;
  savedAt: string;
}

@Injectable({ providedIn: 'root' })
export class CartStorageService {
  private key(uid: string): string {
    return `pos.current-cart.${uid}`;
  }

  load(uid: string): StoredCart | null {
    if (!uid) {
      return null;
    }
    try {
      const raw = localStorage.getItem(this.key(uid));
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as StoredCartDto;
      if (!parsed || !Array.isArray(parsed.lines) || parsed.lines.length === 0) {
        return null;
      }
      return {
        lines: parsed.lines.map((line) => ({
          product: line.product,
          quantity: line.quantity,
          discountAmount: line.discountAmount,
        })),
        manualDiscounts: parsed.manualDiscounts ?? {},
        savedAt: new Date(parsed.savedAt),
      };
    } catch {
      this.clear(uid);
      return null;
    }
  }

  save(uid: string, lines: CartLine[], manualDiscounts: Record<string, number>): void {
    if (!uid) {
      return;
    }
    if (lines.length === 0) {
      this.clear(uid);
      return;
    }
    const payload: StoredCartDto = {
      lines: lines.map((line) => ({
        product: line.product,
        quantity: line.quantity,
        discountAmount: line.discountAmount,
      })),
      manualDiscounts,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(this.key(uid), JSON.stringify(payload));
  }

  clear(uid: string): void {
    if (uid) {
      localStorage.removeItem(this.key(uid));
    }
  }
}
