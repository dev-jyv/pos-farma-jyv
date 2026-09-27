import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../../core/auth/auth.service';
import { InvoiceRagData, InvoiceRagDocument } from '../../../../shared/models';
import { environment } from '../../../../../environments/environment';
import { EMPTY_INVOICE_RAG_DATA } from '../invoice-rag-review/invoice-rag-form';
import { INVOICE_RAG_MIN_SCORE, InvoiceRagService, buildEmbeddingText } from './invoice-rag.service';

const BASE = `${environment.apiUrl}/invoice-rag`;

const DATA: InvoiceRagData = {
  ...EMPTY_INVOICE_RAG_DATA,
  documentType: 'invoice',
  confidence: 0.9,
  issuer: { name: 'CFE Suministrador', rfc: 'CSS160330CP7' },
  folio: 'A-1',
  issueDate: '2026-09-01',
  subtotal: 413.79,
  taxes: [{ type: 'IVA', rate: 0.16, amount: 66.21 }],
  total: 480,
  items: [{ description: 'Suministro', quantity: 1, unitPrice: 413.79, amount: 413.79 }],
};

function doc(overrides: Partial<InvoiceRagDocument> = {}): InvoiceRagDocument {
  return {
    id: 'd1',
    fileName: 'cfe.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    status: 'uploaded',
    documentType: null,
    confidence: null,
    extracted: null,
    confirmed: null,
    extractError: null,
    model: null,
    createdBy: 'u1',
    createdAt: '2026-09-26T15:00:00.000Z',
    updatedAt: '2026-09-26T15:00:00.000Z',
    ...overrides,
  };
}

describe('buildEmbeddingText', () => {
  it('arma líneas legibles con los campos presentes y omite los vacíos', () => {
    expect(buildEmbeddingText(DATA)).toBe(
      [
        'Tipo: Factura',
        'Emisor: CFE Suministrador RFC CSS160330CP7',
        'Folio: A-1',
        'Fecha: 2026-09-01',
        'Moneda: MXN',
        'Subtotal: 413.79',
        'Impuestos: IVA 16%: 66.21',
        'Total: 480',
        'Conceptos: Suministro x1 = 413.79',
      ].join('\n'),
    );
  });

  it('conserva un total en cero y recorta textos enormes', () => {
    const text = buildEmbeddingText({ ...DATA, total: 0, notes: 'x'.repeat(10_000) });
    expect(text).toContain('Total: 0');
    expect(text.length).toBe(8000);
  });
});

describe('InvoiceRagService', () => {
  let service: InvoiceRagService;
  let http: HttpTestingController;
  let store: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    store = {
      register: vi.fn(async () => ({ document: doc(), duplicate: false })),
      readFile: vi.fn(async () => ({ fileName: 'cfe.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([37, 80]) })),
      saveExtraction: vi.fn(async (_id: string, input: { data: InvoiceRagData }) =>
        doc({ status: 'extracted', extracted: input.data }),
      ),
      markFailed: vi.fn(async () => doc({ status: 'failed' })),
      confirm: vi.fn(async () => doc({ status: 'indexed' })),
      search: vi.fn(async () => []),
      list: vi.fn(),
      getById: vi.fn(),
      remove: vi.fn(),
    };
    window.electronAPI = { invoiceRag: store } as unknown as Window['electronAPI'];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user: () => ({ uid: 'u1' }) } },
      ],
    });
    service = TestBed.inject(InvoiceRagService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    window.electronAPI = undefined as unknown as Window['electronAPI'];
  });

  it('register manda bytes, tipo y usuario; nunca una ruta', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'ticket.png', { type: 'image/png' });
    await service.register(file);

    expect(store['register']).toHaveBeenCalledWith({
      fileName: 'ticket.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      createdBy: 'u1',
    });
  });

  it('extract sube el archivo al backend y guarda el JSON extraído en SQLite', async () => {
    const promise = service.extract(doc(), new Blob(['%PDF'], { type: 'application/pdf' }));

    const req = http.expectOne(`${BASE}/extract`);
    expect(req.request.method).toBe('POST');
    expect((req.request.body as FormData).get('file')).toBeInstanceOf(Blob);
    req.flush({ data: { model: 'google/gemini-2.5-flash', data: DATA } });

    await expect(promise).resolves.toMatchObject({ status: 'extracted' });
    expect(store['saveExtraction']).toHaveBeenCalledWith('d1', { data: DATA, model: 'google/gemini-2.5-flash' });
  });

  it('extract sin archivo en memoria lo lee del disco local', async () => {
    const promise = service.extract(doc());
    await vi.waitFor(() => expect(store['readFile']).toHaveBeenCalledWith('d1'));
    await vi.waitFor(() => http.expectOne(`${BASE}/extract`).flush({ data: { model: 'm', data: DATA } }));
    await promise;
  });

  it('si la extracción falla marca el documento con el motivo y relanza', async () => {
    const promise = service.extract(doc(), new Blob(['x']));
    http
      .expectOne(`${BASE}/extract`)
      .flush({ error: { message: 'La IA no respondió' } }, { status: 504, statusText: 'Gateway Timeout' });

    await expect(promise).rejects.toBeTruthy();
    expect(store['markFailed']).toHaveBeenCalledWith('d1', 'La IA no respondió');
    expect(store['saveExtraction']).not.toHaveBeenCalled();
  });

  it('confirm embebe el texto armado del JSON y lo guarda con el vector', async () => {
    const promise = service.confirm('d1', DATA);

    const req = http.expectOne(`${BASE}/embed`);
    expect(req.request.body).toEqual({ text: buildEmbeddingText(DATA) });
    req.flush({ data: { model: 'emb', dims: 2, vector: [0.1, 0.2] } });

    await promise;
    expect(store['confirm']).toHaveBeenCalledWith('d1', {
      data: DATA,
      contentText: buildEmbeddingText(DATA),
      embedding: { model: 'emb', dims: 2, vector: [0.1, 0.2] },
    });
  });

  it('search embebe la consulta y busca con el mismo modelo', async () => {
    const promise = service.search('  recibo de luz  ', 5);
    const req = http.expectOne(`${BASE}/embed`);
    expect(req.request.body).toEqual({ text: 'recibo de luz' });
    req.flush({ data: { model: 'emb', dims: 2, vector: [1, 0] } });

    await promise;
    expect(store['search']).toHaveBeenCalledWith({ vector: [1, 0], model: 'emb', limit: 5, minScore: INVOICE_RAG_MIN_SCORE });
  });

  it('search con texto vacío no llama al backend', async () => {
    await expect(service.search('   ')).resolves.toEqual([]);
  });

  it('sin Electron avisa que el módulo requiere la app de escritorio', () => {
    window.electronAPI = undefined as unknown as Window['electronAPI'];
    expect(() => service.list()).toThrow(/app de escritorio/);
  });
});
