import { Injectable } from '@angular/core';

import { CartLine, HeldSale } from '../../../shared/models';
import { normalizeStoredLine } from '../../../shared/utils/cart-line';

interface HeldSaleDto {
  id: string;
  label: string;
  heldAt: string;
  /**
   * Se guardan crudas. Una venta puesta en pausa ANTES de los servicios no trae
   * `kind` en sus líneas; `normalizeStoredLine` lo rellena al retomarla.
   */
  lines: unknown[];
}

@Injectable({ providedIn: 'root' })
export class HeldSaleStorageService {
  private key(uid: string): string {
    return `pos.held-sales.${uid}`;
  }

  load(uid: string): HeldSale[] {
    if (!uid) {
      return [];
    }
    try {
      const raw = localStorage.getItem(this.key(uid));
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as HeldSaleDto[];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((item) => ({
        id: item.id,
        label: item.label,
        heldAt: new Date(item.heldAt),
        lines: item.lines
          .map((line) => normalizeStoredLine(line))
          .filter((line): line is CartLine => line !== null),
      }));
    } catch {
      localStorage.removeItem(this.key(uid));
      return [];
    }
  }

  save(uid: string, held: HeldSale[]): void {
    if (!uid) {
      return;
    }
    const payload: HeldSaleDto[] = held.map((item) => ({
      id: item.id,
      label: item.label,
      heldAt: item.heldAt.toISOString(),
      lines: item.lines,
    }));
    localStorage.setItem(this.key(uid), JSON.stringify(payload));
  }
}
