/* Unit checks for the pure core. No browser, no server — runs in milliseconds.
 *   node --test tools/core.test.mjs
 * Anything needing real audio, storage or the DOM belongs in verify.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLDS, LIMITS, SCHEMA, DEFAULTS, PRESETS, OPEN_CUE_CAP,
  clamp, fmt, fmtLong, parseDur, spokenDuration,
  normalize, buildTimeline, buildCues, segAt, speaks
} from '../core.js';

const cfgOf = (over = {}) => ({ items: [], rounds: 1, rest: 0, prep: 0, ...over });
const times = (cues) => cues.map((c) => c.t);
const at = (cues, t) => cues.filter((c) => c.t === t);

/* ─────────────────────────────────────────────────────────── format ── */

test('fmt renders m:ss and does not roll into hours', () => {
  assert.equal(fmt(0), '0:00');
  assert.equal(fmt(9), '0:09');
  assert.equal(fmt(60), '1:00');
  assert.equal(fmt(125), '2:05');
  assert.equal(fmt(3725), '62:05');
  assert.equal(fmt(-5), '0:00');
});

test('fmtLong rolls into hours, fmt does not', () => {
  assert.equal(fmtLong(59), '0:59');
  assert.equal(fmtLong(3599), '59:59');
  assert.equal(fmtLong(3600), '1:00:00');
  assert.equal(fmtLong(3725), '1:02:05');
});

test('parseDur handles mm:ss, bare seconds and junk', () => {
  assert.equal(parseDur('2:00', -1), 120);
  assert.equal(parseDur('0:30', -1), 30);
  assert.equal(parseDur('90', -1), 90);
  assert.equal(parseDur('1:5', -1), 65);
  assert.equal(parseDur('', -1), -1, 'empty falls back');
  assert.equal(parseDur('abc', -1), -1, 'junk falls back');
  assert.equal(parseDur('99:99', -1), 3600, 'clamped to the ceiling');
  assert.equal(parseDur('-30', -1), 0, 'clamped to the floor');
  assert.equal(parseDur('  1:30  ', -1), 90, 'whitespace trimmed');
});

test('spokenDuration reads like a person', () => {
  assert.equal(spokenDuration(1), 'one second');
  assert.equal(spokenDuration(30), 'thirty seconds');
  assert.equal(spokenDuration(45), 'forty five seconds');
  assert.equal(spokenDuration(60), 'one minute');
  assert.equal(spokenDuration(90), 'one minute thirty');
  assert.equal(spokenDuration(120), 'two minutes');
  assert.equal(spokenDuration(125), 'two minutes five');
  assert.equal(spokenDuration(659), 'ten minutes fifty nine');
});

test('clamp', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-1, 1, 10), 1);
  assert.equal(clamp(99, 1, 10), 10);
});

/* ───────────────────────────────────────────────────────── timeline ── */

const REFERENCE = cfgOf({
  items: [{ name: 'Front plank', dur: 120 }, { name: 'Side plank left', dur: 30 },
          { name: 'Side plank right', dur: 30 }, { name: 'Back plank', dur: 60 }],
  prep: 10
});

test('buildTimeline lays segments end to end', () => {
  const tl = buildTimeline(REFERENCE);
  assert.equal(tl.total, 250);
  assert.deepEqual(tl.segs.map((s) => [s.name, s.at, s.dur]), [
    ['Lead-in', 0, 10], ['Front plank', 10, 120],
    ['Side plank left', 130, 30], ['Side plank right', 160, 30], ['Back plank', 190, 60]
  ]);
  assert.equal(tl.openIdx, -1);
  assert.equal(tl.open, false);
});

test('buildTimeline repeats rounds and never trails a rest', () => {
  const tl = buildTimeline(cfgOf({
    items: [{ name: 'A', dur: 20 }, { name: 'B', dur: 20 }], rounds: 2, rest: 10
  }));
  assert.equal(tl.total, 110);
  assert.deepEqual(tl.segs.map((s) => s.type + ':' + s.name),
    ['work:A', 'rest:Rest', 'work:B', 'rest:Rest', 'work:A', 'rest:Rest', 'work:B']);
});

