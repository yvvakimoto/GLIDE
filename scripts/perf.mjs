/**
 * Frame-time probe: drives a run and samples rAF deltas plus a main-thread
 * busy estimate. Prints median / p95 for the running and the idle phase.
 */
import { chromium } from 'playwright';

const URL = process.env.GLIDE_URL ?? 'http://localhost:5273';
const LABEL = process.argv[2] ?? 'run';
/** GLIDE_VIEWPORT=2560x1440 to check fill rate on a big panel */
const [VW, VH] = (process.env.GLIDE_VIEWPORT ?? '1440x900').split('x').map(Number);
const GRAPHICS = process.argv[3] ?? null; // 'lite' | 'rich'

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pressNext(page) {
  const next = await page.evaluate(() => {
    const g = window.__glide;
    const press = g.nextPresses(1)[0];
    if (!press) return null;
    const s = g.settings;
    return {
      ...press,
      thumbKey: press.thumb === 'left' ? s.thumbLeft : press.thumb === 'right' ? s.thumbRight : null,
    };
  });
  if (!next) return null;
  if (next.thumbKey) await page.keyboard.down(next.thumbKey);
  await page.keyboard.press(next.shift ? `Shift+${next.code}` : next.code);
  if (next.thumbKey) await page.keyboard.up(next.thumbKey);
  return next.label;
}

/** Samples rAF deltas for `ms`, and the synchronous cost of the app's own frame work. */
function sampler(ms) {
  return new Promise((res) => {
    const deltas = [];
    let last = performance.now();
    const t0 = last;
    const tick = (t) => {
      deltas.push(t - last);
      last = t;
      if (t - t0 < ms) requestAnimationFrame(tick);
      else res(deltas);
    };
    requestAnimationFrame(tick);
  });
}

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { n: s.length, median: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
};

const main = async () => {
  const exe = process.env.GLIDE_CHROME;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await wait(500);

  if (GRAPHICS) {
    await page.evaluate((g) => window.__glide.applySettings({ graphics: g }), GRAPHICS);
    await wait(300);
  }
  // music: false is not cosmetic. The running sample comes after a Space, and a
  // live mp3 decode plus a WebAudio graph on a machine with no GPU would make
  // "take a reading, git stash, take another" a comparison of two workloads.
  await page.evaluate(() => window.__glide.applySettings({ duration: 0, music: false }));
  await wait(200);

  const idle = await page.evaluate(`(${sampler})(2500)`);

  await page.keyboard.press('Space');
  await wait(3400);
  for (let i = 0; i < 40; i++) await pressNext(page);

  // Sample with the run live but no key traffic: driving Playwright's keyboard
  // through CDP costs more per press than the frame does, and it lands in the
  // same numbers. The board is still animating — ribbon shimmer, hand pulse,
  // the tail of the last bloom — so this is the running cost, not an idle one.
  const running = await page.evaluate(`(${sampler})(3000)`);

  await page.keyboard.press('Escape');
  await wait(600);
  const finished = await page.evaluate(`(${sampler})(2000)`);

  console.log(
    JSON.stringify(
      { label: LABEL, graphics: GRAPHICS ?? 'default', idle: stat(idle), running: stat(running), finished: stat(finished) },
      null,
      2,
    ),
  );
  await browser.close();
};

main();
