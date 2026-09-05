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

  // The music defaults on, and every pass below would otherwise start a 4 MB
  // fetch on its first keypress. Pinned off here and exercised on its own at the
  // very end, where the settings this file bleeds between passes cannot reach.
  await page.evaluate(() => window.__glide.applySettings({ music: false }));

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

  // 写経: leaving the summary with esc has to land where tab lands. `reset`
  // alone rebuilds the buffer from wherever the *stream* got to, which is up to
  // BUFFER_AHEAD — several paragraphs — past the cursor, and the next tick then
  // writes that over the bookmark. Unit tests reach the runner but not this
  // sequence of keys, so it is pinned here. Last pass: it restores nothing, and
  // it relies on the advance pass having already put the latin settings and the
  // thumbs back so that Space means "start".
  let shakyo = 'skipped: no work in the picker';
  await page.evaluate(() => window.__glide.clearProgress());
  await page.evaluate(() =>
    window.__glide.applySettings({ errorMode: 'block', duration: 0, labelMode: 'layout' }),
  );
  await page.keyboard.press('c');
  await wait(300);
  const workId = await page.evaluate(
    () => document.querySelector('option[value^="work/"]')?.value ?? null,
  );
  await page.keyboard.press('Escape');
  await wait(250);

  if (workId) {
    // selectWork, never applySettings: the body has to land before `source`
    // moves, or this silently gets the fallback shuffle instead of the work
    await page.evaluate((id) => window.__glide.selectWork(id), workId);
    await page.waitForFunction((id) => window.__glide.settings.source === id, workId, {
      polling: 60,
      timeout: 20_000,
    });

    // start a few paragraphs in: a work's first chunk can be one long sentence
    // (Alice's is), and then every resume rounds back to zero and this pass
    // stops saying anything about where a resume actually lands
    await page.evaluate(() => window.__glide.seekChunk(5));
    await wait(150);

    await page.keyboard.press('Space');
    await wait(1900);
    const shakyoStart = await page.evaluate(() => window.__glide.runner.phase);
    if (shakyoStart !== 'running') throw new Error(`shakyo pass did not start: ${shakyoStart}`);
    for (let i = 0; i < 90; i++) {
      if (!(await pressNext(page))) break;
      await wait(35);
    }

    await page.keyboard.press('Escape'); // end the run: the summary comes up
    await wait(900);
    await shot('24-shakyo-summary');
    const stopped = await page.evaluate(() => window.__glide.mark);

    await page.keyboard.press('Escape'); // leave the summary
    await wait(300);
    const idleMark = await page.evaluate(() => window.__glide.mark);

    // a hidden tab writes the place, and at idle that must not be somewhere new
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const stored = await page.evaluate(
      (id) =>
        JSON.parse(localStorage.getItem('dvorak-trainer/progress/v1') ?? '{}').works?.[id] ?? null,
      workId,
    );

    await page.keyboard.press('Space'); // run again
    await wait(1900);
    const resumed = await page.evaluate(() => window.__glide.mark);
    await shot('25-shakyo-resumed');

    const ahead = resumed.chars - stopped.chars;
    shakyo = JSON.stringify({ workId, stopped, idleMark, stored, resumed, ahead });
    // a resume rounds *back* to the top of the sentence; it never starts ahead
    if (ahead > 0) throw new Error(`esc then space started ${ahead} characters ahead: ${shakyo}`);
    // and it rounds back inside the paragraph it stopped in, not to an earlier one
    if (resumed.chunk !== stopped.chunk) {
      throw new Error(`esc then space left the paragraph it stopped in: ${shakyo}`);
    }
    // esc's landing is where space then starts: one is the other
    if (idleMark.chars !== resumed.chars) throw new Error(`space moved off the idle place: ${shakyo}`);
    if (stored.chars > stopped.chars) throw new Error(`a hidden tab moved the place: ${shakyo}`);
  }

  // Music, dead last: every pass above bleeds its settings into the next one,
  // and this is the pass that turns audio on.
  //
  // It has to be turned on by clicking the button, not by an applySettings from
  // an evaluate. HTMLMediaElement.play() has an autoplay policy of its own and
  // refuses outside a gesture — even here, where a hundred real keypresses have
  // long since left the AudioContext running. So a context that is running is
  // not proof the music can start, and this is the only pass in the file that
  // has to go through the UI to mean anything.
  // Settings are not the only thing the passes above bleed: the 写経 pass fakes
  // a hidden tab and never puts it back, and the music deliberately pauses in
  // one. Undo that first or nothing below can start.
  const setVisibility = (state) =>
    page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { value, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  await setVisibility('visible');

  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape'); // whatever the kana pass left running
    await wait(700); // past SUMMARY_GUARD_MS, which kills the second Escape
  }
  await page.keyboard.press('s');
  await wait(400);
  const musicRow = page.locator('.setting').filter({ hasText: 'background music' });
  if ((await musicRow.count()) !== 1) throw new Error('music: no settings row');
  await musicRow.scrollIntoViewIfNeeded();
  await wait(250);
  // before the click, not after: picking a setting rebuilds the panel from
  // scratch and that puts the scroller back to the top
  await shot('26-music-setting');
  await musicRow.locator('.seg button').first().click(); // [on, off]
  await wait(400);
  await page.keyboard.press('Escape');
  await wait(2200);
  const playing = await page.evaluate(() => window.__glide.audio());
  const say = (what, state) => new Error('music: ' + what + ' ' + JSON.stringify(state));
  if (playing.ctx !== 'running') throw say('the context is', playing);
  if (playing.paused[playing.front]) throw say('the front deck never played', playing);
  if (playing.ready < 3) throw say('never buffered', playing);
  if (!(playing.at > 0.5)) throw say('the front deck did not advance', playing);

  // A hidden tab pauses it outright — that is what keeps the loop scheduler out
  // of a background tab — and coming back ramps it in rather than slapping.
  await setVisibility('hidden');
  await wait(400);
  const away = await page.evaluate(() => window.__glide.audio());
  if (away.paused.some((p) => !p)) throw say('a hidden tab did not pause it', away);
  await setVisibility('visible');
  await wait(1600);
  const back = await page.evaluate(() => window.__glide.audio());
  if (back.paused[back.front]) throw say('coming back did not resume it', back);
  if (!(back.level > 0.1)) throw say('coming back did not ramp the level', back);

  // The real seam is 379 seconds in, so jump to it. Reading the deck gains half
  // a fade later is the only observation anywhere that proves the crossfade
  // crossfades — and that it holds the level flat while it does.
  if (!(await page.evaluate(() => window.__glide.loopNow()))) throw say('could not reach the seam', playing);
  await wait(3000);
  const seam = await page.evaluate(() => window.__glide.audio());
  const power = seam.gains[0] * seam.gains[0] + seam.gains[1] * seam.gains[1];
  if (!(seam.gains[0] > 0.01 && seam.gains[1] > 0.01)) throw say('the seam is a cut, not a fade', seam);
  if (Math.abs(power - 1) > 0.05) throw say('the seam is not equal-power', { power, ...seam });

  await wait(4000);
  const looped = await page.evaluate(() => window.__glide.audio());
  const parked = looped.front === 0 ? 1 : 0;
  if (looped.front === playing.front) throw say('the decks never swapped', looped);
  if (looped.paused[looped.front]) throw say('nothing is playing past the seam', looped);
  // an idle deck is always paused at 0, or the next swap has to wait on a seek
  if (!looped.paused[parked]) throw say('the outgoing deck was never parked', looped);

  await page.evaluate(() => window.__glide.applySettings({ music: false }));
  await wait(1800);
  const silent = await page.evaluate(() => window.__glide.audio());
  if (silent.paused.some((p) => !p)) throw say('still playing after off', silent);

  console.log('music  :', JSON.stringify({ playing, power, seam: seam.gains, looped, silent }));
  console.log('advance:', JSON.stringify({ beforeMiss, afterMiss }));
  console.log('timer  :', JSON.stringify(expired));
  console.log('summary:', JSON.stringify({ insideGuard, afterGuard, afterEscape }));
  console.log('shakyo :', shakyo);
  console.log('typed:', typed.join(''));
  console.log('mid  :', JSON.stringify(mid));
  console.log('end  :', JSON.stringify(end));
  console.log('console errors:', errors.length ? errors : 'none');

  await browser.close();
  if (errors.length) process.exitCode = 1;
}

main();