test('buildTimeline drops zero-length items but keeps the source index', () => {
  const tl = buildTimeline(cfgOf({
    items: [{ name: 'A', dur: 0 }, { name: 'B', dur: 30 }, { name: 'C', dur: 0 }, { name: 'D', dur: 10 }]
  }));
  assert.deepEqual(tl.segs.map((s) => s.name), ['B', 'D']);
  assert.deepEqual(tl.segs.map((s) => s.item), [1, 3], 'item points back into cfg.items');
  assert.deepEqual(tl.segs.map((s) => s.idx + '/' + s.of), ['1/2', '2/2']);
});

test('buildTimeline with no usable items yields an empty timeline', () => {
  const tl = buildTimeline(cfgOf({ items: [{ name: 'A', dur: 0 }], prep: 10 }));
  assert.equal(tl.total, 0);
  assert.deepEqual(tl.segs, []);
});

test('a zero lead-in produces no prep segment', () => {
  const tl = buildTimeline(cfgOf({ items: [{ name: 'A', dur: 20 }], prep: 0 }));
  assert.equal(tl.segs.length, 1);
  assert.equal(tl.segs[0].type, 'work');
});

test('overrides replace a duration without moving any segment index', () => {
  const base = buildTimeline(REFERENCE);
  const over = buildTimeline(REFERENCE, { 1: 60 });
  assert.equal(base.segs.length, over.segs.length, 'segment count is stable');
  assert.deepEqual(base.segs.map((s) => s.name), over.segs.map((s) => s.name));
  assert.equal(over.segs[1].dur, 60);
  assert.equal(over.total, 190, 'everything after it shifts back by 60s');
  assert.deepEqual(over.segs.map((s) => s.at), [0, 10, 70, 100, 130]);
});

test('rounds are clamped into range', () => {
  assert.equal(buildTimeline(cfgOf({ items: [{ name: 'A', dur: 10 }], rounds: 999 })).total, 200);
  assert.equal(buildTimeline(cfgOf({ items: [{ name: 'A', dur: 10 }], rounds: 0 })).total, 10);
});

/* ───────────────────────────────────────────────────────────── cues ── */

test('the reference routine gets the documented cue schedule', () => {
  const cues = buildCues(buildTimeline(REFERENCE));
  const say = (t) => at(cues, t).map((c) => c.say);

  assert.deepEqual(say(0), ['Front plank'], 'opening line is just the first hold name');
  for (const t of [5, 6, 7, 8, 9]) {
    assert.deepEqual(at(cues, t).map((c) => c.tone), ['tick'], 'lead-in counts 5·4·3·2·1 at ' + t);
  }
  assert.deepEqual(say(10), ['Begin']);
  assert.deepEqual(say(70), ['One minute remaining']);
  assert.deepEqual(say(100), ['Thirty seconds']);
  assert.deepEqual(say(120), ['Ten seconds']);
  assert.deepEqual(say(130), ['Switch. Side plank left']);
  assert.deepEqual(say(160), ['Switch. Side plank right']);
  assert.deepEqual(say(190), ['Switch. Back plank']);
  assert.deepEqual(say(250), ['Session complete. Nice work.']);
  assert.equal(cues.at(-1).tone, 'finish');
});

test('cues that would not fit are skipped rather than crowded', () => {
  const cues = buildCues(buildTimeline(REFERENCE));
  // the 30s holds run 130→160 and 160→190
  assert.equal(cues.some((c) => c.t > 130 && c.t < 160 && /Thirty/.test(c.say)), false,
    'a 30s hold gets no "thirty seconds" the instant it starts');
  assert.deepEqual(at(cues, 150).map((c) => c.say), ['Ten seconds'],
    'but it still gets the 10s call');
  assert.equal(cues.some((c) => c.t > 190 && c.t < 250 && /minute/.test(c.say)), false,
    'a 1:00 hold gets no minute call');
  assert.equal(cues.some((c) => c.t === 10 && /minute/.test(c.say)), false,
    'no minute call lands on the start of a hold');
});

