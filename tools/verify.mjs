/* End-to-end checks for the timer: cue timeline, audio scheduling, transport.
 * Usage:  npx http-server -p 8099 -s .   &&   node tools/verify.mjs [baseUrl]
 * Requires playwright to be installed (global install is fine). */
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require_('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const BASE = process.argv[2] || 'http://127.0.0.1:8099/index.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  (cond ? pass++ : fail++);
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  → ' + extra));
};

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 390, height: 844 } }).then(c => c.newPage());
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

// record every scheduled oscillator + every spoken line
await page.addInitScript(() => {
  window.__osc = []; window.__said = [];
  const AC = window.AudioContext || window.webkitAudioContext;
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
  const U = window.SpeechSynthesisUtterance;
  if (U) window.SpeechSynthesisUtterance = function (txt) {
    window.__said.push({ t: performance.now() / 1000, text: txt });
    return new U(txt);
  };
});
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__PLANK__);

/* ── 1. cue timeline for the reference routine ── */
console.log('\ncue timeline — 2:00 front / 0:30 side L / 0:30 side R / 1:00 back, 10s lead-in');
const cues = await page.evaluate(() => {
  const P = window.__PLANK__;
  const cfg = {
    items: [{ name: 'Front plank', dur: 120 }, { name: 'Side plank left', dur: 30 },
            { name: 'Side plank right', dur: 30 }, { name: 'Back plank', dur: 60 }],
    rounds: 1, rest: 0, prep: 10
  };
  const tl = P.buildTimeline(cfg);
  return { total: tl.total, segs: tl.segs.map(s => s.name + '@' + s.at + '+' + s.dur),
           cues: P.buildCues(tl).map(c => [c.t, c.tone, c.say]) };
});
for (const [t, tone, say] of cues.cues) console.log(`  ${String(t).padStart(4)}s  ${tone.padEnd(7)} “${say}”`);

const at = (t) => cues.cues.filter(c => c[0] === t);
ok('total is 10 + 240s', cues.total === 250, cues.total);
ok('opening line is just the first hold name', at(0)[0]?.[2] === 'Front plank', at(0)[0]?.[2]);
ok('no “get ready” anywhere', !cues.cues.some(c => /get ready/i.test(c[2])),
   cues.cues.filter(c => /get ready/i.test(c[2])).map(c => c[2]).join(', '));
ok('lead-in counts a full 5·4·3·2·1', [5, 6, 7, 8, 9].every(n => at(n).some(c => c[1] === 'tick')));
ok('every lead-in tick is 1s apart', [5, 6, 7, 8, 9].every(n => at(n).filter(c => c[1] === 'tick').length === 1));
ok('nothing else is spoken during the count', !cues.cues.some(c => c[0] > 0 && c[0] < 10 && c[1] !== 'tick'));
ok('“Begin” at 0:10', at(10).some(c => c[2] === 'Begin'));
ok('1-minute call inside the 2:00 front plank', at(70).some(c => c[2] === 'One minute remaining'));
ok('no minute call at the start of a hold', !cues.cues.some(c => c[0] === 10 && /minute/.test(c[2])));
ok('30s call in the front plank', at(100).some(c => c[2] === 'Thirty seconds'));
ok('10s call in the front plank', at(120).some(c => c[2] === 'Ten seconds'));
ok('5·4·3·2·1 before the switch', [125, 126, 127, 128, 129].every(t => at(t).some(c => c[1] === 'tick')));
ok('switch → side plank left at 2:10', at(130).some(c => c[1] === 'switch' && c[2] === 'Switch. Side plank left'));
ok('30s hold has no “thirty seconds” call', !cues.cues.some(c => c[0] > 130 && c[0] < 160 && /Thirty/.test(c[2])));
ok('30s hold still gets its 10s call', at(150).some(c => c[2] === 'Ten seconds'));
ok('switch → side plank right at 2:40', at(160).some(c => c[2] === 'Switch. Side plank right'));
ok('switch → back plank at 3:10', at(190).some(c => c[2] === 'Switch. Back plank'));
ok('1:00 hold has no minute call', !cues.cues.some(c => c[0] > 190 && c[0] < 250 && /minute/.test(c[2])));
ok('finish chime at 4:10', at(250).some(c => c[1] === 'finish'));
ok('cues are sorted', cues.cues.every((c, i) => i === 0 || c[0] >= cues.cues[i - 1][0]));
ok('no two cues collide on the same second', new Set(cues.cues.map(c => c[0])).size === cues.cues.length);

/* ── 2. rounds + rest ── */
const r2 = await page.evaluate(() => {
  const P = window.__PLANK__;
  const tl = P.buildTimeline({ items: [{ name: 'A', dur: 20 }, { name: 'B', dur: 20 }],
                               rounds: 2, rest: 10, prep: 0 });
  return { total: tl.total, segs: tl.segs.map(s => s.type + ':' + s.name) };
});
ok('rounds×rest total = 20+10+20+10+20+10+20', r2.total === 110, r2.total);
ok('no trailing rest after the last hold', r2.segs[r2.segs.length - 1] === 'work:B', r2.segs.join(','));

