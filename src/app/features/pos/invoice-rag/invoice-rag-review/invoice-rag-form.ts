import { NonNullableFormBuilder, Validators } from '@angular/forms';

import {
  InvoiceRagData,
  InvoiceRagDocumentType,
  InvoiceRagItem,
  InvoiceRagTax,
} from '../../../../shared/models';

export const EMPTY_INVOICE_RAG_DATA: InvoiceRagData = {
  documentType: 'other',
  confidence: 0,
  issuer: { name: null, rfc: null },
  receiver: { name: null, rfc: null },
  folio: null,
  cfdiUuid: null,
  issueDate: null,
  currency: 'MXN',
  paymentMethod: null,
  subtotal: null,
  taxes: [],
  total: null,
  items: [],
  notes: null,
};

const RFC_PATTERN = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BARCODE_PATTERN = /^\d{8,14}$/;

const toPercent = (rate: number | null): number | null => (rate === null ? null : Math.round(rate * 1_000_000) / 10_000);
const fromPercent = (percent: number | null): number | null => (percent === null ? null : percent / 100);
const textOrNull = (value: string): string | null => value.trim() || null;

export function buildTaxGroup(fb: NonNullableFormBuilder, tax?: InvoiceRagTax) {
  return fb.group({
    type: [tax?.type ?? 'IVA', [Validators.required, Validators.maxLength(40)]],
    ratePercent: fb.control<number | null>(toPercent(tax?.rate ?? null)),
    amount: [tax?.amount ?? 0, Validators.required],
  });
}

export function buildItemGroup(fb: NonNullableFormBuilder, item?: InvoiceRagItem) {
  return fb.group({
    description: [item?.description ?? '', [Validators.required, Validators.maxLength(500)]],
    barcode: [item?.barcode ?? '', Validators.pattern(BARCODE_PATTERN)],
    lotNumber: [item?.lotNumber ?? '', Validators.maxLength(40)],
    expiryDate: [item?.expiryDate ?? ''],
    quantity: fb.control<number | null>(item?.quantity ?? null),
    unitPrice: fb.control<number | null>(item?.unitPrice ?? null),
    amount: fb.control<number | null>(item?.amount ?? null),
  });
}

function buildPartyGroup(fb: NonNullableFormBuilder, party: InvoiceRagData['issuer']) {
  return fb.group({
    name: [party.name ?? '', Validators.maxLength(300)],
    rfc: [party.rfc ?? '', Validators.pattern(RFC_PATTERN)],
  });
}

export function buildInvoiceRagForm(fb: NonNullableFormBuilder, data: InvoiceRagData = EMPTY_INVOICE_RAG_DATA) {
  return fb.group({
    documentType: fb.control<InvoiceRagDocumentType>(data.documentType),
    issuer: buildPartyGroup(fb, data.issuer),
    receiver: buildPartyGroup(fb, data.receiver),
    folio: [data.folio ?? '', Validators.maxLength(100)],
    cfdiUuid: [data.cfdiUuid ?? '', Validators.pattern(UUID_PATTERN)],
    issueDate: [data.issueDate ?? ''],
    currency: [data.currency ?? '', Validators.pattern(/^[A-Za-z]{3}$/)],
    paymentMethod: [data.paymentMethod ?? '', Validators.maxLength(100)],
    subtotal: fb.control<number | null>(data.subtotal),
    total: fb.control<number | null>(data.total, Validators.required),
    taxes: fb.array(data.taxes.map((tax) => buildTaxGroup(fb, tax))),
    items: fb.array(data.items.map((item) => buildItemGroup(fb, item))),
    notes: [data.notes ?? '', Validators.maxLength(2000)],
  });
}

export type InvoiceRagForm = ReturnType<typeof buildInvoiceRagForm>;

export function readInvoiceRagForm(form: InvoiceRagForm, confidence: number): InvoiceRagData {
  const value = form.getRawValue();
  return {
    documentType: value.documentType,
    confidence,
    issuer: { name: textOrNull(value.issuer.name), rfc: textOrNull(value.issuer.rfc.toUpperCase()) },
    receiver: { name: textOrNull(value.receiver.name), rfc: textOrNull(value.receiver.rfc.toUpperCase()) },
    folio: textOrNull(value.folio),
    cfdiUuid: textOrNull(value.cfdiUuid.toUpperCase()),
    issueDate: textOrNull(value.issueDate),
    currency: textOrNull(value.currency.toUpperCase()),
    paymentMethod: textOrNull(value.paymentMethod),
    subtotal: value.subtotal,
    taxes: value.taxes.map((tax) => ({ type: tax.type.trim(), rate: fromPercent(tax.ratePercent), amount: tax.amount })),
    total: value.total,
    items: value.items.map((item) => ({
      ...item,
      description: item.description.trim(),
      barcode: textOrNull(item.barcode),
      lotNumber: textOrNull(item.lotNumber),
      expiryDate: textOrNull(item.expiryDate),
    })),
    notes: textOrNull(value.notes),
  };
}
