import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { of, throwError } from 'rxjs';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../../../../core/notifications/notification.service';
import { InvoiceService } from '../../services/invoice.service';
import { SupplierService } from '../../services/supplier.service';
import { UploadsService } from '../../services/uploads.service';
import { InvoiceForm } from './invoice-form';

/**
 * El comprobante es **opcional**: la factura se registra aunque el archivo
 * llegue después, o nunca (el proveedor solo dejó ticket). Antes era
 * obligatorio en la pantalla y en el schema del backend a la vez.
 */
describe('InvoiceForm', () => {
  let fixture: ComponentFixture<InvoiceForm>;
  let component: InvoiceForm;
  let create: Mock;
  let upload: Mock;
  let navigate: Mock;
  let notifyError: Mock;

  /** Lo que se manda al backend en la última alta. */
  const ultimaAlta = () => create.mock.calls.at(-1)![0];

  function archivo(name = 'factura.pdf', type = 'application/pdf'): File {
    return new File(['x'], name, { type });
  }

  beforeEach(async () => {
    create = vi.fn(() => of({ id: 'inv-1' }));
    upload = vi.fn(() => of({ storagePath: 'uploads/u-1/factura.pdf' }));
    navigate = vi.fn(() => Promise.resolve(true));
    notifyError = vi.fn();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService({ fallbackLang: 'es', lang: 'es' }),
        providePrimeNG({}),
        MessageService,
        { provide: InvoiceService, useValue: { create } },
        { provide: UploadsService, useValue: { upload } },
        { provide: SupplierService, useValue: { listActive: () => of([]) } },
        { provide: Router, useValue: { navigate } },
        { provide: NotificationService, useValue: { success: vi.fn(), error: notifyError } },
      ],
    });

    fixture = TestBed.createComponent(InvoiceForm);
    component = fixture.componentInstance;
    fixture.detectChanges();

    component.form.patchValue({
      supplierId: 's-1',
      invoiceNumber: 'A-100',
      invoiceDate: '2026-09-05',
      totalAmount: 100,
      hasInvoice: true,
    });
  });

  it('registra la factura sin comprobante', () => {
    component.save();

    expect(create).toHaveBeenCalledTimes(1);
    expect(ultimaAlta().fileUrl).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith(['/pos/facturas']);
  });

  it('sin comprobante no llama a `uploads`', () => {
    // Una subida vacía sería un viaje de red y un objeto huérfano en el Storage.
    component.save();

    expect(upload).not.toHaveBeenCalled();
  });

  it('con comprobante lo sube primero y manda la ruta', () => {
    component.onDrop({
      preventDefault: () => undefined,
      dataTransfer: { files: [archivo()] },
    } as unknown as DragEvent);

    component.save();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(ultimaAlta().fileUrl).toBe('uploads/u-1/factura.pdf');
  });

  it('el tipo "Ticket" también se guarda sin archivo', () => {
    // Es el caso que estaba roto: el backend exigía `fileUrl` incluso aquí.
    component.selectType(false);

    component.save();

    expect(ultimaAlta().hasInvoice).toBe(false);
    expect(ultimaAlta().fileUrl).toBeUndefined();
  });

  describe('lo demás sigue siendo obligatorio', () => {
    it.each([
      ['supplierId', ''],
      ['invoiceNumber', ''],
      ['invoiceDate', ''],
      ['totalAmount', 0],
    ])('no guarda con "%s" vacío', (campo, valor) => {
      component.form.patchValue({ [campo]: valor });

      component.save();

      expect(create).not.toHaveBeenCalled();
    });
  });

  it('un comprobante rechazado bloquea el guardado', () => {
    /**
     * Rechazado no es lo mismo que ausente: el usuario cree que adjuntó algo.
     * Guardar aquí registraría la factura sin el archivo que quiso subir.
     */
    component.onDrop({
      preventDefault: () => undefined,
      dataTransfer: { files: [archivo('virus.exe', 'application/x-msdownload')] },
    } as unknown as DragEvent);
    expect(component.fileError()).not.toBe('');

    component.save();

    expect(create).not.toHaveBeenCalled();
  });

  it('quitar el archivo rechazado desbloquea el guardado', () => {
    component.onDrop({
      preventDefault: () => undefined,
      dataTransfer: { files: [archivo('virus.exe', 'application/x-msdownload')] },
    } as unknown as DragEvent);

    component.clearFile();
    component.save();

    expect(create).toHaveBeenCalledTimes(1);
    expect(ultimaAlta().fileUrl).toBeUndefined();
  });

  it('si el alta falla no navega y avisa', () => {
    create.mockReturnValueOnce(throwError(() => new Error('boom')));

    component.save();

    expect(notifyError).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(component.saving()).toBe(false);
  });

  it('un doble clic real no dispara dos altas', () => {
    // El `[disabled]` del botón llega un tick después del clic.
    create.mockReturnValueOnce(of());

    component.save();
    component.save();

    expect(create).toHaveBeenCalledTimes(1);
  });
});
