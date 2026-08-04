import { Injectable } from '@angular/core';

import { CartLine, HeldSale, Product } from '../../../shared/models';

interface HeldSaleDto {
  id: string;
  label: string;
  heldAt: string;
  lines: Array<{
    product: Product;
    quantity: number;
    discountAmount: number;
  }>;
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
        lines: item.lines.map((line) => ({
          product: line.product,
          quantity: line.quantity,
          discountAmount: line.discountAmount,
        })) as CartLine[],
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
      lines: item.lines.map((line) => ({
        product: line.product,
        quantity: line.quantity,
        discountAmount: line.discountAmount,
      })),
    }));
    localStorage.setItem(this.key(uid), JSON.stringify(payload));
  }
}
