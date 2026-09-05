import { Injectable } from '@angular/core';

import { CartLine } from '../../../shared/models';
import { normalizeStoredLine } from '../../../shared/utils/cart-line';

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
  /**
   * Se guardan crudas. Un ticket guardado ANTES de los servicios no trae
   * `kind`: `normalizeStoredLine` lo rellena al leer, o el cajero que recupera
   * un ticket viejo se encuentra la pantalla rota.
   */
  lines: unknown[];
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
      const lines = parsed.lines
        .map((line) => normalizeStoredLine(line))
        .filter((line): line is CartLine => line !== null);
      if (!lines.length) {
        return null;
      }
      return {
        lines,
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
      lines,
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
