import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, map } from 'rxjs';

import { getApiErrorMessage, unwrapEntity } from '../../../../core/api/api.utils';
import { AuthService } from '../../../../core/auth/auth.service';
import {
  InvoiceRagData,
  InvoiceRagDocument,
  InvoiceRagDocumentType,
  InvoiceRagEmbedding,
  InvoiceRagSearchHit,
  InvoiceRagStatus,
} from '../../../../shared/models';
import { environment } from '../../../../../environments/environment';

export const INVOICE_RAG_MAX_EMBED_CHARS = 8000;
export const INVOICE_RAG_MIN_SCORE = 0.2;

const DOCUMENT_TYPE_LABELS: Record<InvoiceRagDocumentType, string> = {
  invoice: 'Factura',
  receipt: 'Recibo',
  other: 'Otro',
};

export interface InvoiceRagListFilters {
  status?: InvoiceRagStatus;
  documentType?: InvoiceRagDocumentType;
  term?: string;
  page?: number;
  limit?: number;
}

export interface InvoiceRagFile {
  url: string;
  mimeType: string;
  fileName: string;
}

function formatParty(label: string, party: { name: string | null; rfc: string | null }): string | null {
  const parts = [party.name, party.rfc && `RFC ${party.rfc}`].filter(Boolean);
  return parts.length ? `${label}: ${parts.join(' ')}` : null;
}

function formatItem(item: InvoiceRagData['items'][number]): string {
  const quantity = item.quantity !== null ? ` x${item.quantity}` : '';
  const amount = item.amount !== null ? ` = ${item.amount}` : '';
  return `${item.description}${quantity}${amount}`;
}

/** Texto que se embebe: los campos que tiene sentido buscar, sin los vacíos. */
export function buildEmbeddingText(data: InvoiceRagData): string {
  const taxes = data.taxes
    .map((tax) => `${tax.type}${tax.rate !== null ? ` ${Math.round(tax.rate * 10000) / 100}%` : ''}: ${tax.amount}`)
    .join(', ');
  const lines = [
    `Tipo: ${DOCUMENT_TYPE_LABELS[data.documentType]}`,
    formatParty('Emisor', data.issuer),
    formatParty('Receptor', data.receiver),
    data.folio && `Folio: ${data.folio}`,
    data.cfdiUuid && `UUID: ${data.cfdiUuid}`,
    data.issueDate && `Fecha: ${data.issueDate}`,
    data.currency && `Moneda: ${data.currency}`,
    data.paymentMethod && `Método de pago: ${data.paymentMethod}`,
    data.subtotal !== null && `Subtotal: ${data.subtotal}`,
    taxes && `Impuestos: ${taxes}`,
    data.total !== null && `Total: ${data.total}`,
    data.items.length > 0 && `Conceptos: ${data.items.map(formatItem).join('; ')}`,
    data.notes && `Notas: ${data.notes}`,
  ];
  return lines.filter(Boolean).join('\n').slice(0, INVOICE_RAG_MAX_EMBED_CHARS);
}

/**
 * Facturas-RAG: el archivo y el JSON confirmado viven en el SQLite local
 * (`electronAPI.invoiceRag`); la extracción y los embeddings pasan por el
 * backend, que es el único que conoce la llave de OpenRouter.
 */
@Injectable({ providedIn: 'root' })
export class InvoiceRagService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly apiUrl = `${environment.apiUrl}/invoice-rag`;

  readonly available = !!window.electronAPI?.invoiceRag;

  private get store() {
    const store = window.electronAPI?.invoiceRag;
    if (!store) {
      throw new Error('Facturas-RAG requiere la app de escritorio.');
    }
    return store;
  }

  async register(file: File): Promise<{ document: InvoiceRagDocument; duplicate: boolean }> {
    return this.store.register({
      fileName: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      createdBy: this.auth.user()?.uid ?? '',
    });
  }

  list(filters: InvoiceRagListFilters = {}): Promise<{ items: InvoiceRagDocument[]; total: number }> {
    return this.store.list(filters);
  }

  getById(id: string): Promise<InvoiceRagDocument | null> {
    return this.store.getById(id);
  }

  remove(id: string): Promise<{ id: string }> {
    return this.store.remove(id);
  }

  /** El llamador debe revocar `url` con `URL.revokeObjectURL` al terminar. */
  async loadFile(id: string): Promise<InvoiceRagFile> {
    const { blob, fileName } = await this.readBlob(id);
    return { url: URL.createObjectURL(blob), mimeType: blob.type, fileName };
  }

  /** Si falla, el documento queda en `failed` con el motivo y el error se relanza. */
  async extract(document: InvoiceRagDocument, file?: Blob): Promise<InvoiceRagDocument> {
    try {
      const blob = file ?? (await this.readBlob(document.id)).blob;
      const formData = new FormData();
      formData.append('file', blob, document.fileName);
      const { data, model } = await firstValueFrom(
        this.http
          .post<unknown>(`${this.apiUrl}/extract`, formData)
          .pipe(map((response) => unwrapEntity<{ data: InvoiceRagData; model: string }>(response))),
      );
      return await this.store.saveExtraction(document.id, { data, model });
    } catch (error) {
      await this.store.markFailed(document.id, getApiErrorMessage(error)).catch(() => undefined);
      throw error;
    }
  }

  async confirm(id: string, data: InvoiceRagData): Promise<InvoiceRagDocument> {
    const contentText = buildEmbeddingText(data);
    const embedding = await this.embed(contentText);
    return this.store.confirm(id, { data, contentText, embedding });
  }

  async search(query: string, limit = 10): Promise<InvoiceRagSearchHit[]> {
    const text = query.trim().slice(0, INVOICE_RAG_MAX_EMBED_CHARS);
    if (!text) {
      return [];
    }
    const { vector, model } = await this.embed(text);
    return this.store.search({ vector, model, limit, minScore: INVOICE_RAG_MIN_SCORE });
  }

  private async readBlob(id: string): Promise<{ blob: Blob; fileName: string }> {
    const { bytes, mimeType, fileName } = await this.store.readFile(id);
    return { blob: new Blob([bytes as BlobPart], { type: mimeType }), fileName };
  }

  private embed(text: string): Promise<InvoiceRagEmbedding> {
    return firstValueFrom(
      this.http
        .post<unknown>(`${this.apiUrl}/embed`, { text })
        .pipe(map((response) => unwrapEntity<InvoiceRagEmbedding>(response))),
    );
  }
}
