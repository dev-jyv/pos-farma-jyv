import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../../core/notifications/notification.service';
import { InvoiceRagDocument, InvoiceRagSearchHit } from '../../../../shared/models';
import { EMPTY_INVOICE_RAG_DATA } from '../invoice-rag-review/invoice-rag-form';
import { InvoiceRagService } from '../services/invoice-rag.service';
import { InvoiceRagSearch } from './invoice-rag-search';

function hit(id: string, score: number, issuer: string): InvoiceRagSearchHit {
  return {
    score,
    document: {
      id,
      fileName: `${id}.pdf`,
      mimeType: 'application/pdf',
      status: 'indexed',
      documentType: 'invoice',
      confirmed: { ...EMPTY_INVOICE_RAG_DATA, issuer: { name: issuer, rfc: null }, total: 480 },
    } as InvoiceRagDocument,
  };
}

describe('InvoiceRagSearch', () => {
  let fixture: ComponentFixture<InvoiceRagSearch>;
  let component: InvoiceRagSearch;
  let search: Mock;
  let navigate: Mock;
  let notifyError: Mock;

  beforeEach(async () => {
    search = vi.fn(async () => [hit('d1', 0.91, 'CFE Suministrador'), hit('d2', 0.42, 'Telmex')]);
    navigate = vi.fn();
    notifyError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: NotificationService, useValue: { error: notifyError, success: vi.fn() } },
        { provide: Router, useValue: { navigate } },
        { provide: InvoiceRagService, useValue: { available: true, search } },
      ],
    });
    fixture = TestBed.createComponent(InvoiceRagSearch);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('no busca con la consulta vacía', async () => {
    component.query.set('   ');
    await component.search();
    expect(search).not.toHaveBeenCalled();
  });

  it('muestra los resultados en orden con su similitud', async () => {
    component.query.set('recibo de luz');
    await component.search();
    fixture.detectChanges();

    expect(search).toHaveBeenCalledWith('recibo de luz');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text.indexOf('CFE Suministrador')).toBeLessThan(text.indexOf('Telmex'));
    expect(text).toContain('91%');
  });

  it('abre el documento elegido en la pantalla de revisión', async () => {
    component.query.set('luz');
    await component.search();
    component.open(component.hits()[0]);
    expect(navigate).toHaveBeenCalledWith(['/pos/facturas-rag', 'd1']);
  });

  it('si el backend falla avisa y no deja resultados', async () => {
    search.mockRejectedValueOnce(new Error('El servicio de IA no respondió a tiempo'));
    component.query.set('luz');
    await component.search();

    expect(notifyError).toHaveBeenCalledWith('El servicio de IA no respondió a tiempo');
    expect(component.hits()).toEqual([]);
    expect(component.searching()).toBe(false);
  });
});
