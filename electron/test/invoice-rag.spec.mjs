import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import invoiceRag from '../db/invoice-rag.js';
import { createFakePrisma } from './fake-prisma.mjs';

const { register, readFile, list, getById, saveExtraction, markFailed, confirm, search, remove, MAX_FILE_BYTES } =
  invoiceRag;

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = new TextEncoder().encode('%PDF-1.7 factura');

let prisma;
let storageDir;

beforeEach(() => {
  prisma = createFakePrisma();
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-rag-'));
});

afterEach(() => {
  fs.rmSync(storageDir, { recursive: true, force: true });
});

function upload(bytes = PNG, overrides = {}) {
  return register(prisma, storageDir, {
    fileName: 'ticket.png',
    mimeType: 'image/png',
    bytes,
    createdBy: 'user-1',
    ...overrides,
  });
}

function embeddingOf(vector, model = 'openai/text-embedding-3-small') {
  return { data: { documentType: 'invoice', total: 116 }, contentText: 'Factura', embedding: { model, vector } };
}

describe('register', () => {
  it('guarda el archivo en disco y el documento en estado uploaded', async () => {
    const { document, duplicate } = await upload();

    expect(duplicate).toBe(false);
    expect(document).toMatchObject({ fileName: 'ticket.png', mimeType: 'image/png', sizeBytes: PNG.length, status: 'uploaded' });
    expect(document).not.toHaveProperty('filePath');
    expect(fs.readdirSync(storageDir)).toEqual([`${document.id}.png`]);
  });

  it('no duplica un archivo con el mismo contenido', async () => {
    const first = await upload();
    const second = await upload(PNG, { fileName: 'otro-nombre.png' });

    expect(second).toEqual({ document: first.document, duplicate: true });
    expect(prisma.invoiceDocument.rows).toHaveLength(1);
    expect(fs.readdirSync(storageDir)).toHaveLength(1);
  });

  it.each([
    ['tipo no permitido', { mimeType: 'text/plain' }, PNG, 'Tipo de archivo no permitido'],
    ['contenido que no coincide', { mimeType: 'application/pdf' }, PNG, 'no coincide'],
    ['archivo vacío', {}, new Uint8Array(), 'vacío'],
    ['sin usuario', { createdBy: '' }, PNG, 'Usuario requerido'],
  ])('rechaza %s', async (_label, overrides, bytes, message) => {
    await expect(upload(bytes, overrides)).rejects.toThrow(message);
    expect(prisma.invoiceDocument.rows).toHaveLength(0);
  });

  it('rechaza archivos de más de 10 MB', async () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(PNG);
    await expect(upload(big)).rejects.toThrow('10 MB');
  });

  it('borra el archivo si falla el alta en la base', async () => {
    prisma.invoiceDocument.create = async () => {
      throw new Error('disco lleno');
    };
    await expect(upload()).rejects.toThrow('disco lleno');
    expect(fs.readdirSync(storageDir)).toEqual([]);
  });
});

describe('readFile', () => {
  it('devuelve los bytes originales para la vista previa', async () => {
    const { document } = await upload(PDF, { mimeType: 'application/pdf', fileName: 'f.pdf' });
    const file = await readFile(prisma, document.id);

    expect(file.mimeType).toBe('application/pdf');
    expect(Array.from(file.bytes)).toEqual(Array.from(PDF));
  });
});

describe('extracción', () => {
  it('saveExtraction guarda el JSON, tipo y confianza acotada', async () => {
    const { document } = await upload();
    const saved = await saveExtraction(prisma, document.id, {
      data: { documentType: 'receipt', confidence: 1.7, total: 50 },
      model: 'google/gemini-2.5-flash',
    });

    expect(saved).toMatchObject({
      status: 'extracted',
      documentType: 'receipt',
      confidence: 1,
      extracted: { documentType: 'receipt', total: 50 },
      model: 'google/gemini-2.5-flash',
    });
  });

  it('un documentType desconocido queda como other', async () => {
    const { document } = await upload();
    const saved = await saveExtraction(prisma, document.id, { data: { documentType: 'menu' } });
    expect(saved.documentType).toBe('other');
  });

  it('markFailed deja el error visible', async () => {
    const { document } = await upload();
    const failed = await markFailed(prisma, document.id, 'OpenRouter no respondió');
    expect(failed).toMatchObject({ status: 'failed', extractError: 'OpenRouter no respondió' });
  });

  it('falla con un id inexistente', async () => {
    await expect(saveExtraction(prisma, 'nope', { data: {} })).rejects.toThrow('Documento no encontrado');
  });
});

