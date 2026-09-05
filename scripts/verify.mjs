/**
 * Drives the running dev server through a full session and writes screenshots.
 *
 *   npm run dev            # in another terminal
 *   node scripts/verify.mjs [outDir]
 *
 * Typing is done by pressing *physical* key codes resolved through the app's own
 * layout tables, so this exercises remap mode exactly as a Dvorak learner would.
 */

import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const URL = process.env.GLIDE_URL ?? 'http://localhost:5273';
const OUT = process.argv[2] ?? 'shots';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Presses whatever the runner says is next, holding a thumb key when the chord
 * calls for one. Returns the label typed, or null when there is nothing left.
 */
async function pressNext(page) {
  const next = await page.evaluate(() => {
    const g = window.__glide;
    const press = g.nextPresses(1)[0];
    if (!press) return null;
    const s = g.settings;
    return { ...press, thumbKey: press.thumb === 'left' ? s.thumbLeft : press.thumb === 'right' ? s.thumbRight : null };
  });
  if (!next) return null;
  // hold the thumb first: that is the case the router resolves without waiting
  if (next.thumbKey) await page.keyboard.down(next.thumbKey);
  await page.keyboard.press(next.shift ? `Shift+${next.code}` : next.code);
  if (next.thumbKey) await page.keyboard.up(next.thumbKey);
  return next.label;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  // Reuse an already-downloaded Chromium when the bundled build is missing.
  const exe = process.env.GLIDE_CHROME;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await wait(400);

  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

  await shot('01-idle');

  // settings panel
  await page.keyboard.press('s');
  await wait(350);
  await shot('02-settings');
  await page.keyboard.press('Escape');
  await wait(250);

  // start
  await page.keyboard.press('Space');
  await wait(180);
  await shot('03-countin');
  await wait(1700);

  // type correctly, at a human-ish pace
  const typed = [];
  for (let i = 0; i < 210; i++) {
    const ok = await pressNext(page);
    if (!ok) break;
    typed.push(ok);
    await wait(i % 17 === 0 ? 130 : 45);
    if (i === 60) await shot('04-running');
  }

  await shot('05-running-late');

  // Finger marks: one comb per upcoming unit, sitting in the leading above its
  // character. The two failures worth catching are a mark eaten by the viewport's
  // top mask fade and two marks smearing into each other.
  const markCheck = await page.evaluate(() => {
    const vp = document.getElementById('text-viewport').getBoundingClientRect();
    const marks = [...document.querySelectorAll('.fmark:not([hidden])')];
    const rects = marks.map((m) => m.getBoundingClientRect());
    const plan = window.__glide.cuePlan(window.__glide.settings.lookahead);
    const badge = marks.find((m) => m.classList.contains('now'));
    const due = plan[0];
    return {
      marks: marks.length,
      expected: plan.filter((c) => c.slot === 0).length,
      // the fade covers the top 14% of the viewport
      clippedByFade: rects.filter((r) => r.top < vp.top + vp.height * 0.14).length,
      belowViewport: rects.filter((r) => r.bottom > vp.bottom).length,
      // only the enlarged "due now" badge may touch its neighbour
      collisions: rects.filter((r, i) => i > 1 && rects[i - 1].right - r.left > 0.5).length,
      badgeMatchesPlan:
        !!badge &&
        badge.dataset.hand === due?.hand &&
        badge.dataset.slot === (due?.finger === 'thumb' ? 'thumb' : String(Number(due.finger[1]) - 2)),
    };
  });
  console.log('marks  :', JSON.stringify(markCheck));

  const mid = await page.evaluate(() => window.__glide.snapshot());

  // mistype: the cursor holds in place, and nothing is inserted to delete
  const wrongKey = await page.evaluate(() => {
    const g = window.__glide;
    const due = g.nextPresses(1)[0];
    const candidates = ['q', 'z', 'x'].map((c) => g.pressesFor(c)?.[0]).filter(Boolean);
    return candidates.find((p) => p.code !== due?.code) ?? candidates[0];
  });
  const textBefore = await page.evaluate(() => window.__glide.runner.text.slice(0, 240));
  await page.keyboard.press(wrongKey.code);
  await wait(260);
  await shot('06-mistype-blocked');

  // the caret stays on the missed character, not past it
  const caret = await page.evaluate(() => {
    const stuck = document.querySelector('.ch.stuck');
    const bar = document.querySelector('.caret');
    if (!stuck || !bar) return null;
    const s = stuck.getBoundingClientRect();
    const c = bar.getBoundingClientRect();
    return {
      caretIsStuck: bar.classList.contains('stuck'),
      offsetFromChar: Math.round(c.left - s.left),
      sameLine: Math.abs(c.top - s.top) < 6,
    };
  });
  console.log('caret  :', JSON.stringify(caret));

  const held = await page.evaluate(() => ({
    cursor: window.__glide.runner.cursor,
    blocked: window.__glide.runner.blocked,
    errors: window.__glide.snapshot().errors,
  }));

  // another wrong key: still held, and the attempt counts
  await page.keyboard.press(wrongKey.code);
  await wait(120);
  const stillHeld = await page.evaluate(() => ({
    cursor: window.__glide.runner.cursor,
    blocked: window.__glide.runner.blocked,
    errors: window.__glide.snapshot().errors,
  }));

  // the right key carries on from the same place, with no backspace
  await pressNext(page);
  await wait(120);
  const cleared = await page.evaluate(() => ({
    cursor: window.__glide.runner.cursor,
    blocked: window.__glide.runner.blocked,
  }));
  const textAfter = await page.evaluate(() => window.__glide.runner.text.slice(0, 240));
  for (let i = 0; i < 6; i++) {
    if (!(await pressNext(page))) break;
    await wait(60);
  }
  console.log('text untouched:', textBefore === textAfter);
  console.log('mistype:', JSON.stringify({ held, stillHeld, cleared }));

  // finish early
  await page.keyboard.press('Escape');
  await wait(900);
  await shot('07-summary');

  const end = await page.evaluate(() => window.__glide.snapshot());

  // blind mode + another layout, to prove the board re-labels
  await page.keyboard.press('Escape');
  await wait(300);
  await page.evaluate(() => window.__glide.applySettings({ layout: 'colemak', lookahead: 3, labelMode: 'blank' }));
  await wait(300);
  await page.keyboard.press('Space');
  await wait(1900);
  for (let i = 0; i < 24; i++) {
    if (!(await pressNext(page))) break;
    await wait(55);
  }
  await shot('08-colemak-blind');

  // graphics: rich. Everything above runs in the default `lite`, which is the app
  // with no blur in it; this is the opt-in look — background wash, frosted
  // panels, canvas shadow blur, and a 2x rather than 1.25x backing store, so a
  // screenshot at deviceScaleFactor 2 is where a resolution mistake would show.
  await page.keyboard.press('Escape');
  await wait(300);
  await page.evaluate(() =>
    window.__glide.applySettings({ layout: 'dvorak', lookahead: 6, labelMode: 'layout', graphics: 'rich' }),
  );
  await wait(300);
  await shot('20-rich-idle');
  await page.keyboard.press('Space');
  await wait(3400);
  for (let i = 0; i < 40; i++) {
    if (!(await pressNext(page))) break;
    await wait(45);
  }
  await shot('21-rich-running');
  await page.keyboard.press('Escape');
  await wait(900);
  await shot('22-rich-summary');
  await page.keyboard.press('Escape');
  await wait(300);
  await page.evaluate(() => window.__glide.applySettings({ graphics: 'lite', labelMode: 'blank' }));
  await wait(300);

  // The narrow window is the case that matters most for the finger marks: the
  // font bottoms out at its clamp minimum *and* the board drops the hand
  // schematics, so the marks are the only fingering left on the screen.
  await page.setViewportSize({ width: 900, height: 760 });
  await wait(400);
  for (let i = 0; i < 12; i++) {
    if (!(await pressNext(page))) break;
    await wait(55);
  }
  await shot('14-narrow');
  const narrow = await page.evaluate(() => {
    const vp = document.getElementById('text-viewport');
    const rects = [...document.querySelectorAll('.fmark:not([hidden])')].map((m) =>
      m.getBoundingClientRect(),
    );
    return {
      fontSize: getComputedStyle(vp).fontSize,
      cell: +document.querySelector('.ch').getBoundingClientRect().width.toFixed(1),
      marks: rects.length,
      widest: rects.length ? +Math.max(...rects.map((r) => r.width)).toFixed(1) : 0,
      collisions: rects.filter((r, i) => i > 1 && rects[i - 1].right - r.left > 0.5).length,
    };
  });
  console.log('narrow :', JSON.stringify(narrow));
  await page.setViewportSize({ width: 1440, height: 900 });
  await wait(300);

  // Japanese: romaji, then both thumb-shift kana layouts
  // Playwright cannot synthesise the JIS keys 無変換/変換, so the kana passes use
  // the US stand-ins and, for 飛鳥, a Space-as-thumb assignment.
  for (const [method, name, thumbs] of [
    ['romaji', '11-ja-romaji', null],
    ['nicola', '12-ja-nicola', { thumbLeft: 'AltLeft', thumbRight: 'AltRight' }],
    ['asuka', '13-ja-asuka', { thumbLeft: 'Space', thumbRight: 'AltRight' }],
  ]) {
    await page.keyboard.press('Escape');
    await wait(250);
    await page.evaluate(
      ({ m, t }) =>
        window.__glide.applySettings({
          source: 'ja',
          jaMethod: m,
          lookahead: 6,
          labelMode: 'layout',
          duration: 60,
          ...(t ?? {}),
        }),
      { m: method, t: thumbs },
    );
    await wait(250);
    await page.keyboard.press('Space');
    await wait(1900);
    for (let i = 0; i < 46; i++) {
      if (!(await pressNext(page))) break;
      await wait(50);
    }
    await shot(name);
    const snap = await page.evaluate(() => window.__glide.snapshot());
    console.log(`${method}${thumbs ? ` [${thumbs.thumbLeft}/${thumbs.thumbRight}]` : ''}: ${JSON.stringify(snap)}`);

    if (method !== 'romaji') {
      // char first, thumb second: the simultaneous window has to catch it
      const late = await page.evaluate(() => {
        const g = window.__glide;
        for (let i = 0; i < 40; i++) {
          const press = g.nextPresses(1)[0];
          if (press?.thumb !== 'none') return { ...press, key: press.thumb === 'left' ? g.settings.thumbLeft : g.settings.thumbRight };
          g.skip();
        }
        return null;
      });
      if (late) {
        // Character key first, thumb 25ms later, key held 200ms: at the default
        // 50% the window closes at 100ms, so this is comfortably inside it.
        // The exact boundary is pinned by tests/input.test.ts instead.
        const before = await page.evaluate(() => window.__glide.snapshot().errors);
        await page.keyboard.down(late.code);
        await wait(25);
        await page.keyboard.down(late.key);
        await wait(200);
        await page.keyboard.up(late.code);
        await page.keyboard.up(late.key);
        await wait(120);
        const after = await page.evaluate(() => window.__glide.snapshot());
        console.log(`${method} late thumb: errors ${before} -> ${after.errors}, blocked ${after.blocked}`);
      }
    }
  }

  // advance mode: a miss is marked and the cursor keeps going.
  // The kana passes leave `source: 'ja'` and Space assigned as a thumb key, so
  // this one has to put the method and the thumbs back before Space can mean
  // "start" again — and the first Escape only ends the run, the second leaves
  // the summary it raised.
  await page.keyboard.press('Escape');
  await wait(900);
  await page.keyboard.press('Escape');
  await wait(250);
  await page.evaluate(() =>
    window.__glide.applySettings({
      source: 'prose',
      layout: 'dvorak',
      lookahead: 6,
      labelMode: 'layout',
      errorMode: 'advance',
      duration: 15,
      thumbLeft: 'NonConvert',
      thumbRight: 'Convert',
    }),
  );
  await wait(200);
  await page.keyboard.press('Space');
  await wait(1900);
  const advanceStart = await page.evaluate(() => window.__glide.runner.phase);
  if (advanceStart !== 'running') throw new Error(`advance pass did not start: ${advanceStart}`);

  const beforeMiss = await page.evaluate(() => window.__glide.snapshot().cursor);
  await page.keyboard.press('Digit9');
  await wait(200);
  const afterMiss = await page.evaluate(() => ({
    cursor: window.__glide.snapshot().cursor,
    blocked: window.__glide.runner.blocked,
  }));
  await shot('09-advance-mode');

  // the last three seconds announce themselves through the text; catch the "2"
  await page.waitForFunction(() => window.__glide.runner.countOutNumber === 2, null, {
    polling: 60,
    timeout: 20_000,
  });
  await wait(140);
  await shot('23-count-out');

  // let the 15s limit expire on its own
  await page.waitForFunction(() => window.__glide.runner.phase === 'finished', null, {
    polling: 60,
    timeout: 20_000,
  });
  const expired = await page.evaluate(() => ({
    phase: window.__glide.runner.phase,
    reason: window.__glide.runner.endReason,
  }));

  // The run ends mid-word, so the space already on its way must not dismiss the
  // summary — neither inside the guard nor after it, since space no longer runs
  // again at all. Only esc leaves, and only once the guard has lapsed.
  await page.keyboard.press('Space');
  await wait(120);
  const insideGuard = await page.evaluate(() => window.__glide.runner.phase);
  await wait(800);
  await page.keyboard.press('Space');
  await page.keyboard.press('s');
  await wait(200);
  const afterGuard = await page.evaluate(() => window.__glide.runner.phase);
  await shot('10-time-expired');
  await page.keyboard.press('Escape');
  await wait(250);
  const afterEscape = await page.evaluate(() => window.__glide.runner.phase);

  console.log('advance:', JSON.stringify({ beforeMiss, afterMiss }));
  console.log('timer  :', JSON.stringify(expired));
  console.log('summary:', JSON.stringify({ insideGuard, afterGuard, afterEscape }));
  console.log('typed:', typed.join(''));
  console.log('mid  :', JSON.stringify(mid));
  console.log('end  :', JSON.stringify(end));
  console.log('console errors:', errors.length ? errors : 'none');

  await browser.close();
  if (errors.length) process.exitCode = 1;
}

main();
