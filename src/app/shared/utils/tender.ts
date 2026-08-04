import { PaymentMethod } from '../models';
import { compareMoney, subtractMoney, toCents } from './money';

/**
 * Reparto del cobro entre efectivo y tarjeta — espejo de `resolveTender` en
 * `backend-farma-jyv/functions/src/services/sales.service.ts`.
 *
 *  - `cash`             — el efectivo recibido cubre el total; cambio = recibido − total.
 *  - `card` / `transfer`— sin efectivo; en `card` la tarjeta paga el total.
 *  - `mixed`            — la tarjeta paga `cardAmount` (el monto de la order Point) y el
 *                         efectivo cubre el resto (`total − cardAmount`). El cambio se
 *                         calcula contra **esa parte en efectivo**, nunca contra el total.
 *
 * Se mantiene como función pura para que el checkout, el ticket y la cola offline
 * calculen exactamente lo mismo que persiste el backend.
 */

export interface TenderInput {
  paymentMethod: PaymentMethod;
  total: number;
  /** Efectivo entregado por el cliente; `null` en tarjeta/transferencia. */
  amountReceived: number | null;
  /** Monto cobrado con tarjeta (`order.amount` de Mercado Pago Point). */
  cardAmount: number | null;
}

export interface TenderState {
  /** Parte del total que debe cubrirse en efectivo. */
  cashDue: number;
  /** Efectivo que entra al cajón (no es `amountReceived` cuando hay cambio). */
  cashAmount: number | null;
  cardAmount: number | null;
  change: number;
  shortfall: number;
  /** El efectivo recibido alcanza para `cashDue`. */
  cashSatisfied: boolean;
  /** Motivo por el que el cobro aún no es válido; `null` si se puede confirmar. */
  error: string | null;
}

function cashDueFor(input: TenderInput): number {
  switch (input.paymentMethod) {
    case 'cash':
      return input.total;
    case 'card':
    case 'transfer':
      return 0;
    case 'mixed':
      return subtractMoney(input.total, input.cardAmount ?? 0);
  }
}

function validate(input: TenderInput, cashDue: number): string | null {
  if (input.paymentMethod === 'mixed') {
    if (input.cardAmount === null) {
      return 'El pago mixto requiere el monto cobrado con tarjeta.';
    }
    if (toCents(input.cardAmount) <= 0) {
      return 'El monto cobrado con tarjeta debe ser mayor a cero.';
    }
    if (compareMoney(input.cardAmount, input.total) >= 0) {
      return 'La tarjeta cubre el total: registra la venta como pago con tarjeta.';
    }
  }
  if (cashDue > 0 && input.amountReceived === null) {
    return 'El monto recibido es requerido para este método de pago.';
  }
  return null;
}

export function resolveTender(rawInput: TenderInput): TenderState {
  // Normaliza `undefined` (colas offline guardadas antes del split mixto) a `null`.
  const input: TenderInput = {
    ...rawInput,
    amountReceived: rawInput.amountReceived ?? null,
    cardAmount: rawInput.cardAmount ?? null,
  };
  const cashDue = Math.max(0, cashDueFor(input));
  const received = input.amountReceived ?? 0;
  const cashSatisfied = cashDue === 0 || compareMoney(received, cashDue) >= 0;
  const cardAmount =
    input.paymentMethod === 'card'
      ? input.total
      : input.paymentMethod === 'mixed'
        ? input.cardAmount
        : null;

  return {
    cashDue,
    cashAmount: cashDue > 0 ? cashDue : null,
    cardAmount,
    change: cashSatisfied ? Math.max(0, subtractMoney(received, cashDue)) : 0,
    shortfall: cashSatisfied ? 0 : Math.max(0, subtractMoney(cashDue, received)),
    cashSatisfied,
    error: validate(input, cashDue),
  };
}