describe('confirm + search', () => {
  it('guarda el JSON confirmado y el vector como Float32', async () => {
    const { document } = await upload();
    const confirmed = await confirm(prisma, document.id, embeddingOf([0.5, 0.25, 1]));

    expect(confirmed).toMatchObject({ status: 'indexed', documentType: 'invoice', confirmed: { total: 116 } });
    const [row] = prisma.invoiceEmbedding.rows;
    expect(row).toMatchObject({ documentId: document.id, dims: 3, contentText: 'Factura' });
    expect(Array.from(new Float32Array(new Uint8Array(row.vector).buffer))).toEqual([0.5, 0.25, 1]);
  });

  it('reconfirmar reemplaza el embedding en vez de duplicarlo', async () => {
    const { document } = await upload();
    await confirm(prisma, document.id, embeddingOf([1, 0]));
    await confirm(prisma, document.id, embeddingOf([0, 1]));

    expect(prisma.invoiceEmbedding.rows).toHaveLength(1);
    expect(prisma.invoiceEmbedding.rows[0].dims).toBe(2);
  });

  it('rechaza vectores vacíos o con valores no numéricos', async () => {
    const { document } = await upload();
    await expect(confirm(prisma, document.id, embeddingOf([]))).rejects.toThrow('Vector');
    await expect(confirm(prisma, document.id, embeddingOf([1, Number.NaN]))).rejects.toThrow('Vector');
  });

  it('ordena por similitud coseno y respeta modelo, dimensiones y minScore', async () => {
    const a = (await upload(PNG)).document;
    const b = (await upload(PDF, { mimeType: 'application/pdf' })).document;
    const c = (await upload(Uint8Array.from([0xff, 0xd8, 0xff, 9]), { mimeType: 'image/jpeg' })).document;
    await confirm(prisma, a.id, embeddingOf([1, 0]));
    await confirm(prisma, b.id, embeddingOf([0.7, 0.7]));
    await confirm(prisma, c.id, embeddingOf([1, 0], 'otro-modelo'));

    const hits = await search(prisma, { vector: [1, 0], model: 'openai/text-embedding-3-small' });
    expect(hits.map((h) => h.document.id)).toEqual([a.id, b.id]);
    expect(hits[0].score).toBeCloseTo(1);
    expect(hits[1].score).toBeCloseTo(Math.SQRT1_2, 5);

    expect(await search(prisma, { vector: [1, 0], model: 'openai/text-embedding-3-small', minScore: 0.9 })).toHaveLength(1);
    expect(await search(prisma, { vector: [1, 0, 0] })).toEqual([]);
    expect(await search(prisma, { vector: [0, 0] })).toEqual([]);
  });
});

describe('list / getById / remove', () => {
  it('pagina, filtra y busca por nombre o JSON confirmado', async () => {
    const a = (await upload(PNG, { fileName: 'farmacos.png' })).document;
    const b = (await upload(PDF, { mimeType: 'application/pdf', fileName: 'luz.pdf' })).document;
    await confirm(prisma, b.id, { ...embeddingOf([1]), data: { documentType: 'invoice', issuer: { name: 'CFE' } } });

    expect((await list(prisma)).total).toBe(2);
    expect((await list(prisma, { status: 'indexed' })).items.map((d) => d.id)).toEqual([b.id]);
    expect((await list(prisma, { term: 'cfe' })).items.map((d) => d.id)).toEqual([b.id]);
    expect((await list(prisma, { term: 'FARMA' })).items.map((d) => d.id)).toEqual([a.id]);
    const page2 = await list(prisma, { page: 2, limit: 1 });
    expect(page2).toMatchObject({ total: 2 });
    expect(page2.items).toHaveLength(1);
  });

  it('getById devuelve null si no existe', async () => {
    expect(await getById(prisma, 'nope')).toBeNull();
  });

  it('remove borra documento, embedding y archivo', async () => {
    const { document } = await upload();
    await confirm(prisma, document.id, embeddingOf([1]));

    await remove(prisma, document.id);

    expect(prisma.invoiceDocument.rows).toHaveLength(0);
    expect(prisma.invoiceEmbedding.rows).toHaveLength(0);
    expect(fs.readdirSync(storageDir)).toEqual([]);
  });
});
