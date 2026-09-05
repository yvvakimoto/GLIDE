/**
 * 写経 — works typed straight through, in order, across many sessions.
 *
 * Two files per work, and the split is load-bearing. The *index* is bundled and
 * synchronous, because listSources() (corpus.ts), SOURCE_IDS (settings.ts) and
 * sourceScript() all run at module scope and a source id that is not in
 * listSources() at load time is silently reset to the default. The *body* is
 * megabytes and arrives on demand.
 *
 * Bodies are reached through import.meta.glob rather than fetch. A dynamic
 * import of a bundled chunk resolves exactly the way the entry bundle does, so
 * it keeps working under `base: './'` at a domain root, under a /<repo>/ subpath
 * and over file://; a hand-rolled fetch path would have to re-derive all three.
 * Vite fingerprints the chunk, so a work downloads once and is then cached for
 * good, which is as close to the corpora's offline promise as a lazy work gets.
 */

import type { Script } from './method';

/** One chunk is one thing to type in a sitting's rhythm — a paragraph, or a slice of one. */
export type Chunk = {
  /** the text, appended verbatim into Runner.text; carries its own trailing separator */
  t: string;
  /** 1 when this chunk opens a new paragraph */
  p?: 1;
};

export type WorkChapter = {
  id: string;
  title: string;
  /** index of this chapter's first chunk */
  start: number;
  count: number;
  chars: number;
};

export type Work = {
  id: string;
  title: string;
  author: string;
  url?: string;
  script: Script;
  chunks: readonly Chunk[];
  chapters: readonly WorkChapter[];
  /** cumulative character offset of chunk i; length chunks.length + 1 */
  offsets: readonly number[];
  chars: number;
  /**
   * Hash of the chunking. A rebuild that re-cuts chunks must change this, because
   * a bookmark is a chunk index and nothing else can tell that it now points
   * somewhere different in the same book.
   */
  stamp: string;
};

/** What the bundled index carries: everything but the text. */
export type WorkMeta = {
  id: string;
  title: string;
  author: string;
  url?: string;
  script: Script;
  chars: number;
  chunks: number;
  stamp: string;
  /** so the contents panel can draw the chapter list before the body arrives */
  chapterTitles: readonly string[];
  /**
   * Every distinct character the work's text contains.
   *
   * It lives in the index rather than being derived from the body, because
   * corpusCharset() is synchronous and feeds a startup check that must cover
   * works the reader has never opened. loadWork re-checks it against the real
   * bytes under DEV, which is where a builder bug shows up.
   */
  charset: string;
  /** rough download size, so the picker can say what it is about to fetch */
  bytes?: number;
};

import indexData from '../corpus/works-index.json';

const SCRIPTS: ReadonlySet<string> = new Set<Script>(['latin', 'ja']);

function validMeta(raw: unknown): WorkMeta | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const { id, title, author, url, script, chars, chunks, stamp, chapterTitles, charset, bytes } = r;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof title !== 'string' || typeof author !== 'string' || typeof stamp !== 'string') return undefined;
  if (typeof script !== 'string' || !SCRIPTS.has(script)) return undefined;
  if (typeof chars !== 'number' || typeof chunks !== 'number') return undefined;
  if (!Array.isArray(chapterTitles) || typeof charset !== 'string') return undefined;
  return {
    id,
    title,
    author,
    script: script as Script,
    chars,
    chunks,
    stamp,
    chapterTitles: chapterTitles.filter((t): t is string => typeof t === 'string'),
    charset,
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof bytes === 'number' ? { bytes } : {}),
  };
}

const INDEX: readonly WorkMeta[] = ((indexData as { works?: unknown }).works as unknown[] | undefined ?? [])
  .map(validMeta)
  .filter((m): m is WorkMeta => m !== undefined);

const BY_ID = new Map(INDEX.map((m) => [m.id, m]));

/** Work ids are namespaced so `isWorkId` never has to consult the index. */
export const WORK_PREFIX = 'work/';

export const isWorkId = (id: string): boolean => id.startsWith(WORK_PREFIX);

export function listWorks(): readonly WorkMeta[] {
  return INDEX;
}

export function getWorkMeta(id: string): WorkMeta | undefined {
  return BY_ID.get(id);
}

const BODIES = import.meta.glob<{ default: Work }>('../corpus/works/*.json');

const loaded = new Map<string, Work>();
const inflight = new Map<string, Promise<Work>>();

/** The cache-population step, shared by loadWork and by tests. */
export function registerWork(work: Work): void {
  loaded.set(work.id, work);
}

/** Synchronous cache read — this is what createStream can use. */
export function getLoadedWork(id: string): Work | undefined {
  return loaded.get(id);
}

export const isWorkLoaded = (id: string): boolean => loaded.has(id);

function checkWork(id: string, raw: unknown): Work {
  if (typeof raw !== 'object' || raw === null) throw new Error(`work ${id}: not an object`);
  const w = raw as Partial<Work>;
  if (!Array.isArray(w.chunks) || !w.chunks.length) throw new Error(`work ${id}: no chunks`);
  if (!Array.isArray(w.offsets) || w.offsets.length !== w.chunks.length + 1) {
    throw new Error(`work ${id}: offsets must be one longer than chunks`);
  }
  if (!Array.isArray(w.chapters) || !w.chapters.length) throw new Error(`work ${id}: no chapters`);
  const meta = BY_ID.get(id);
  if (meta && meta.stamp !== w.stamp) {
    throw new Error(`work ${id}: body stamp ${w.stamp} does not match the index's ${meta.stamp}`);
  }
  if (import.meta.env.DEV && meta) {
    // corpusCharset() trusts the index, and the startup check trusts
    // corpusCharset(). This is the one moment the real bytes are in hand, so it
    // is the only place a builder that under-reported can be caught.
    const promised = new Set(meta.charset);
    const stray = new Set<string>();
    for (const chunk of w.chunks as readonly Chunk[]) {
      for (const ch of chunk.t) if (!promised.has(ch)) stray.add(ch);
    }
    if (stray.size) {
      console.error(`work ${id}: text contains characters the index did not list:`, [...stray].join(''));
    }
  }
  return raw as Work;
}

/**
 * Fetches a work's body, once. Concurrent callers share one request, and a
 * failure is not cached — being offline the first time should not poison the
 * work for the rest of the session.
 */
export function loadWork(id: string): Promise<Work> {
  const hit = loaded.get(id);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(id);
  if (pending) return pending;

  const key = `../corpus/works/${id.slice(WORK_PREFIX.length)}.json`;
  const load = BODIES[key];
  if (!load) return Promise.reject(new Error(`unknown work ${id}`));

  const promise = load()
    .then((module) => {
      const work = checkWork(id, module.default);
      registerWork(work);
      inflight.delete(id);
      return work;
    })
    .catch((error: unknown) => {
      inflight.delete(id);
      throw error;
    });
  inflight.set(id, promise);
  return promise;
}
