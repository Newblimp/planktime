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
  if (U) window.SpeechSynthesisUtterance = function (txt) { window.__said.push(txt); return new U(txt); };
});
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__PLANK__);

/* ── 1. cue timeline for the reference routine ── */
console.log('\ncue timeline — 2:00 front / 0:30 side L / 0:30 side R / 1:00 back, 5s lead-in');
const cues = await page.evaluate(() => {
  const P = window.__PLANK__;
  const cfg = {
    items: [{ name: 'Front plank', dur: 120 }, { name: 'Side plank left', dur: 30 },
            { name: 'Side plank right', dur: 30 }, { name: 'Back plank', dur: 60 }],
    rounds: 1, rest: 0, prep: 5
  };
  const tl = P.buildTimeline(cfg);
  return { total: tl.total, segs: tl.segs.map(s => s.name + '@' + s.at + '+' + s.dur),
           cues: P.buildCues(tl).map(c => [c.t, c.tone, c.say]) };
});
for (const [t, tone, say] of cues.cues) console.log(`  ${String(t).padStart(4)}s  ${tone.padEnd(7)} “${say}”`);

const at = (t) => cues.cues.filter(c => c[0] === t);
ok('total is 5 + 240s', cues.total === 245, cues.total);
ok('lead-in announces first hold', /Get ready\. First up, Front plank/.test(at(0)[0]?.[2]));
ok('lead-in counts 4·3·2·1', [1, 2, 3, 4].every(n => at(n).some(c => c[1] === 'tick')));
ok('“Begin” at 0:05', at(5).some(c => c[2] === 'Begin. Front plank'));
ok('1-minute call inside the 2:00 front plank', at(65).some(c => c[2] === 'One minute remaining'));
ok('no minute call at the start of a hold', !cues.cues.some(c => c[0] === 5 && /minute/.test(c[2])));
ok('30s call in the front plank', at(95).some(c => c[2] === 'Thirty seconds'));
ok('10s call in the front plank', at(115).some(c => c[2] === 'Ten seconds'));
ok('5·4·3·2·1 before the switch', [120, 121, 122, 123, 124].every(t => at(t).some(c => c[1] === 'tick')));
ok('switch → side plank left at 2:05', at(125).some(c => c[1] === 'switch' && c[2] === 'Switch. Side plank left'));
ok('30s hold has no “thirty seconds” call', !cues.cues.some(c => c[0] > 125 && c[0] < 155 && /Thirty/.test(c[2])));
ok('30s hold still gets its 10s call', at(145).some(c => c[2] === 'Ten seconds'));
ok('switch → side plank right at 2:35', at(155).some(c => c[2] === 'Switch. Side plank right'));
ok('switch → back plank at 3:05', at(185).some(c => c[2] === 'Switch. Back plank'));
ok('1:00 hold has no minute call', !cues.cues.some(c => c[0] > 185 && c[0] < 245 && /minute/.test(c[2])));
ok('finish chime at 4:05', at(245).some(c => c[1] === 'finish'));
ok('cues are sorted', cues.cues.every((c, i) => i === 0 || c[0] >= cues.cues[i - 1][0]));

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

/* ── 4. live run: audio really gets scheduled ahead of time ── */
await page.evaluate(() => {
  document.querySelectorAll('#rows .row input[data-k=dur]').forEach(i => {
    i.value = '0:08'; i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  ['prep'].forEach(id => {
    const e = document.getElementById(id); e.value = '0:05';
    e.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
await page.click('#start');
await page.waitForTimeout(1500);
const sched = await page.evaluate(() => ({ osc: window.__osc.length, said: window.__said.slice() }));
ok('cues are pre-scheduled on the audio clock', sched.osc >= 20, 'oscillators=' + sched.osc);
ok('first line is spoken at t=0', /Get ready/.test(sched.said[0] || ''), JSON.stringify(sched.said));

// pause freezes, resume continues
const before = await page.textContent('#clock');
await page.click('#pause');
await page.waitForTimeout(1200);
ok('pause freezes the clock', (await page.textContent('#clock')) === before);
await page.click('#pause');
await page.waitForTimeout(1200);
ok('resume advances the clock', (await page.textContent('#clock')) !== before);

// skip / prev
await page.click('#next');
await page.waitForTimeout(300);
ok('skip jumps to the next hold', (await page.textContent('#nowOut')) === 'Front plank',
   await page.textContent('#nowOut'));
await page.click('#next');
await page.waitForTimeout(300);
ok('skip again advances', (await page.textContent('#nowOut')) === 'Side plank left',
   await page.textContent('#nowOut'));
await page.click('#prev');
await page.waitForTimeout(300);
ok('prev goes back', (await page.textContent('#nowOut')) === 'Front plank',
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
const said = await page.evaluate(() => window.__said);
ok('spoke the closing line', said.some(s => /Session complete/.test(s)), said.slice(-4).join(' | '));
ok('counted 5·4·3·2·1 aloud', ['5', '4', '3', '2', '1'].every(n => said.includes(n)));

/* ── 5. persistence ── */
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__PLANK__);
ok('routine survives a reload', (await page.inputValue('#rows .row input[data-k=dur]')) === '0:08',
   await page.inputValue('#rows .row input[data-k=dur]'));

ok('no console/page errors', errors.length === 0, errors.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
