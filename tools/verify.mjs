/* End-to-end checks: audio scheduling, transport, storage, theme, and the
 * things only a real browser can prove. Pure timeline/format/config logic is
 * unit-tested far faster in tools/core.test.mjs — keep it there.
 *
 *   npm run test:e2e            # boots its own server
 *   node tools/verify.mjs URL   # or point it at one you are already running
 *
 * Requires playwright (a global install is fine). */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from './serve.mjs';

const require_ = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require_('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let server = null;
let BASE = process.argv[2];
if (!BASE) {
  server = await startServer(root);
  BASE = server.url + '/index.html';
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  (cond ? pass++ : fail++);
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  → ' + extra));
};

/* record every scheduled oscillator + every spoken line */
const INSTRUMENT = () => {
  window.__osc = []; window.__said = [];
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const start = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () {
      const o = start.call(this);
      const s = o.start.bind(o);
      o.start = (t) => { window.__osc.push({ t, f: o.frequency.value }); return s(t); };
      return o;
    };
    window.AudioContext = function (opts) { return (window.__ac = new AC(opts)); };
    window.AudioContext.prototype = AC.prototype;
    window.webkitAudioContext = window.AudioContext;
  }
  const U = window.SpeechSynthesisUtterance;
  if (U) window.SpeechSynthesisUtterance = function (txt) {
    window.__said.push({ t: performance.now() / 1000, text: txt });
    return new U(txt);
  };
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.addInitScript(INSTRUMENT);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__PLANK__);

const reload = async () => {
  await page.waitForTimeout(300);            // let the save debounce flush
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__PLANK__);
};
// let any pending save debounce land first, or the app overwrites what we store
const store = async (cfg) => {
  await page.waitForTimeout(350);
  await page.evaluate((c) => localStorage.setItem('plankmatrix.v1', JSON.stringify(c)), cfg);
};
const said = () => page.evaluate(() => window.__said.map((s) => s.text));
const clearSaid = () => page.evaluate(() => { window.__said.length = 0; });

/* ── 1. the module loads and the browser agrees with the unit expectations ── */
console.log('\ncue timeline — 2:00 front / 0:30 side L / 0:30 side R / 1:00 back, 10s lead-in');
const cues = await page.evaluate(() => {
  const P = window.__PLANK__;
  const tl = P.buildTimeline({
    items: [{ name: 'Front plank', dur: 120 }, { name: 'Side plank left', dur: 30 },
            { name: 'Side plank right', dur: 30 }, { name: 'Back plank', dur: 60 }],
    rounds: 1, rest: 0, prep: 10
  });
  return { total: tl.total, cues: P.buildCues(tl).map((c) => [c.t, c.tone, c.say, c.rank]) };
});
for (const [t, tone, say] of cues.cues) console.log(`  ${String(t).padStart(4)}s  ${tone.padEnd(7)} “${say}”`);

const at = (t) => cues.cues.filter((c) => c[0] === t);
ok('the ES module core loads in the browser', cues.total === 250, cues.total);
ok('opening line is just the first hold name', at(0)[0]?.[2] === 'Front plank', at(0)[0]?.[2]);
ok('lead-in counts a full 5·4·3·2·1', [5, 6, 7, 8, 9].every((n) => at(n).some((c) => c[1] === 'tick')));
ok('“Begin” at 0:10', at(10).some((c) => c[2] === 'Begin'));
ok('switch → side plank left at 2:10', at(130).some((c) => c[2] === 'Switch. Side plank left'));
ok('finish chime at 4:10', at(250).some((c) => c[1] === 'finish'));
ok('cues carry a rank for the cue-level filter',
   cues.cues.every((c) => c[3] === 'edge' || c[3] === 'num'));
ok('no two cues collide on the same second',
   new Set(cues.cues.map((c) => c[0])).size === cues.cues.length);