test('cues are sorted and never collide on the same second', () => {
  for (const cfg of [
    REFERENCE,
    cfgOf({ items: [{ name: 'A', dur: 30 }, { name: 'B', dur: 30 }], rounds: 2, rest: 15, prep: 10 }),
    cfgOf({ items: [{ name: 'A', dur: 185 }], prep: 7 }),
    cfgOf({ items: [{ name: 'A', dur: 5 }, { name: 'B', dur: 6 }], rest: 12 })
  ]) {
    const t = times(buildCues(buildTimeline(cfg)));
    assert.deepEqual(t, [...t].sort((a, b) => a - b), 'sorted');
    assert.equal(new Set(t).size, t.length, 'no collisions');
  }
});

test('a short rest stays quiet so its announcement can finish', () => {
  const short = buildCues(buildTimeline(cfgOf({
    items: [{ name: 'A', dur: 30 }, { name: 'B', dur: 30 }], rest: 6
  })));
  assert.deepEqual(at(short, 30).map((c) => c.say), ['Rest. Next up, B']);
  assert.deepEqual(short.filter((c) => c.t > 30 && c.t < 36), [],
    'nothing interrupts the rest line during a 6s rest');
  assert.deepEqual(at(short, 36).map((c) => c.say), ['Go. B']);

  const long = buildCues(buildTimeline(cfgOf({
    items: [{ name: 'A', dur: 30 }, { name: 'B', dur: 30 }], rest: 20
  })));
  assert.deepEqual(long.filter((c) => c.t > 30 && c.t < 50).map((c) => c.say),
    ['Ten seconds', '5', '4', '3', '2', '1'], 'a 20s rest still counts down');
});

test('a work hold always counts down, however short', () => {
  const cues = buildCues(buildTimeline(cfgOf({ items: [{ name: 'A', dur: 8 }] })));
  assert.deepEqual(cues.filter((c) => c.tone === 'tick').map((c) => c.say), ['5', '4', '3', '2', '1']);
});

test('every cue is ranked so the cue level can filter it', () => {
  const cues = buildCues(buildTimeline(REFERENCE));
  assert.equal(cues.every((c) => c.rank === 'edge' || c.rank === 'num'), true);
  const edges = cues.filter((c) => c.rank === 'edge').map((c) => c.say);
  assert.deepEqual(edges, ['Front plank', 'Begin', 'Switch. Side plank left',
    'Switch. Side plank right', 'Switch. Back plank', 'Session complete. Nice work.']);
});

test('speaks() filters by cue level', () => {
  const num = { rank: 'num' }, edge = { rank: 'edge' };
  assert.equal(speaks(num, 'full'), true);
  assert.equal(speaks(edge, 'full'), true);
  assert.equal(speaks(num, 'minimal'), false);
  assert.equal(speaks(edge, 'minimal'), true);
  assert.equal(speaks(num, 'beeps'), false);
  assert.equal(speaks(edge, 'beeps'), false);
});

/* ──────────────────────────────────────────────────────── open holds ── */

const OPEN = cfgOf({
  items: [{ name: 'Front plank', dur: 60, open: true }, { name: 'Back plank', dur: 45 }],
  prep: 10
});

test('an open hold is flagged and its planned duration is only a target', () => {
  const tl = buildTimeline(OPEN);
  assert.equal(tl.openIdx, 1);
  assert.equal(tl.open, true);
  assert.equal(tl.segs[1].open, true);
  assert.equal(tl.segs[1].dur, 60, 'the target still lays out the plan');
  assert.equal(tl.total, 115);
});

test('measuring an open hold clears the flag and re-lays the timeline', () => {
  const tl = buildTimeline(OPEN, { 1: 137 });
  assert.equal(tl.openIdx, -1);
  assert.equal(tl.open, false);
  assert.equal(tl.segs[1].open, false);
  assert.equal(tl.segs[1].dur, 137);
  assert.equal(tl.segs[2].at, 147, 'the next hold follows the measured time');
  assert.equal(tl.total, 192);
});

test('only the first unmeasured open hold is the wall', () => {
  const two = cfgOf({ items: [{ name: 'A', dur: 30, open: true }, { name: 'B', dur: 30, open: true }] });
  assert.equal(buildTimeline(two).openIdx, 0);
  assert.equal(buildTimeline(two, { 0: 44 }).openIdx, 1);
  assert.equal(buildTimeline(two, { 0: 44, 1: 20 }).openIdx, -1);
});

