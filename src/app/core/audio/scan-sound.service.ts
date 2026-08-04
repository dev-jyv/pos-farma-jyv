import { Injectable } from '@angular/core';

import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ScanSoundService {
  private context: AudioContext | null = null;

  ok(): void {
    this.play(880, 0.08, 'sine');
  }

  error(): void {
    this.play(220, 0.18, 'square');
  }

  warn(): void {
    this.play(440, 0.12, 'triangle');
  }

  private play(frequency: number, durationSec: number, type: OscillatorType): void {
    if (!environment.soundsEnabled) {
      return;
    }
    try {
      const ctx = this.getContext();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      oscillator.start(now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);
      oscillator.stop(now + durationSec);
    } catch {
      // Audio may be blocked until user gesture; ignore.
    }
  }

  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
    }
    if (this.context.state === 'suspended') {
      void this.context.resume();
    }
    return this.context;
  }
}
