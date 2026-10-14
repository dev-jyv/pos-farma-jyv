import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_PUSH_BACKOFF_MS,
  AUTO_PUSH_DEBOUNCE_MS,
  AUTO_PUSH_MAX_FAILURES,
  AUTO_PUSH_MAX_WAIT_MS,
  AUTO_PUSH_PAUSE_MS,
  AutoPushService,
  PushOnlyFlusher,
} from './auto-push.service';

describe('AutoPushService', () => {
  let service: AutoPushService;
  let online = true;
  let pending: number;
  let flush: ReturnType<typeof vi.fn>;
  let flusher: PushOnlyFlusher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // sin variación: factor 1.0
    (window as unknown as { electronAPI: object }).electronAPI = {};
    online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    pending = 0;
    flush = vi.fn(async () => {
      pending = 0;
    });
    flusher = { flush: flush as unknown as PushOnlyFlusher['flush'], countPending: async () => pending };
    service = TestBed.inject(AutoPushService);
    service.register(flusher);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: object }).electronAPI;
  });

  it('agrupa varias ventas seguidas en un solo envío tras el debounce', async () => {
    pending = 3;
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(3_000);
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(3_000);
    service.notifyChange();
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('con ventas continuas no pospone más del tope', async () => {
    pending = 1;
    for (let t = 0; t < AUTO_PUSH_MAX_WAIT_MS; t += 5_000) {
      service.notifyChange();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('sin red no intenta; queda en la cola local', async () => {
    online = false;
    pending = 2;
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS * 3);
    expect(flush).not.toHaveBeenCalled();
  });

  it('sin electronAPI (navegador) no hace nada', async () => {
    delete (window as unknown as { electronAPI?: object }).electronAPI;
    pending = 1;
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS * 2);
    expect(flush).not.toHaveBeenCalled();
  });

  it('un cambio durante un envío en curso no lo encima: se reagenda después', async () => {
    pending = 1;
    let release!: () => void;
    flush.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            pending = 1; // la venta nueva sigue en cola
            resolve();
          };
        }),
    );
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledTimes(1);

    pending = 1;
    service.notifyChange(); // llega con el envío en vuelo
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS * 2);
    expect(flush).toHaveBeenCalledTimes(1); // sigue en vuelo: no hay un segundo

    release();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS + 100);
    expect(flush).toHaveBeenCalledTimes(2); // reagendado
  });

  it('si el servidor no confirma nada, reintenta con espera creciente y luego se pausa', async () => {
    pending = 2;
    flush.mockImplementation(async () => undefined); // la cola no baja
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledTimes(1);

    let calls = 1;
    for (const wait of AUTO_PUSH_BACKOFF_MS.slice(0, AUTO_PUSH_MAX_FAILURES - 1)) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(flush).toHaveBeenCalledTimes(calls); // todavía esperando
      await vi.advanceTimersByTimeAsync(1);
      calls += 1;
      expect(flush).toHaveBeenCalledTimes(calls);
    }

    // Tras el último intento sin avance: pausa. Ni el tiempo ni nuevas ventas lo despiertan.
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_PAUSE_MS - 60_000);
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS * 2);
    expect(flush).toHaveBeenCalledTimes(calls);

    // Pasada la pausa vuelve a intentar con un cambio nuevo.
    await vi.advanceTimersByTimeAsync(120_000);
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS + 100);
    expect(flush).toHaveBeenCalledTimes(calls + 1);
  });

  it('un nuevo cambio durante el backoff no lo salta', async () => {
    pending = 1;
    flush.mockImplementation(async () => undefined);
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledTimes(1);
    service.notifyChange(); // otra venta, pero hay backoff de 15 s
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS + 1_000);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_BACKOFF_MS[0]);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('si flush lanza, no revienta y entra a backoff', async () => {
    pending = 1;
    flush.mockRejectedValue(new Error('red'));
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_BACKOFF_MS[0] + 500);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('no sube nada si la cola ya está vacía', async () => {
    pending = 0;
    service.notifyChange();
    await vi.advanceTimersByTimeAsync(AUTO_PUSH_DEBOUNCE_MS + 100);
    expect(flush).not.toHaveBeenCalled();
  });

  it('el contrato solo permite subir: no existe ningún pull en la interfaz', () => {
    expect(Object.keys(flusher).sort()).toEqual(['countPending', 'flush']);
  });
});