test('an open hold gets count-up calls, not a countdown', () => {
  const cues = buildCues(buildTimeline(OPEN));
  assert.deepEqual(at(cues, 10).map((c) => c.say), ['Begin'], 'the lead-in still finishes');
  const own = cues.filter((c) => c.t > 10);
  assert.deepEqual(own.slice(0, 4).map((c) => [c.t - 10, c.say]),
    [[30, 'thirty seconds'], [60, 'one minute'], [90, 'one minute thirty'], [120, 'two minutes']]);
  assert.equal(own.every((c) => c.rank === 'num'), true);
  assert.equal(cues.some((c) => /Switch|Session complete/.test(c.say)), false,
    'nothing past an open hold is knowable, so nothing is scheduled');
  assert.equal(cues.at(-1).t, 10 + OPEN_CUE_CAP);
});

test('cues resume past an open hold once it has been measured', () => {
  const cues = buildCues(buildTimeline(OPEN, { 1: 100 }));
  assert.deepEqual(at(cues, 110).map((c) => c.say), ['Switch. Back plank']);
  assert.deepEqual(at(cues, 155).map((c) => c.say), ['Session complete. Nice work.']);
  assert.equal(cues.some((c) => c.say === 'thirty seconds'), false, 'no count-up calls remain');
});

test('an open hold at the head of the routine still gets its opening line', () => {
  const cues = buildCues(buildTimeline(cfgOf({ items: [{ name: 'Front plank', dur: 60, open: true }] })));
  assert.deepEqual(at(cues, 0).map((c) => [c.tone, c.say]), [['start', 'Front plank']]);
});

/* ────────────────────────────────────────────────────────────── segAt ── */

test('segAt finds the segment holding an instant', () => {
  const tl = buildTimeline(REFERENCE);   // 0,10,130,160,190 … total 250
  assert.equal(segAt(tl, 0), 0);
  assert.equal(segAt(tl, 9.99), 0);
  assert.equal(segAt(tl, 10), 1, 'a boundary belongs to the segment it opens');
  assert.equal(segAt(tl, 129.999), 1);
  assert.equal(segAt(tl, 130), 2);
  assert.equal(segAt(tl, 189), 3);
  assert.equal(segAt(tl, 190), 4);
  assert.equal(segAt(tl, 249.9), 4);
  assert.equal(segAt(tl, 250), 4, 'the end pins to the last segment');
  assert.equal(segAt(tl, 9e9), 4, 'and so does anything past it');
});

test('segAt on a single-segment and an empty timeline', () => {
  assert.equal(segAt(buildTimeline(cfgOf({ items: [{ name: 'A', dur: 30 }] })), 12), 0);
  assert.equal(segAt(buildTimeline(cfgOf({ items: [] })), 0), -1);
});

/* ───────────────────────────────────────────────────────────── config ── */

test('normalize falls back to defaults on junk', () => {
  for (const junk of [null, undefined, 0, 'nope', [], { items: 'no' }, { items: [] }]) {
    const c = normalize(junk);
    assert.equal(c.v, SCHEMA);
    assert.equal(Array.isArray(c.items) && c.items.length > 0, true, 'always a usable routine');
    assert.equal(c.rounds, DEFAULTS.rounds);
  }
});

test('normalize clamps every numeric field', () => {
  const c = normalize({ v: SCHEMA, rounds: 999, rest: -5, prep: 9999,
                        items: [{ name: 'A', dur: 99999 }, { name: 'B', dur: 1 }] });
  assert.equal(c.rounds, LIMITS.rounds[1]);
  assert.equal(c.rest, LIMITS.rest[0]);
  assert.equal(c.prep, LIMITS.prep[1]);
  assert.equal(c.items[0].dur, LIMITS.dur[1]);
  assert.equal(c.items[1].dur, LIMITS.dur[0], 'the stored floor matches the editor floor');
});

