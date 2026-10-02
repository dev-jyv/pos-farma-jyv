import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { unwrapEntity } from '../../../core/api/api.utils';
import { environment } from '../../../../environments/environment';

const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export interface UploadResult {
  storagePath: string;
  fileName: string;
  mimeType: string;
  fileUrl: string;
}

export function validateUploadFile(file: File): string | null {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return 'Tipo de archivo no permitido. Usa PDF o imagen (JPEG, PNG, WebP).';
  }
  if (file.size > MAX_FILE_SIZE) {
    return 'El archivo no puede superar los 10 MB.';
  }
  return null;
}

/**
 * `POST /uploads`, multipart. A diferencia del admin (que usa `fetch` +
 * `@angular/fire/auth` a mano), aquí basta `HttpClient`: `auth.interceptor.ts`
 * ya adjunta el token a cualquier request contra `environment.apiUrl`,
 * `FormData` incluido (Angular no fuerza un `Content-Type` en ese caso).
 */
@Injectable({ providedIn: 'root' })
export class UploadsService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  upload(file: File): Observable<UploadResult> {
    return this.post('uploads', file);
  }

  /**
   * Comprobante de factura. Ruta propia porque el destino es otro:
   * `POST /uploads/facturas` guarda en Cloudflare R2, no en Firebase Storage.
   * Del lado del cliente no cambia nada más — la respuesta trae el mismo
   * `storagePath`, que es lo único que se manda al registrar la factura.
   */
  uploadInvoice(file: File): Observable<UploadResult> {
    return this.post('uploads/facturas', file);
  }

  private post(ruta: string, file: File): Observable<UploadResult> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http
      .post<unknown>(`${this.apiUrl}/${ruta}`, formData)
      .pipe(map((response) => unwrapEntity<UploadResult>(response)));
  }
}
