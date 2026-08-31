/**
 * A short synthesised keypress click. Built lazily on the first gesture so no
 * AudioContext is created for people who never start a run.
 */

export class Clicker {
  private ctx: AudioContext | undefined;
  private bus: GainNode | undefined;
  enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** Call from a user gesture (the start keypress). */
  arm(): void {
    if (!this.enabled || this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
      this.bus = this.ctx.createGain();
      this.bus.gain.value = 0.07;
      this.bus.connect(this.ctx.destination);
    } catch {
      this.ctx = undefined;
    }
  }

  click(correct: boolean): void {
    if (!this.enabled) return;
    this.arm();
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    if (ctx.state === 'suspended') void ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = correct ? 'triangle' : 'sawtooth';
    osc.frequency.setValueAtTime(correct ? 1180 : 190, now);
    osc.frequency.exponentialRampToValueAtTime(correct ? 660 : 120, now + 0.045);
    gain.gain.setValueAtTime(correct ? 0.5 : 0.9, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + (correct ? 0.055 : 0.12));
    osc.connect(gain).connect(bus);
    osc.start(now);
    osc.stop(now + 0.14);
  }
}