test('normalize caps the number of holds', () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ name: 'H' + i, dur: 60 }));
  assert.equal(normalize({ v: SCHEMA, items: many }).items.length, LIMITS.items);
});

test('normalize truncates a long hold name', () => {
  const c = normalize({ v: SCHEMA, items: [{ name: 'x'.repeat(500), dur: 30 }] });
  assert.equal(c.items[0].name.length, LIMITS.name);
});

test('an off-list name loads as a custom hold', () => {
  const c = normalize({ v: SCHEMA, items: [{ name: 'Front plank', dur: 30 }, { name: 'Bird dog', dur: 30 }] });
  assert.equal(c.items[0].custom, false);
  assert.equal(c.items[1].custom, true);
  assert.equal(HOLDS.includes(c.items[0].name), true);
});

test('an explicit custom flag beats the name lookup', () => {
  const c = normalize({ v: SCHEMA, items: [{ name: 'Front plank', dur: 30, custom: true }] });
  assert.equal(c.items[0].custom, true);
});

test('v1 → v2 raises a too-short lead-in exactly once', () => {
  assert.equal(normalize({ prep: 5, items: [{ name: 'A', dur: 30 }] }).prep, DEFAULTS.prep);
  assert.equal(normalize({ v: 2, prep: 5, items: [{ name: 'A', dur: 30 }] }).prep, 5,
    'a deliberate 5s lead-in is left alone');
  assert.equal(normalize({ prep: 20, items: [{ name: 'A', dur: 30 }] }).prep, 20,
    'a custom lead-in is untouched');
  assert.equal(normalize({ prep: 0, items: [{ name: 'A', dur: 30 }] }).prep, 0,
    'a disabled lead-in stays disabled');
});

test('v2 → v3 maps the voice toggle onto a cue level', () => {
  assert.equal(normalize({ v: 2, voice: true }).cues, 'full');
  assert.equal(normalize({ v: 2, voice: false }).cues, 'beeps');
  assert.equal(normalize({ v: 2 }).cues, 'full', 'no stored voice → the default');
  assert.equal(normalize({ v: SCHEMA, cues: 'minimal', voice: false }).cues, 'minimal',
    'a v3 record keeps its own setting');
  assert.equal(normalize({ v: SCHEMA, cues: 'nonsense' }).cues, 'full');
});

test('open and best round-trip through storage', () => {
  const c = normalize({ v: SCHEMA, items: [{ name: 'Front plank', dur: 60, open: true, best: 143 }] });
  assert.equal(c.items[0].open, true);
  assert.equal(c.items[0].best, 143);
  assert.equal(normalize({ v: SCHEMA, items: [{ name: 'Front plank', dur: 60 }] }).items[0].open, false);
});

test('reduced motion only turns the rain off on a first run', () => {
  assert.equal(normalize({}, { firstRun: true, reducedMotion: true }).rain, false);
  assert.equal(normalize({}, { firstRun: false, reducedMotion: true }).rain, true);
  assert.equal(normalize({ v: SCHEMA, rain: true }, { firstRun: true, reducedMotion: false }).rain, true);
});

/* ──────────────────────────────────────────────────────────── presets ── */

test('every preset builds a sane timeline and matches its advertised length', () => {
  for (const p of PRESETS) {
    const cfg = normalize({ v: SCHEMA, items: p.items, prep: 0, rounds: 1, rest: 0 });
    const tl = buildTimeline(cfg);
    assert.equal(tl.segs.length, p.items.length, p.id + ' keeps every hold');
    assert.equal(tl.total > 0, true, p.id + ' is non-empty');
    const advertised = /\((\d+):(\d\d)\)/.exec(p.label);
    if (advertised) {
      assert.equal(tl.total, +advertised[1] * 60 + +advertised[2],
        p.id + ' label matches its actual total');
    }
    assert.doesNotThrow(() => buildCues(tl), p.id + ' builds cues');
  }
});

test('preset hold names all map onto the picker, and none is left custom by accident', () => {
  for (const p of PRESETS) {
    for (const it of p.items) {
      assert.equal(HOLDS.includes(it.name), true, p.id + ' → ' + it.name + ' is a listed hold');
    }
  }
});