/* ── 3. duration parsing ── */
const p = await page.evaluate(() => {
  const P = window.__PLANK__;
  return ['2:00', '0:30', '90', '1:5', '', 'abc', '99:99'].map(s => P.parseDur(s, -1));
});
ok('parseDur handles mm:ss / bare seconds / junk', JSON.stringify(p) === JSON.stringify([120, 30, 90, 65, -1, -1, 3600]), JSON.stringify(p));

/* ── 3b. a cue pre-empts speech that is still playing ── */
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

/* ── 4. live run: audio really gets scheduled ahead of time ── */
await page.evaluate(() => {
  document.querySelectorAll('#rows .row input[data-k=dur]').forEach(i => {
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

/* ── 4a. the countdown lands on its seconds ── */
await page.waitForTimeout(9500);          // sit through the whole 10s lead-in
const count = await page.evaluate(() => {
  const t0 = window.__PLANK__.R.startT;
  return ['5', '4', '3', '2', '1'].map((n, i) => {
    const hit = window.__said.find(s => s.text === n);
    return { n, want: 5 + i, got: hit ? +(hit.t - t0).toFixed(2) : null };
  });
});
console.log('  countdown → ' + count.map(c => `${c.n}@${c.got}s`).join('  '));
ok('all five numbers were spoken', count.every(c => c.got !== null), JSON.stringify(count));
ok('each number lands on its own second (±0.35s)',
   count.every(c => c.got !== null && Math.abs(c.got - c.want) < 0.35), JSON.stringify(count));
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

// skip / prev
// we are ~12s in, i.e. inside the first hold
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

/* ── 4b. the screen-lock scenario: audio context suspended mid-session ── */
const lock = await page.evaluate(async () => {
  const R = window.__PLANK__.R;
  const before = { elapsed: R.paused ? R.frozen : performance.now() / 1000 - R.startT,
                   said: window.__said.length, osc: window.__osc.length };
  // hold the context down: the app resumes it on sight, so stub resume out
  const realResume = window.__ac.resume.bind(window.__ac);
  window.__ac.resume = () => Promise.resolve();
  await realResume().then(() => window.__ac.suspend());   // what a locked screen does to us
  await new Promise(r => setTimeout(r, 4000));
  const during = { ctxTime: window.__ac.currentTime, state: window.__ac.state,
                   elapsed: performance.now() / 1000 - R.startT,
                   osc: window.__osc.length };
  window.__ac.resume = realResume;
  await realResume();
  await new Promise(r => setTimeout(r, 1500));
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
const said = await page.evaluate(() => window.__said.map(s => s.text));
ok('spoke the closing line', said.some(s => /Session complete/.test(s)), said.slice(-4).join(' | '));
ok('counted 5·4·3·2·1 aloud', ['5', '4', '3', '2', '1'].every(n => said.includes(n)));

/* ── 5. persistence ── */
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__PLANK__);
ok('routine survives a reload', (await page.inputValue('#rows .row input[data-k=dur]')) === '0:08',
   await page.inputValue('#rows .row input[data-k=dur]'));

/* ── 6. one-time migration of the old short lead-in ── */
const stored = (patch) => page.evaluate((p) => {
  localStorage.setItem('plankmatrix.v1', JSON.stringify(Object.assign({
    items: [{ name: 'Front plank', dur: 120 }], rounds: 1, rest: 0, prep: 5
  }, p)));
}, patch);
const prepAfterReload = async () => {
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__PLANK__);
  return page.inputValue('#prep');
};
await stored({});                              // v1 data, 5s lead-in
ok('an old 5s lead-in is raised to 10s once', (await prepAfterReload()) === '0:10');
await stored({ prep: 5, v: 2 });               // already migrated, user chose 5s
ok('a deliberate 5s lead-in is left alone', (await prepAfterReload()) === '0:05');
await stored({ prep: 20 });                    // v1 data, but a custom lead-in
ok('a custom lead-in is not touched by the migration', (await prepAfterReload()) === '0:20');
await stored({ prep: 0 });                     // v1 data, lead-in switched off
ok('a disabled lead-in stays disabled', (await prepAfterReload()) === '0:00');

/* ── 7. theme: system / dark / light ── */
const theme = () => page.getAttribute('html', 'data-theme');
const themeMeta = () => page.getAttribute('#tc', 'content');
const pressed = () => page.$$eval('.seg button[data-theme]',
  bs => bs.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.theme));
const reload = async () => {
  await page.waitForTimeout(300);            // let the save debounce flush
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__PLANK__);
};
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

/* ── 8. the hold picker ── */
const HOLDS = ['Front plank', 'Side plank right', 'Side plank left', 'Back plank'];
const row = (n, sel) => `#rows .row:nth-child(${n}) ${sel}`;
const names = () => page.evaluate(() =>
  window.__PLANK__.buildTimeline(window.__PLANK__.cfg).segs.map(s => s.name));

await page.evaluate(() => localStorage.setItem('plankmatrix.v1', JSON.stringify({
  v: 2, prep: 0, rounds: 1, rest: 0,
  items: [{ name: 'Front plank', dur: 120 }, { name: 'Bird dog', dur: 30 }]   // no custom flag
})));
await reload();

const opts = await page.$$eval(row(1, 'select') + ' option', os => os.map(o => o.textContent));
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
   (await names()).every(n => HOLDS.indexOf(n) >= 0), JSON.stringify(await names()));

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

ok('no console/page errors', errors.length === 0, errors.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
