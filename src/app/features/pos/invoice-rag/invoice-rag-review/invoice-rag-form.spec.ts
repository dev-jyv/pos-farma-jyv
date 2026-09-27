import { TestBed } from '@angular/core/testing';
import { NonNullableFormBuilder } from '@angular/forms';
import { beforeEach, describe, expect, it } from 'vitest';

import { InvoiceRagData } from '../../../../shared/models';
import {
  EMPTY_INVOICE_RAG_DATA,
  buildInvoiceRagForm,
  buildItemGroup,
  buildTaxGroup,
  readInvoiceRagForm,
} from './invoice-rag-form';

const DATA: InvoiceRagData = {
  documentType: 'invoice',
  confidence: 0.87,
  issuer: { name: 'CFE Suministrador', rfc: 'CSS160330CP7' },
  receiver: { name: 'Farmacia JyV', rfc: null },
  folio: 'A-1',
  cfdiUuid: '6F1E2D3C-4B5A-6978-8A9B-0C1D2E3F4A5B',
  issueDate: '2026-09-01',
  currency: 'MXN',
  paymentMethod: 'PUE',
  subtotal: 413.79,
  taxes: [{ type: 'IVA', rate: 0.16, amount: 66.21 }],
  total: 480,
  items: [{ description: 'Suministro', quantity: 1, unitPrice: 413.79, amount: 413.79 }],
  notes: null,
};

describe('invoice-rag-form', () => {
  let fb: NonNullableFormBuilder;

  beforeEach(() => {
    fb = TestBed.inject(NonNullableFormBuilder);
  });

  it('ida y vuelta: el JSON extraído sale igual del formulario', () => {
    const form = buildInvoiceRagForm(fb, DATA);
    expect(form.valid).toBe(true);
    expect(readInvoiceRagForm(form, DATA.confidence)).toEqual(DATA);
  });

  it('muestra la tasa como porcentaje y la guarda como fracción', () => {
    const form = buildInvoiceRagForm(fb, DATA);
    expect(form.controls.taxes.at(0).controls.ratePercent.value).toBe(16);

    form.controls.taxes.at(0).controls.ratePercent.setValue(8);
    expect(readInvoiceRagForm(form, 1).taxes[0].rate).toBe(0.08);
  });

  it('normaliza textos vacíos a null y RFC/UUID/moneda a mayúsculas', () => {
    const form = buildInvoiceRagForm(fb, DATA);
    form.patchValue({
      folio: '   ',
      currency: 'usd',
      cfdiUuid: DATA.cfdiUuid!.toLowerCase(),
      receiver: { name: '', rfc: 'xaxx010101000' },
    });

    expect(readInvoiceRagForm(form, 1)).toMatchObject({
      folio: null,
      currency: 'USD',
      cfdiUuid: DATA.cfdiUuid,
      receiver: { name: null, rfc: 'XAXX010101000' },
    });
  });

  it('valida RFC, UUID y total obligatorio', () => {
    const form = buildInvoiceRagForm(fb, EMPTY_INVOICE_RAG_DATA);
    expect(form.controls.total.hasError('required')).toBe(true);

    form.patchValue({ total: 10, cfdiUuid: 'no-es-uuid', issuer: { rfc: 'ABC' } });
    expect(form.controls.cfdiUuid.invalid).toBe(true);
    expect(form.controls.issuer.controls.rfc.invalid).toBe(true);

    form.patchValue({ cfdiUuid: '', issuer: { rfc: '' } });
    expect(form.valid).toBe(true);
  });

  it('agrega y quita partidas e impuestos', () => {
    const form = buildInvoiceRagForm(fb);
    form.controls.items.push(buildItemGroup(fb));
    form.controls.taxes.push(buildTaxGroup(fb));
    form.controls.items.at(0).patchValue({ description: '  Paracetamol ', amount: 35 });

    const data = readInvoiceRagForm(form, 0);
    expect(data.items).toEqual([{ description: 'Paracetamol', quantity: null, unitPrice: null, amount: 35 }]);
    expect(data.taxes).toEqual([{ type: 'IVA', rate: null, amount: 0 }]);
  });
});