/* ── 2. a cue pre-empts speech that is still playing ── */
const preempt = await page.evaluate(() => {
  let cancels = 0;
  const real = speechSynthesis.cancel.bind(speechSynthesis);
  speechSynthesis.cancel = () => { cancels++; real(); };
  Object.defineProperty(speechSynthesis, 'pending', { get: () => true, configurable: true });
  window.__PLANK__.speak('four');
  const busy = cancels;
  Object.defineProperty(speechSynthesis, 'pending', { get: () => false, configurable: true });
  Object.defineProperty(speechSynthesis, 'speaking', { get: () => false, configurable: true });
  window.__PLANK__.speak('three');
  speechSynthesis.cancel = real;
  return { busy, idle: cancels - busy };
});
ok('a new cue cancels speech still in flight', preempt.busy === 1, JSON.stringify(preempt));
ok('nothing is cancelled when the voice is idle', preempt.idle === 0, JSON.stringify(preempt));

/* ── 3. live run: audio really gets scheduled ahead of time ── */
await page.evaluate(() => {
  document.querySelectorAll('#rows .row input[data-k=dur]').forEach((i) => {
    i.value = '0:08'; i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const e = document.getElementById('prep');
  e.value = '0:10'; e.dispatchEvent(new Event('change', { bubbles: true }));
  window.__said.length = 0;
});
await page.click('#start');
await page.waitForTimeout(1500);
const sched = await page.evaluate(() => ({ osc: window.__osc.length, said: window.__said.slice() }));
ok('cues are pre-scheduled on the audio clock', sched.osc >= 20, 'oscillators=' + sched.osc);
ok('first line is the opening hold name', sched.said[0]?.text === 'Front plank', JSON.stringify(sched.said));

/* ── 3a. the countdown lands on its seconds ── */
await page.waitForTimeout(9500);          // sit through the whole 10s lead-in
const count = await page.evaluate(() => {
  const t0 = window.__PLANK__.R.startT;
  return ['5', '4', '3', '2', '1'].map((n, i) => {
    const hit = window.__said.find((s) => s.text === n);
    return { n, want: 5 + i, got: hit ? +(hit.t - t0).toFixed(2) : null };
  });
});
console.log('  countdown → ' + count.map((c) => `${c.n}@${c.got}s`).join('  '));
ok('all five numbers were spoken', count.every((c) => c.got !== null), JSON.stringify(count));
ok('each number lands on its own second (±0.35s)',
   count.every((c) => c.got !== null && Math.abs(c.got - c.want) < 0.35), JSON.stringify(count));
ok('the numbers are ~1s apart, not compressed',
   count.slice(1).every((c, i) => Math.abs((c.got - count[i].got) - 1) < 0.3), JSON.stringify(count));

// pause freezes, resume continues
const before = await page.textContent('#clock');
await page.click('#pause');
await page.waitForTimeout(1200);
ok('pause freezes the clock', (await page.textContent('#clock')) === before);
await page.click('#pause');
await page.waitForTimeout(1200);
ok('resume advances the clock', (await page.textContent('#clock')) !== before);

// skip / prev — we are ~12s in, i.e. inside the first hold
await page.click('#next');
await page.waitForTimeout(300);
ok('skip jumps to the next hold', (await page.textContent('#nowOut')) === 'Side plank left',
   await page.textContent('#nowOut'));
await page.click('#next');
await page.waitForTimeout(300);
ok('skip again advances', (await page.textContent('#nowOut')) === 'Side plank right',
   await page.textContent('#nowOut'));
await page.click('#prev');
await page.waitForTimeout(300);
ok('prev goes back', (await page.textContent('#nowOut')) === 'Side plank left',
   await page.textContent('#nowOut'));
ok('the current hold is announced to screen readers',
   /Side plank left/.test(await page.textContent('#sr')), await page.textContent('#sr'));

/* ── 3b. the screen-lock scenario: audio context suspended mid-session ── */
const lock = await page.evaluate(async () => {
  const R = window.__PLANK__.R;
  const before = { elapsed: R.paused ? R.frozen : performance.now() / 1000 - R.startT,
                   said: window.__said.length, osc: window.__osc.length };
  // hold the context down: the app resumes it on sight, so stub resume out
  const realResume = window.__ac.resume.bind(window.__ac);
  window.__ac.resume = () => Promise.resolve();
  await realResume().then(() => window.__ac.suspend());   // what a locked screen does to us
  await new Promise((r) => setTimeout(r, 4000));
  const during = { ctxTime: window.__ac.currentTime, state: window.__ac.state,
                   elapsed: performance.now() / 1000 - R.startT,
                   osc: window.__osc.length };
  window.__ac.resume = realResume;
  await realResume();
  await new Promise((r) => setTimeout(r, 1500));
  return { before, during,
           after: { elapsed: performance.now() / 1000 - R.startT,
                    said: window.__said.length, osc: window.__osc.length },
           running: R.running };
});
ok('audio context really was suspended', lock.during.state === 'suspended', lock.during.state);
ok('elapsed keeps advancing while the audio context is suspended',
   lock.during.elapsed - lock.before.elapsed >= 3.5, JSON.stringify(lock));
ok('no graph churn while suspended', lock.during.osc === lock.before.osc,
   JSON.stringify({ b: lock.before.osc, d: lock.during.osc }));
ok('session still running after resume', lock.running);
ok('no cue flood on wake (≤ 3 lines spoken)', lock.after.said - lock.before.said <= 3,
   'spoke ' + (lock.after.said - lock.before.said));
ok('rescheduling resumes after wake', lock.after.osc > lock.during.osc,
   JSON.stringify({ d: lock.during.osc, a: lock.after.osc }));
ok('clock is in sync with wall time after wake',
   Math.abs((lock.after.elapsed) - (lock.during.elapsed + 1.5)) < 0.6, JSON.stringify(lock));

// run to completion
await page.waitForTimeout(33000);
ok('session ends and returns to setup', await page.isVisible('#setup') && !(await page.isVisible('#run')));
const finished = await said();
ok('spoke the closing line', finished.some((s) => /Session complete/.test(s)), finished.slice(-4).join(' | '));
ok('counted 5·4·3·2·1 aloud', ['5', '4', '3', '2', '1'].every((n) => finished.includes(n)));

/* ── 4. persistence ── */
await reload();
ok('routine survives a reload', (await page.inputValue('#rows .row input[data-k=dur]')) === '0:08',
   await page.inputValue('#rows .row input[data-k=dur]'));

/* ── 5. stored-config migration and hardening ── */
const prepAfterReload = async (patch) => {
  await store(Object.assign({ items: [{ name: 'Front plank', dur: 120 }], rounds: 1, rest: 0, prep: 5 }, patch));
  await reload();
  return page.inputValue('#prep');
};
ok('an old 5s lead-in is raised to 10s once', (await prepAfterReload({})) === '0:10');
ok('a deliberate 5s lead-in is left alone', (await prepAfterReload({ prep: 5, v: 2 })) === '0:05');
ok('a custom lead-in is not touched by the migration', (await prepAfterReload({ prep: 20 })) === '0:20');
ok('a disabled lead-in stays disabled', (await prepAfterReload({ prep: 0 })) === '0:00');

await store({ v: 2, prep: 0, rounds: 1, rest: 0, voice: false,
              items: Array.from({ length: 500 }, (_, i) => ({ name: 'H' + i, dur: 60 })) });
await reload();
ok('a corrupt/huge stored routine is capped, not rendered whole',
   (await page.locator('#rows .row').count()) === 40, await page.locator('#rows .row').count());
ok('the old voice=false toggle migrates to beeps-only',
   (await page.textContent('#cueToggle')) === 'Cues ▸ beeps only', await page.textContent('#cueToggle'));

/* ── 6. theme: system / dark / light ── */
const theme = () => page.getAttribute('html', 'data-theme');
const themeMeta = () => page.getAttribute('#tc', 'content');
const pressed = () => page.$$eval('.seg button[data-theme]',
  (bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.theme));
// media emulation lands in the renderer asynchronously
const emulate = async (colorScheme) => {
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(150);
};

await emulate('light');
await page.evaluate(() => localStorage.removeItem('plankmatrix.theme'));
await reload();
ok('defaults to following the system', (await theme()) === 'light' &&
   JSON.stringify(await pressed()) === '["system"]', (await theme()) + ' ' + (await pressed()));
await emulate('dark');
ok('follows the system switching to dark live', (await theme()) === 'dark', await theme());

await page.click('.seg button[data-theme=light]');
ok('forcing light overrides a dark system', (await theme()) === 'light', await theme());
ok('the forced mode is the pressed one', JSON.stringify(await pressed()) === '["light"]', await pressed());
ok('the status-bar colour follows the theme', (await themeMeta()) === '#dcece0', await themeMeta());
await emulate('light');
await emulate('dark');
ok('a forced theme ignores system changes', (await theme()) === 'light', await theme());
await reload();
ok('a forced theme survives a reload', (await theme()) === 'light' &&
   JSON.stringify(await pressed()) === '["light"]', (await theme()) + ' ' + (await pressed()));

await page.click('.seg button[data-theme=dark]');
ok('forcing dark works against a light system', (await theme()) === 'dark' &&
   (await themeMeta()) === '#000000');
await page.click('.seg button[data-theme=system]');
ok('back to system resumes tracking', (await theme()) === 'dark', await theme());
ok('system mode clears the stored override',
   (await page.evaluate(() => localStorage.getItem('plankmatrix.theme'))) === null);
await emulate('light');
await reload();
ok('system mode survives a reload', (await theme()) === 'light' &&
   JSON.stringify(await pressed()) === '["system"]', (await theme()) + ' ' + (await pressed()));

/* ── 7. the hold picker ── */
const HOLDS = ['Front plank', 'Side plank right', 'Side plank left', 'Back plank'];
const row = (n, sel) => `#rows .row:nth-child(${n}) ${sel}`;
const names = () => page.evaluate(() =>
  window.__PLANK__.buildTimeline(window.__PLANK__.cfg).segs.map((s) => s.name));

await store({ v: 3, prep: 0, rounds: 1, rest: 0,
              items: [{ name: 'Front plank', dur: 120 }, { name: 'Bird dog', dur: 30 }] });
await reload();

const opts = await page.$$eval(row(1, 'select') + ' option', (os) => os.map((o) => o.textContent));
ok('the picker lists the four holds plus Custom',
   JSON.stringify(opts) === JSON.stringify(HOLDS.concat(['Custom…'])), JSON.stringify(opts));
ok('a listed hold shows as its option', (await page.inputValue(row(1, 'select'))) === 'Front plank');
ok('a listed hold has no free-text field', (await page.locator(row(1, 'input[data-k=name]')).count()) === 0);
ok('an off-list name loads as Custom', (await page.inputValue(row(2, 'select'))) === '__custom');
ok('…with the name kept in the text field',
   (await page.inputValue(row(2, 'input[data-k=name]'))) === 'Bird dog');

await page.selectOption(row(1, 'select'), '__custom');
ok('choosing Custom reveals an empty name field',
   (await page.locator(row(1, 'input[data-k=name]')).count()) === 1 &&
   (await page.inputValue(row(1, 'input[data-k=name]'))) === '');
await page.fill(row(1, 'input[data-k=name]'), 'Copenhagen plank');
ok('a custom name reaches the timeline as you type',
   (await names())[0] === 'Copenhagen plank', JSON.stringify(await names()));

await page.selectOption(row(2, 'select'), 'Back plank');
ok('choosing a listed hold hides the text field',
   (await page.locator(row(2, 'input[data-k=name]')).count()) === 0);
ok('…and renames the hold', (await names())[1] === 'Back plank', JSON.stringify(await names()));

await reload();
ok('a custom hold survives a reload', (await page.inputValue(row(1, 'select'))) === '__custom' &&
   (await page.inputValue(row(1, 'input[data-k=name]'))) === 'Copenhagen plank');
await page.fill(row(1, 'input[data-k=name]'), '   ');
await page.dispatchEvent(row(1, 'input[data-k=name]'), 'change');
ok('a blank custom name falls back to a label',
   (await page.inputValue(row(1, 'input[data-k=name]'))) === 'Custom hold', await names());

// the preset picker still round-trips through the new model
await page.selectOption('#preset', 'classic');
ok('loading a preset fills the pickers, not custom fields',
   (await page.locator('#rows input[data-k=name]').count()) === 0 &&
   (await page.inputValue(row(1, 'select'))) === 'Front plank');
ok('preset holds all map onto listed options',
   (await names()).every((n) => HOLDS.indexOf(n) >= 0), JSON.stringify(await names()));

// a custom name still focused must not leak into whatever replaces that row
await page.selectOption(row(1, 'select'), '__custom');
await page.fill(row(1, 'input[data-k=name]'), 'Scratch name');   // field stays focused
await page.selectOption('#preset', 'starter');
ok('an unblurred custom name cannot leak into a loaded preset',
   (await names())[0] === 'Front plank', JSON.stringify(await names()));
await page.selectOption(row(2, 'select'), '__custom');
await page.fill(row(2, 'input[data-k=name]'), 'Hollow hold');
await page.selectOption(row(2, 'select'), 'Back plank');         // switch away while focused
ok('an unblurred custom name cannot leak into a listed hold',
   (await names())[1] === 'Back plank', JSON.stringify(await names()));

/* ── 8. reordering and duplicating holds ── */
await store({ v: 3, prep: 0, rounds: 1, rest: 0,
              items: [{ name: 'Front plank', dur: 30 }, { name: 'Side plank left', dur: 40 },
                      { name: 'Back plank', dur: 50 }] });
await reload();
const durs = () => page.evaluate(() =>
  window.__PLANK__.buildTimeline(window.__PLANK__.cfg).segs.map((s) => s.dur));

ok('the first row cannot move up', await page.isDisabled(row(1, 'button[data-mv="-1"]')));
ok('the last row cannot move down', await page.isDisabled(row(3, 'button[data-mv="1"]')));
ok('middle rows can move both ways',
   !(await page.isDisabled(row(2, 'button[data-mv="-1"]'))) &&
   !(await page.isDisabled(row(2, 'button[data-mv="1"]'))));

await page.click(row(3, 'button[data-mv="-1"]'));
ok('moving a hold up reorders the routine',
   JSON.stringify(await names()) === JSON.stringify(['Front plank', 'Back plank', 'Side plank left']),
   JSON.stringify(await names()));
ok('…and carries its duration with it',
   JSON.stringify(await durs()) === JSON.stringify([30, 50, 40]), JSON.stringify(await durs()));
ok('focus follows the moved hold, so it can be walked up the list',
   (await page.evaluate(() => document.activeElement?.dataset.mv)) === '-1');

await page.click(row(1, 'button[data-mv="1"]'));
ok('moving a hold down reorders the routine',
   JSON.stringify(await names()) === JSON.stringify(['Back plank', 'Front plank', 'Side plank left']),
   JSON.stringify(await names()));

await page.click(row(2, 'button[data-dup]'));
ok('duplicating inserts a copy right after the original',
   JSON.stringify(await names()) ===
   JSON.stringify(['Back plank', 'Front plank', 'Front plank', 'Side plank left']),
   JSON.stringify(await names()));
ok('…with the same duration', JSON.stringify(await durs()) === JSON.stringify([50, 30, 30, 40]),
   JSON.stringify(await durs()));
ok('the total picks up the duplicate', (await page.textContent('#totalOut')) === 'total 2:30',
   await page.textContent('#totalOut'));

await reload();
ok('a reordered, duplicated routine survives a reload',
   JSON.stringify(await names()) ===
   JSON.stringify(['Back plank', 'Front plank', 'Front plank', 'Side plank left']),
   JSON.stringify(await names()));

await page.click(row(1, 'button[data-x]'));
ok('removing still works alongside the new controls',
   JSON.stringify(await names()) ===
   JSON.stringify(['Front plank', 'Front plank', 'Side plank left']), JSON.stringify(await names()));

/* ── 9. cue levels ── */
const cueLabel = () => page.textContent('#cueToggle');
await store({ v: 3, prep: 0, rounds: 1, rest: 0, cues: 'full',
              items: [{ name: 'Front plank', dur: 8 }] });
await reload();
ok('the cue toggle starts on full', (await cueLabel()) === 'Cues ▸ full', await cueLabel());
await page.click('#cueToggle');
ok('clicking cycles to minimal', (await cueLabel()) === 'Cues ▸ minimal', await cueLabel());

await clearSaid();
await page.click('#start');
await page.waitForTimeout(9500);
const minimal = await said();
ok('minimal keeps the lines that say what to do next',
   minimal.includes('Front plank') && minimal.some((s) => /Session complete/.test(s)),
   JSON.stringify(minimal));
ok('minimal speaks none of the countdown',
   !minimal.some((s) => /^[0-9]$/.test(s) || /seconds|remaining/.test(s)), JSON.stringify(minimal));
ok('minimal still returns to setup on its own', await page.isVisible('#setup'));

await page.click('#cueToggle');
ok('clicking again cycles to beeps only', (await cueLabel()) === 'Cues ▸ beeps only', await cueLabel());
await clearSaid();
const oscBefore = await page.evaluate(() => window.__osc.length);
await page.click('#start');
await page.waitForTimeout(9500);
ok('beeps-only speaks nothing at all', (await said()).length === 0, JSON.stringify(await said()));
ok('…but still schedules every beep',
   (await page.evaluate(() => window.__osc.length)) > oscBefore + 5);
await page.click('#cueToggle');
ok('the cycle wraps back to full', (await cueLabel()) === 'Cues ▸ full', await cueLabel());
await reload();
ok('the cue level survives a reload', (await cueLabel()) === 'Cues ▸ full', await cueLabel());

/* ── 10. live ±15s on the hold you are in ── */
await store({ v: 3, prep: 0, rounds: 1, rest: 0, cues: 'beeps',
              items: [{ name: 'Front plank', dur: 120 }] });
await reload();
const segDur = () => page.evaluate(() => window.__PLANK__.R.tl.segs[0].dur);
await page.click('#start');
await page.waitForTimeout(2000);

const clockBefore = await page.textContent('#clock');
await page.click('#plus');
await page.waitForTimeout(150);
ok('+15s lengthens the hold you are in', (await segDur()) === 135, await segDur());
ok('…and the clock shows the extra time', (await page.textContent('#clock')) !== clockBefore,
   (await page.textContent('#clock')) + ' vs ' + clockBefore);
ok('…and it is announced', /now 2:15/.test(await page.textContent('#sr')), await page.textContent('#sr'));
ok('the total bar rescales to the new length',
   (await page.evaluate(() => window.__PLANK__.R.tl.total)) === 135);

await page.click('#minus');
await page.click('#minus');
await page.waitForTimeout(150);
ok('−15s shortens it again', (await segDur()) === 105, await segDur());

ok('the session is still running after adjusting', await page.isVisible('#run'));
const rescheduled = await page.evaluate(() => {
  const last = window.__PLANK__.R.cues.at(-1);
  return { t: last.t, tone: last.tone, total: window.__PLANK__.R.tl.total };
});
ok('the cue schedule is rebuilt around the new length',
   rescheduled.tone === 'finish' && rescheduled.t === 105 && rescheduled.total === 105,
   JSON.stringify(rescheduled));

// the floor is checked while paused, so the playhead cannot race the assertion
await page.click('#pause');
for (let i = 0; i < 20; i++) await page.click('#minus');
const floor = await page.evaluate(() => ({
  dur: window.__PLANK__.R.tl.segs[0].dur,
  frozen: window.__PLANK__.R.frozen
}));
ok('shrinking always leaves at least a second on the clock',
   floor.dur >= Math.ceil(floor.frozen) + 1 && floor.dur <= Math.ceil(floor.frozen) + 2,
   JSON.stringify(floor));
ok('the clock never goes negative', /^0:0[1-9]$/.test(await page.textContent('#clock')),
   await page.textContent('#clock'));
await page.click('#stop');
ok('end session returns to setup', await page.isVisible('#setup'));

/* ── 11. hold to failure ── */
await store({ v: 3, prep: 0, rounds: 1, rest: 0, cues: 'full',
              items: [{ name: 'Front plank', dur: 5, open: true, best: 0 },
                      { name: 'Back plank', dur: 8 }] });
await reload();
ok('an open hold is marked in the editor',
   (await page.getAttribute(row(1, 'button[data-k=open]'), 'aria-pressed')) === 'true');
ok('…and labelled as open-ended', /to failure/.test(await page.textContent(row(1, '.note'))),
   await page.textContent(row(1, '.note')));
ok('the setup total is shown as an estimate', (await page.textContent('#totalOut')) === 'total 0:13+',
   await page.textContent('#totalOut'));

await clearSaid();
await page.click('#start');
await page.waitForTimeout(3000);
ok('an open hold counts up, not down', (await page.textContent('#clock')) === '0:03',
   await page.textContent('#clock'));
ok('the run view says it is open-ended', (await page.textContent('#stepOut')) === 'to failure',
   await page.textContent('#stepOut'));
ok('the skip button becomes ✓ Done', (await page.textContent('#next')) === '✓ Done',
   await page.textContent('#next'));
ok('±15s is disabled during an open hold',
   (await page.isDisabled('#plus')) && (await page.isDisabled('#minus')));

// the target is 5s: the playhead must not roll past it on its own
await page.waitForTimeout(4000);
ok('an open hold does not end when its target elapses',
   (await page.textContent('#nowOut')) === 'Front plank', await page.textContent('#nowOut'));
ok('…it just keeps counting', (await page.textContent('#clock')) === '0:07',
   await page.textContent('#clock'));
ok('the session has not finished behind our back', await page.isVisible('#run'));

await page.click('#next');
await page.waitForTimeout(400);
const measured = await page.evaluate(() => ({
  over: window.__PLANK__.R.over[0],
  best: window.__PLANK__.cfg.items[0].best,
  total: window.__PLANK__.R.tl.total,
  openIdx: window.__PLANK__.R.tl.openIdx,
  now: document.getElementById('nowOut').textContent
}));
ok('✓ Done records what the hold actually lasted', measured.over >= 7 && measured.over <= 9,
   JSON.stringify(measured));
ok('…stores it as the new best', measured.best === measured.over, JSON.stringify(measured));
ok('…and the timeline continues into the next hold', measured.now === 'Back plank',
   JSON.stringify(measured));
ok('the total is re-laid around the measured time', measured.total === measured.over + 8,
   JSON.stringify(measured));
ok('the open wall is gone once measured', measured.openIdx === -1, JSON.stringify(measured));
ok('the result is folded into the line that was going to play anyway',
   (await said()).some((s) => /seconds\. Switch\. Back plank/.test(s)),
   JSON.stringify((await said()).slice(-4)));
ok('±15s is usable again on a normal hold', !(await page.isDisabled('#plus')));

await page.waitForTimeout(9000);
ok('a routine containing an open hold still finishes', await page.isVisible('#setup'));
await reload();
ok('the best hold is remembered across a reload',
   /best 0:0[789]/.test(await page.textContent(row(1, '.note'))), await page.textContent(row(1, '.note')));

await page.click(row(1, 'button[data-k=open]'));
ok('the ∞ toggle turns an open hold back into a fixed one',
   (await page.getAttribute(row(1, 'button[data-k=open]'), 'aria-pressed')) === 'false' &&
   (await page.locator(row(1, '.note')).count()) === 0);
ok('…and the total stops being an estimate', (await page.textContent('#totalOut')) === 'total 0:13',
   await page.textContent('#totalOut'));

/* ── 12. the timer does not depend on Web Audio existing ── */
const bare = await context.newPage();
bare.on('pageerror', (e) => errors.push('[no-audio] ' + e));
await bare.addInitScript(() => { delete window.AudioContext; delete window.webkitAudioContext; });
await bare.addInitScript(INSTRUMENT);
await bare.goto(BASE, { waitUntil: 'load' });
await bare.waitForFunction(() => !!window.__PLANK__);
await bare.evaluate(() => localStorage.setItem('plankmatrix.v1', JSON.stringify({
  v: 3, prep: 0, rounds: 1, rest: 0, cues: 'full', items: [{ name: 'Front plank', dur: 5 }]
})));
await bare.reload({ waitUntil: 'load' });
await bare.waitForFunction(() => !!window.__PLANK__);
await bare.click('#start');
await bare.waitForTimeout(1000);
ok('without Web Audio the session still starts', await bare.isVisible('#run'));
await bare.waitForTimeout(6000);
ok('without Web Audio the session still ends on time', await bare.isVisible('#setup'),
   'clock=' + (await bare.textContent('#clock')));
const bareSaid = await bare.evaluate(() => window.__said.map((s) => s.text));
ok('without Web Audio the spoken cues still fire',
   bareSaid.includes('Front plank') && bareSaid.some((s) => /Session complete/.test(s)),
   JSON.stringify(bareSaid));
await bare.close();

ok('no console/page errors', errors.length === 0, errors.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
if (server) await server.close();
process.exit(fail ? 1 : 0);
