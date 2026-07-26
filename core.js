/* PLANK//MATRIX — pure core.
 *
 * Everything here is a pure function of its arguments: no DOM, no audio, no
 * storage, no clock. That is deliberate — it means the timeline, the cue
 * schedule and the config migrations can be unit-tested in Node in
 * milliseconds (`npm run test:unit`) instead of behind a browser launch.
 *
 * Anything that touches the world lives in app.js.
 */

export const HOLDS = ['Front plank', 'Side plank right', 'Side plank left', 'Back plank'];
export const CUSTOM = '__custom';

/* Bump when the shape of a stored config changes; migrations key off it.
 *   2: lead-in lengthened so the countdown has room to breathe
 *   3: the voice on/off toggle became a three-level cue setting            */
export const SCHEMA = 3;

export const CUE_LEVELS = ['full', 'minimal', 'beeps'];

/* Every bound the app will accept, in one place. */
export const LIMITS = {
  dur: [5, 3600],
  rounds: [1, 20],
  rest: [0, 600],
  prep: [0, 60],
  items: 40,
  name: 40,
  step: 15          // the ± step, in the editor and mid-session
};

/* An open hold has no known end, so its cues are generated blind up to here. */
export const OPEN_CUE_CAP = 1200;

export const PRESETS = [
  { id: 'classic', label: 'Classic core (4:00)', items: [
    { name: 'Front plank', dur: 120 },
    { name: 'Side plank left', dur: 30 },
    { name: 'Side plank right', dur: 30 },
    { name: 'Back plank', dur: 60 }
  ] },
  { id: 'starter', label: 'Starter (2:00)', items: [
    { name: 'Front plank', dur: 45 },
    { name: 'Side plank left', dur: 20 },
    { name: 'Side plank right', dur: 20 },
    { name: 'Back plank', dur: 35 }
  ] },
  { id: 'pyramid', label: 'Pyramid (5:30)', items: [
    { name: 'Front plank', dur: 60 },
    { name: 'Side plank left', dur: 45 },
    { name: 'Side plank right', dur: 45 },
    { name: 'Front plank', dur: 90 },
    { name: 'Back plank', dur: 60 },
    { name: 'Front plank', dur: 30 }
  ] },
  { id: 'sixmin', label: 'Six minute wall (6:00)', items: [
    { name: 'Front plank', dur: 180 },
    { name: 'Side plank left', dur: 60 },
    { name: 'Side plank right', dur: 60 },
    { name: 'Back plank', dur: 60 }
  ] },
  { id: 'maxtest', label: 'Max hold test (to failure)', items: [
    { name: 'Front plank', dur: 60, open: true },
    { name: 'Side plank left', dur: 30, open: true },
    { name: 'Side plank right', dur: 30, open: true }
  ] }
];

export const DEFAULTS = {
  items: PRESETS[0].items.map((i) => ({ name: i.name, dur: i.dur, custom: false, open: false, best: 0 })),
  rounds: 1, rest: 0, prep: 10, cues: 'full', wake: true, sound: true, rain: true
};

