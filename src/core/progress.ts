/**
 * 写経 bookmarks: where you left off in each work.
 *
 * This is the app's third localStorage key, and the warning in settings.ts
 * applies word for word — localStorage is keyed by *origin*, so on a
 * user.github.io every other page that user hosts there can write here, as can
 * an older build of GLIDE whose chunk numbering was different.
 *
 * One value cannot be validated on load, and that is the interesting one.
 * `chunk` is an index into a work whose body is fetched lazily and is not here
 * yet, so there is nothing to range-check it against. Its clamp therefore lives
 * in `resumeAt`, called once the body has landed — the equivalent of
 * settings.ts's source check for a value whose bound arrives later.
 *
 * What is stored is exactly where you stopped: a chunk and a character offset
 * into it. The *rounding* happens at resume, in `resumePoint` (works.ts), which
 * backs the offset up to the top of the sentence you were in. Keeping the raw
 * offset here rather than a rounded one is deliberate — the rounding rule can
 * change without every stored bookmark meaning something slightly wrong.
 *
 * An arbitrary character offset is not safe to resume from: it can land inside
 * a unit, half-way through romaji きゃ. A sentence start is, because a sentence
 * begins after terminating punctuation and no unit spans that. Chunk starts are
 * the other safe offsets, which is what an offset of 0 falls back to.
 */

/** A work's place. `chunk` is the NEXT chunk to type, not the last one done. */
export type Bookmark = {
  chunk: number;
  /**
   * Characters into `chunk` where the reader stopped, unrounded. `resumePoint`
   * rounds it back to a sentence start; nothing else may treat it as a place to
   * start typing from.
   */
  offset: number;
  /** furthest chunk ever reached, so jumping back does not erase the trail */
  furthest: number;
  /** characters of the work typed through, for the readout */
  chars: number;
  /** characters typed into this work across every session; counts re-typing */
  typed: number;
  /** runs that put at least one character into this work */
  sessions: number;
  /** epoch ms of the last session; the prune key */
  at: number;
  /** the work's `stamp` when this was written */
  stamp: string;
};

export type ProgressStore = { works: Record<string, Bookmark> };

const STORAGE_KEY = 'dvorak-trainer/progress/v1';

/**
 * Bookmarks kept. One is about 120 bytes, so this is a courteous share of an
 * origin — and unlike the run log there is no reason to hold hundreds: a
 * bookmark matters for a work you are still reading.
 */
export const MAX_WORKS = 24;

export const emptyBookmark = (stamp = ''): Bookmark => ({
  chunk: 0,
  offset: 0,
  furthest: 0,
  chars: 0,
  typed: 0,
  sessions: 0,
  at: 0,
  stamp,
});

const nat = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

function validBookmark(raw: unknown): Bookmark | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const chunk = nat(r.chunk, 0);
  return {
    chunk,
    offset: nat(r.offset, 0),
    furthest: Math.max(chunk, nat(r.furthest, chunk)),
    chars: nat(r.chars, 0),
    typed: nat(r.typed, 0),
    sessions: nat(r.sessions, 0),
    at: nat(r.at, 0),
    stamp: typeof r.stamp === 'string' && r.stamp.length <= 64 ? r.stamp : '',
  };
}

/** Keeps the newest MAX_WORKS by `at`. */
function prune(works: Record<string, Bookmark>): Record<string, Bookmark> {
  const entries = Object.entries(works);
  if (entries.length <= MAX_WORKS) return works;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_WORKS));
}

export function loadProgress(): ProgressStore {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : undefined;
  } catch {
    stored = undefined;
  }
  const bag = (stored as { works?: unknown } | undefined)?.works;
  const works: Record<string, Bookmark> = {};
  if (typeof bag === 'object' && bag !== null && !Array.isArray(bag)) {
    for (const [id, value] of Object.entries(bag as Record<string, unknown>)) {
      // A bookmark whose work this build no longer ships is still kept: the data
      // file may be missing for a moment, and losing someone's place in a novel
      // is not a thing to do casually. The prune is what bounds the junk.
      if (!id || id.length > 128) continue;
      const mark = validBookmark(value);
      if (mark) works[id] = mark;
    }
  }
  return { works: prune(works) };
}

function save(store: ProgressStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* private mode / storage disabled — the place just won't persist */
  }
}

/**
 * Always returns a bookmark. `stale` means the work has been re-cut since this
 * was written, so the chunk number points somewhere else in the same book — the
 * one thing a bookmark cannot detect on its own.
 */
export function bookmarkOf(
  store: ProgressStore,
  workId: string,
  stamp: string,
): Bookmark & { stale: boolean } {
  const mark = store.works[workId];
  if (!mark) return { ...emptyBookmark(stamp), stale: false };
  return { ...mark, stale: mark.stamp !== '' && mark.stamp !== stamp };
}

export function saveBookmark(workId: string, patch: Partial<Bookmark>): ProgressStore {
  const store = loadProgress();
  const before = store.works[workId] ?? emptyBookmark();
  const next: Bookmark = { ...before, ...patch };
  next.chunk = Math.max(0, Math.floor(next.chunk));
  // An offset only means anything inside the chunk it was measured in. A writer
  // that moves the chunk without saying where in it — a chapter jump, a restart
  // — means the top of that chunk, not wherever the last one was left.
  next.offset =
    patch.chunk !== undefined && patch.offset === undefined ? 0 : nat(next.offset, 0);
  next.furthest = Math.max(next.furthest, next.chunk);
  next.at = patch.at ?? Date.now();
  store.works[workId] = next;
  const pruned = { works: prune(store.works) };
  save(pruned);
  return pruned;
}

export function clearBookmark(workId: string): ProgressStore {
  const store = loadProgress();
  delete store.works[workId];
  save(store);
  return store;
}

export function clearAllProgress(): ProgressStore {
  const store: ProgressStore = { works: {} };
  save(store);
  return store;
}

/**
 * The clamp that could not happen at load time, now that the work is in hand.
 * A bookmark past the end means the work shrank in a rebuild; landing on
 * `chunkCount` starts a run with nothing in it, so step back to the last chunk.
 */
export function resumeAt(mark: Bookmark, chunkCount: number): number {
  if (chunkCount <= 0) return 0;
  if (mark.chunk >= chunkCount) return Math.max(0, chunkCount - 1);
  return Math.max(0, mark.chunk);
}
