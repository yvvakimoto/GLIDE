/**
 * A short synthesised keypress click. Built lazily on the first gesture so no
 * AudioContext is created for people who never start a run — see `audio.ts`,
 * which owns the context this shares with the background loop.
 */

import { armAudio, audioBus, resumeAudio } from './audio';

export class Clicker {
  /** the click's own level, on the shared bus. Made with the context, once. */
  private gate: GainNode | undefined;
  enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  click(correct: boolean): void {
    if (!this.enabled) return;
    // the first keystroke can still be the first gesture: main.ts's unlock
    // listener has usually run one event earlier, but nothing here relies on it.
    const bus = armAudio() ?? audioBus();
    if (!bus) return;
    resumeAudio();
    const ctx = bus.ctx;
    if (!this.gate) {
      this.gate = ctx.createGain();
      this.gate.gain.value = 0.07;
      this.gate.connect(bus.out);
    }
    const gate = this.gate;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = correct ? 'triangle' : 'sawtooth';
    osc.frequency.setValueAtTime(correct ? 1180 : 190, now);
    osc.frequency.exponentialRampToValueAtTime(correct ? 660 : 120, now + 0.045);
    gain.gain.setValueAtTime(correct ? 0.5 : 0.9, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + (correct ? 0.055 : 0.12));
    osc.connect(gain).connect(gate);
    osc.start(now);
    osc.stop(now + 0.14);
  }
}