/* ──────────────────────────────────────────────────────────── format ── */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** m:ss — deliberately does not roll into hours, so a 60-minute hold reads 60:00. */
export function fmt(s) {
  s = Math.max(0, Math.round(s));
  const m = (s / 60) | 0;
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

/** h:mm:ss once past an hour, m:ss below it. For totals, not for the clock. */
export function fmtLong(s) {
  s = Math.max(0, Math.round(s));
  const h = (s / 3600) | 0;
  if (!h) return fmt(s);
  const m = ((s % 3600) / 60) | 0;
  const r = s % 60;
  return h + ':' + (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
}

/** "2:00" | "90" | junk → seconds, clamped to [0, 3600]; junk yields `fallback`. */
export function parseDur(str, fallback) {
  str = String(str).trim();
  if (!str) return fallback;
  const p = str.split(':');
  const v = p.length > 1
    ? (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0)
    : parseInt(p[0], 10);
  if (!isFinite(v)) return fallback;
  return clamp(v, 0, LIMITS.dur[1]);
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty'];

function words(n) {
  if (n < 20) return ONES[n];
  return TENS[((n / 10) | 0) - 2] + (n % 10 ? ' ' + ONES[n % 10] : '');
}

/** A duration as a speech engine should read it: "one minute thirty". */
export function spokenDuration(sec) {
  sec = clamp(Math.round(sec), 0, 3599);
  const m = (sec / 60) | 0;
  const s = sec % 60;
  if (!m) return words(s) + (s === 1 ? ' second' : ' seconds');
  const mins = words(m) + (m === 1 ? ' minute' : ' minutes');
  return s ? mins + ' ' + words(s) : mins;
}

/* ──────────────────────────────────────────────────────────── config ── */

/**
 * Turn whatever came out of localStorage into a valid config.
 * @param raw   the parsed stored object (may be null, junk, or any old schema)
 * @param opts  {firstRun, reducedMotion} — environment the caller observed
 */
export function normalize(raw, opts = {}) {
  const c = { ...DEFAULTS, items: DEFAULTS.items.map((i) => ({ ...i })) };
  const src = raw && typeof raw === 'object' ? raw : {};
  const was = src.v | 0;

  for (const k in DEFAULTS) if (src[k] != null) c[k] = src[k];

  if (!Array.isArray(c.items) || !c.items.length) c.items = DEFAULTS.items.map((i) => ({ ...i }));
  c.items = c.items.slice(0, LIMITS.items).map((i) => {
    const it = i && typeof i === 'object' ? i : {};
    const name = String(it.name || 'Hold').slice(0, LIMITS.name);
    return {
      name,
      dur: clamp(it.dur | 0, LIMITS.dur[0], LIMITS.dur[1]),
      // routines saved before the picker existed: anything off the list is custom
      custom: it.custom == null ? HOLDS.indexOf(name) < 0 : !!it.custom,
      open: !!it.open,
      best: clamp(it.best | 0, 0, LIMITS.dur[1])
    };
  });

  c.rounds = clamp(c.rounds | 0, LIMITS.rounds[0], LIMITS.rounds[1]);
  c.rest = clamp(c.rest | 0, LIMITS.rest[0], LIMITS.rest[1]);
  c.prep = clamp(c.prep | 0, LIMITS.prep[0], LIMITS.prep[1]);

  // v2 → v3: a boolean voice toggle becomes a three-level cue setting
  if (was < 3 && src.voice != null) c.cues = src.voice ? 'full' : 'beeps';
  if (CUE_LEVELS.indexOf(c.cues) < 0) c.cues = 'full';

  c.wake = !!c.wake; c.sound = !!c.sound; c.rain = !!c.rain;

  // v1 → v2: the old 5s lead-in had no room for a 5·4·3·2·1. Nudge it once, but
  // leave a lead-in the user deliberately set to something else alone.
  if (was < 2 && c.prep > 0 && c.prep <= 5) c.prep = DEFAULTS.prep;

  c.v = SCHEMA;
  if (opts.firstRun && opts.reducedMotion) c.rain = false;
  return c;
}

/* ─────────────────────────────────────────────────── timeline & cues ── */

/**
 * Flatten a config into an absolute-time list of segments.
 *
 * @param over  optional {segmentIndex: seconds} of measured/adjusted durations.
 *              Overrides never change the number or order of segments, so an
 *              index stays valid across a rebuild — which is what lets a live
 *              ±15s and a completed open hold both just rebuild the timeline.
 */
export function buildTimeline(cfg, over) {
  const segs = [];
  const rounds = clamp((cfg.rounds | 0) || 1, LIMITS.rounds[0], LIMITS.rounds[1]);
  const rest = cfg.rest | 0;
  const prep = cfg.prep | 0;

  const items = [];
  (cfg.items || []).forEach((it, i) => { if ((it.dur | 0) > 0) items.push({ it, i }); });
  if (!items.length) return { segs, total: 0, openIdx: -1, open: false };

  let t = 0;
  const push = (s) => {
    const ov = over ? over[segs.length] : null;
    if (ov != null) { s.dur = ov; s.open = false; }
    s.at = t;
    segs.push(s);
    t += s.dur;
  };

  if (prep > 0) push({ type: 'prep', name: 'Lead-in', dur: prep, round: 0, idx: 0, item: -1, open: false });

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < items.length; i++) {
      const { it, i: src } = items[i];
      push({ type: 'work', name: it.name || 'Hold', dur: it.dur | 0, round: r + 1,
             idx: i + 1, of: items.length, item: src, open: !!it.open });
      const last = r === rounds - 1 && i === items.length - 1;
      if (rest > 0 && !last) {
        push({ type: 'rest', name: 'Rest', dur: rest, round: r + 1, idx: i + 1,
               of: items.length, item: -1, open: false });
      }
    }
  }

  let openIdx = -1;
  for (let i = 0; i < segs.length; i++) if (segs[i].open) { openIdx = i; break; }
  return { segs, total: t, openIdx, open: openIdx >= 0 };
}

/**
 * The cue schedule for a timeline, sorted by time.
 *
 * Every cue carries a `rank`: 'edge' for the lines that say what to do next,
 * 'num' for the countdown. That is what the cue-level setting filters on, so
 * this function stays independent of user preferences.
 */
export function buildCues(tl) {
  const cues = [];
  const segs = tl.segs;
  const add = (t, tone, say, rank) => cues.push({ t, tone, say, rank });

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const next = segs[i + 1];

    if (i === 0) {
      // keep the opening line short: it has to be out of the way before the
      // lead-in countdown starts talking
      add(0, 'start', s.type === 'prep' ? (segs[1] ? segs[1].name : '') : s.name, 'edge');
    }

    if (s.open) {
      // No end to count down to. Call the elapsed time every 30s instead, which
      // is what you want when you are testing a max hold.
      for (let m = 30; m <= OPEN_CUE_CAP; m += 30) {
        add(s.at + m, m % 60 ? 'half' : 'minute', spokenDuration(m), 'num');
      }
      break;   // nothing past an open hold is knowable until it has been measured
    }

    for (let m = 60; m < s.dur; m += 60) {
      const k = m / 60;
      add(s.at + s.dur - m, 'minute',
          k === 1 ? 'One minute remaining' : k + ' minutes remaining', 'num');
    }
    if (s.dur > 30) add(s.at + s.dur - 30, 'half', 'Thirty seconds', 'num');
    if (s.dur > 10) add(s.at + s.dur - 10, 'ten', 'Ten seconds', 'num');

    // A short rest is over before its own announcement can finish speaking, and
    // each cue pre-empts the last — so counting one down truncates the only line
    // that says what is coming. Let a short rest just be quiet.
    if (!(s.type === 'rest' && s.dur < 10)) {
      for (let k = 5; k >= 1; k--) if (s.dur > k) add(s.at + s.dur - k, 'tick', String(k), 'num');
    }

    const bt = s.at + s.dur;
    if (next) {
      let say;
      if (next.type === 'rest') say = 'Rest. Next up, ' + (segs[i + 2] ? segs[i + 2].name : 'finish');
      else if (s.type === 'prep') say = 'Begin';   // the name was called at the top of the lead-in
      else if (s.type === 'rest') say = 'Go. ' + next.name;
      else say = 'Switch. ' + next.name;
      add(bt, next.type === 'rest' ? 'rest' : 'switch', say, 'edge');
    } else {
      add(bt, 'finish', 'Session complete. Nice work.', 'edge');
    }
  }

  cues.sort((a, b) => a.t - b.t);
  for (const c of cues) { c.fired = false; c.node = null; c.at = 0; }
  return cues;
}

/** Index of the segment containing `e`; the last segment once past the end. */
export function segAt(tl, e) {
  const segs = tl.segs;
  if (!segs.length) return -1;
  if (e >= tl.total) return segs.length - 1;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].at <= e) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Should this cue be spoken at the given cue level? Beeps are never filtered. */
export function speaks(cue, level) {
  if (level === 'beeps') return false;
  if (level === 'minimal') return cue.rank === 'edge';
  return true;
}
