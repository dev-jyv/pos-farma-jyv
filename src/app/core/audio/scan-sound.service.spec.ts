import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments/environment';
import { ScanSoundService } from './scan-sound.service';

interface FakeOscillator {
  type: string;
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

describe('ScanSoundService', () => {
  let service: ScanSoundService;
  let oscillators: FakeOscillator[];
  let contextsCreated: number;
  const originalAudioContext = globalThis.AudioContext;
  const originalSoundsEnabled = environment.soundsEnabled;

  beforeEach(() => {
    oscillators = [];
    contextsCreated = 0;

    // Clase y no `vi.fn(() => …)`: el servicio hace `new AudioContext()`, y una
    // función flecha no es construible (el `try/catch` se tragaría el error).
    class FakeAudioContext {
      readonly state = 'running';
      readonly currentTime = 0;
      readonly destination = {};

      constructor() {
        contextsCreated += 1;
      }

      resume(): void {}

      createOscillator(): FakeOscillator {
        const oscillator: FakeOscillator = {
          type: '',
          frequency: { value: 0 },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        oscillators.push(oscillator);
        return oscillator;
      }

      createGain() {
        return {
          gain: { value: 0, exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
      }
    }

    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;

    (environment as { soundsEnabled: boolean }).soundsEnabled = true;
    service = new ScanSoundService();
  });

  afterEach(() => {
    globalThis.AudioContext = originalAudioContext;
    (environment as { soundsEnabled: boolean }).soundsEnabled = originalSoundsEnabled;
  });

  it('cada sonido usa su propio tono y forma de onda', () => {
    service.ok();
    service.error();
    service.warn();

    expect(oscillators.map((osc) => [osc.frequency.value, osc.type])).toEqual([
      [880, 'sine'],
      [220, 'square'],
      [440, 'triangle'],
    ]);
  });

  it('con el sonido apagado en el entorno no crea audio', () => {
    (environment as { soundsEnabled: boolean }).soundsEnabled = false;
    service.ok();
    expect(oscillators).toHaveLength(0);
  });

  it('reusa el mismo AudioContext entre escaneos', () => {
    service.ok();
    service.ok();
    expect(contextsCreated).toBe(1);
  });

  it('un audio bloqueado por el navegador no rompe el escaneo', () => {
    globalThis.AudioContext = class {
      constructor() {
        throw new Error('bloqueado hasta un gesto del usuario');
      }
    } as unknown as typeof AudioContext;
    const blocked = new ScanSoundService();

    expect(() => blocked.ok()).not.toThrow();
  });
});
