/**
 * The one AudioContext. Chrome caps a document at six of them, so a page that
 * opens a second for the music is a page whose click goes silent after enough
 * reloads — the click and the loop share this one, and the single gesture that
 * unlocks it unlocks both. Still lazy: a visitor with both turned off never
 * causes one to exist.
 *
 * This module knows about neither sound source. Levels belong to whoever makes
 * the noise; all `out` is for is a root the graph can hang from.
 */

export type Bus = { ctx: AudioContext; out: GainNode };

let bus: Bus | undefined;
/** no constructor, or it threw. Do not keep trying on every keystroke. */
let refused = false;

/** Call from a user gesture. Idempotent. */
export function armAudio(): Bus | undefined {
  if (bus || refused) return bus;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    refused = true;
    return undefined;
  }
  try {
    const ctx = new Ctor();
    const out = ctx.createGain();
    out.connect(ctx.destination);
    bus = { ctx, out };
  } catch {
    refused = true;
  }
  return bus;
}

/** The bus if it already exists. Never builds one. */
export function audioBus(): Bus | undefined {
  return bus;
}

/**
 * A context built outside a gesture starts suspended and stays that way until
 * something asks from inside one. Idempotent and cheap; call it on every path
 * that is about to make a sound.
 */
export function resumeAudio(): void {
  if (bus && bus.ctx.state !== 'running') void bus.ctx.resume().catch(() => {});
}
