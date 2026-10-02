import { InvoiceRagDocumentType, InvoiceRagStatus } from '../../../shared/models';

export const INVOICE_RAG_TYPE_OPTIONS: { value: InvoiceRagDocumentType; labelKey: string }[] = [
  { value: 'invoice', labelKey: 'invoiceRag.type.invoice' },
  { value: 'receipt', labelKey: 'invoiceRag.type.receipt' },
  { value: 'other', labelKey: 'invoiceRag.type.other' },
];

export const INVOICE_RAG_STATUS_OPTIONS: { value: InvoiceRagStatus; labelKey: string }[] = [
  { value: 'uploaded', labelKey: 'invoiceRag.status.uploaded' },
  { value: 'extracted', labelKey: 'invoiceRag.status.extracted' },
  { value: 'indexed', labelKey: 'invoiceRag.status.indexed' },
  { value: 'failed', labelKey: 'invoiceRag.status.failed' },
];

export const INVOICE_RAG_STATUS_SEVERITY: Record<InvoiceRagStatus, 'secondary' | 'info' | 'success' | 'danger'> = {
  uploaded: 'secondary',
  extracted: 'info',
  indexed: 'success',
  failed: 'danger',
};
