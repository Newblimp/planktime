/* PLANK//MATRIX — interval timer with background-safe audio cues.
 *
 * Timing model
 * ------------
 * `performance.now()` is the source of truth for elapsed time: monotonic and
 * unaffected by the screen turning off. Every audible cue is *pre-scheduled*
 * onto the Web Audio clock up to LOOKAHEAD seconds ahead, so cues still fire
 * on time when JS timers are throttled or frozen by the OS. A rolling pump
 * re-anchors the audio clock offset if the context is ever suspended/resumed.
 *
 * Never drive a cue from setTimeout: it will be throttled with the screen off.
 * Pure timeline/format/config logic lives in core.js so it can be unit-tested.
 */
import {
  HOLDS, CUSTOM, LIMITS, CUE_LEVELS, PRESETS, DEFAULTS,
  clamp, fmt, fmtLong, parseDur, spokenDuration,
  normalize, buildTimeline, buildCues, segAt, speaks
} from './core.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};
const nowS = () => performance.now() / 1000;

/* ────────────────────────────────────────────────────────── storage ── */

const KEY = 'plankmatrix.v1';

let cfg;
try {
  cfg = normalize(JSON.parse(localStorage.getItem(KEY) || '{}'), {
    firstRun: localStorage.getItem(KEY) === null,
    reducedMotion: !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)
  });
} catch {
  cfg = normalize(null, {});
}

let saveT = 0;
function writeCfg() {
  saveT = 0;
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* quota or private mode */ }
}
function save() { clearTimeout(saveT); saveT = setTimeout(writeCfg, 250); }
// a phone can take the tab away between an edit and the debounce firing
function flushSave() { if (saveT) { clearTimeout(saveT); writeCfg(); } }
addEventListener('pagehide', flushSave);

/* ─────────────────────────────────────────────────────── audio core ── */

const Audio_ = {
  ctx: null, master: null, el: null,

  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;                    // no Web Audio: speech + UI still work
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = cfg.sound ? 1 : 0;
    this.master.connect(this.ctx.destination);

    // A DC-free, effectively inaudible looping element keeps the OS media
    // session alive so the audio clock keeps running with the screen off.
    try {
      const url = silentWavURL(4);
      this.el = document.createElement('audio');
      this.el.addEventListener('loadeddata', () => URL.revokeObjectURL(url), { once: true });
      this.el.src = url;
      this.el.loop = true;
      this.el.preload = 'auto';
      this.el.setAttribute('playsinline', '');
      this.el.volume = 1;
      document.body.appendChild(this.el);
    } catch { /* no <audio>: the context may still survive a screen lock */ }
    this.resume();
  },

  resume() {
    if (this.ctx && this.ctx.state !== 'running') { try { this.ctx.resume(); } catch { /* denied */ } }
  },

  hold(on) {
    if (!this.el) return;
    if (on) { const p = this.el.play(); if (p && p.catch) p.catch(() => {}); }
    else { try { this.el.pause(); } catch { /* already gone */ } }
  },

  setMuted(muted) {
    if (!this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(muted ? 0 : 1, t);
  },

  /* one shaped tone; returns the oscillator so it can be cancelled */
  tone(at, freq, dur, vol, type) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
    g.gain.setValueAtTime(vol, at + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(this.master);
    o.start(at); o.stop(at + dur + 0.03);
    o.__g = g;
    return o;
  },

  play(pattern, at) {
    const p = PATTERNS[pattern];
    if (!p || !this.ctx) return null;
    return p.map((s) => this.tone(at + s[0], s[1], s[2], s[3], s[4]));
  },

  cancel(nodes) {
    if (!nodes) return;
    for (const o of nodes) {
      try { o.stop(0); } catch { /* never started */ }
      try { o.disconnect(); o.__g.disconnect(); } catch { /* already detached */ }
    }
  }
};

// [offset, freq, duration, gain, waveform]
const PATTERNS = {
  start:  [[0, 660, 0.16, 0.30], [0.18, 880, 0.24, 0.30]],
  minute: [[0, 880, 0.20, 0.30]],
  half:   [[0, 880, 0.12, 0.30], [0.17, 880, 0.14, 0.30]],
  ten:    [[0, 988, 0.10, 0.28], [0.14, 988, 0.10, 0.28], [0.28, 988, 0.12, 0.28]],
  tick:   [[0, 700, 0.09, 0.22, 'square']],
  rest:   [[0, 523.25, 0.18, 0.28], [0.22, 392, 0.30, 0.28]],
  switch: [[0, 523.25, 0.14, 0.32], [0.15, 783.99, 0.14, 0.32], [0.30, 1046.5, 0.36, 0.34]],
  finish: [[0, 523.25, 0.15, 0.32], [0.16, 659.25, 0.15, 0.32],
           [0.32, 783.99, 0.15, 0.32], [0.48, 1046.5, 0.70, 0.34]]
};

function silentWavURL(seconds) {
  const sr = 8000, n = Math.floor(sr * seconds);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const wr = (off, s) => { for (let j = 0; j < s.length; j++) v.setUint8(off + j, s.charCodeAt(j)); };
  wr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wr(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wr(36, 'data'); v.setUint32(40, n * 2, true);
  // ±1 LSB alternating: non-zero (so the stream counts as playing) yet inaudible
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i & 1 ? 1 : -1, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/* ─────────────────────────────────────────────────────────── speech ── */

let voice = null;
const speechOK = 'speechSynthesis' in window;

function pickVoice() {
  if (!speechOK) return;
  const vs = speechSynthesis.getVoices() || [];
  voice = vs.find((v) => v.lang && v.lang.toLowerCase().startsWith('en') && v.localService) ||
          vs.find((v) => v.lang && v.lang.toLowerCase().startsWith('en')) || null;
}
if (speechOK) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

function speak(text) {
  if (!text || !speechOK || cfg.cues === 'beeps' || !cfg.sound) return;
  try {
    // Utterances queue, so a line still playing would push the next one late —
    // and a countdown number is worthless a second after its second. The newest
    // cue is always the relevant one, so it pre-empts whatever is still talking.
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 1; u.volume = 1;
    u.lang = (voice && voice.lang) || 'en-US';
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  } catch { /* engine unavailable */ }
}
function hushSpeech() { if (speechOK) { try { speechSynthesis.cancel(); } catch { /* nothing queued */ } } }

/* ────────────────────────────────────────────────────────── runtime ── */

const LOOKAHEAD = 120;   // seconds of audio scheduled ahead of the playhead
const TICK_MS = 100;     // pump cadence: the upper bound on how late a spoken cue can be

const R = {
  running: false, paused: false, tl: null, cues: null,
  startT: 0, frozen: 0, off: null, seg: -1,
  head: 0,      // cues before this index have all fired; keeps the pump O(window)
  over: {}      // segment index → measured/adjusted duration for this session
};

const elapsed = () => (R.paused ? R.frozen : nowS() - R.startT);

/** Segment under the playhead, never advancing past a still-unmeasured open hold. */
function segNow(e) {
  const i = segAt(R.tl, e);
  const oi = R.tl.openIdx;
  return oi >= 0 && i > oi ? oi : i;
}
const inOpen = (e) => R.tl.openIdx >= 0 && segNow(e) === R.tl.openIdx && e >= R.tl.segs[R.tl.openIdx].at;

function clearScheduled() {
  if (!R.cues) return;
  for (const c of R.cues) {
    if (c.node) { Audio_.cancel(c.node); c.node = null; }
  }
}

/** Re-derive timeline + cues from cfg and R.over, keeping the playhead at `e`. */
function rebuild(e) {
  clearScheduled(); hushSpeech();
  R.tl = buildTimeline(cfg, R.over);
  R.cues = buildCues(R.tl);
  for (const c of R.cues) { c.node = null; c.fired = c.t < e - 0.05; }
  if (R.paused) R.frozen = e; else R.startT = nowS() - e;
  R.off = null; R.seg = -1; R.head = 0;
}

function pump() {
  if (!R.running || R.paused) return;
  const e = elapsed();
  const ctx = Audio_.ctx;

  // The OS parked our audio: nothing can be scheduled meaningfully until it
  // comes back, and the audio clock is frozen, so don't churn the graph. A
  // missing context (no Web Audio at all) is different — cues can still be
  // spoken, they just can't be pre-scheduled.
  const parked = !!ctx && ctx.state !== 'running';
  if (parked) Audio_.resume();

  if (!parked) {
    const cues = R.cues;
    if (ctx) {
      const raw = ctx.currentTime - e;
      if (R.off === null || Math.abs(raw - R.off) > 0.35) R.off = raw;   // (re)anchor after a suspend
    }

    while (R.head < cues.length && cues[R.head].fired) R.head++;

    for (let i = R.head; i < cues.length; i++) {
      const c = cues[i];
      if (c.fired) continue;
      if (e >= c.t) {
        if (e < c.t + 1.2) {                 // skip cues we woke up late for
          if (!c.node && ctx) Audio_.play(c.tone, ctx.currentTime + 0.01);   // never got scheduled
          if (speaks(c, cfg.cues)) speak(c.say);
        }
        c.fired = true; c.node = null;
        continue;
      }
      if (c.t - e > LOOKAHEAD) break;        // cues are sorted: nothing further is due
      if (!ctx) continue;                    // no audio clock to schedule against
      const at = c.t + R.off;
      if (!c.node) {
        c.node = Audio_.play(c.tone, Math.max(at, ctx.currentTime + 0.01));
        c.at = at;
      } else if (Math.abs(c.at - at) > 0.3) {
        Audio_.cancel(c.node);
        c.node = Audio_.play(c.tone, Math.max(at, ctx.currentTime + 0.01));
        c.at = at;
      }
    }
  }

  // Completion is a wall-clock fact, not an audio one, so it is checked even
  // when the context is missing or parked — otherwise a session that ends
  // while the audio is asleep never returns to setup. It runs after the cue
  // pass so the closing chime still gets to fire.
  if (R.tl.openIdx < 0 && e >= R.tl.total + 0.05) finish();
}

function start() {
  R.over = {};
  const tl = buildTimeline(cfg, R.over);
  if (!tl.total) return;
  Audio_.init();
  Audio_.hold(true);
  R.tl = tl;
  R.cues = buildCues(tl);
  R.running = true; R.paused = false; R.off = null; R.seg = -1; R.head = 0;
  R.startT = nowS();
  requestWakeLock();
  mediaHandlers(true);
  mediaMeta();
  ticker(TICK_MS);
  show('run');
  UI.reset();
  pump();          // fires the t=0 cue inside the user gesture (unlocks iOS speech)
  startRAF();
  window.addEventListener('beforeunload', beforeUnload);
}

function finish() {
  R.running = false; R.paused = false;
  // scheduled tail (the finish chime) is deliberately left to ring out
  teardown();
  setTimeout(() => Audio_.hold(false), 2500);
  show('setup');
}

function stop() {
  R.running = false; R.paused = false;
  clearScheduled(); hushSpeech();
  teardown();
  Audio_.hold(false);
  show('setup');
}

function teardown() {
  ticker(0); stopRAF(); releaseWakeLock(); mediaHandlers(false);
  window.removeEventListener('beforeunload', beforeUnload);
}

function setPaused(p) {
  if (!R.running || R.paused === p) return;
  if (p) {
    R.frozen = elapsed();
    R.paused = true;
    clearScheduled(); hushSpeech();
    ticker(0); stopRAF();
  } else {
    R.startT = nowS() - R.frozen;
    R.paused = false; R.off = null;
    Audio_.resume(); Audio_.hold(true);
    ticker(TICK_MS); startRAF(); pump();
  }
  if (navigator.mediaSession) navigator.mediaSession.playbackState = R.paused ? 'paused' : 'playing';
  UI.paint(true);
}

function seek(t) {
  if (!R.running) return;
  // a pending open hold is a wall: the playhead cannot pass it unmeasured
  const ceiling = R.tl.openIdx >= 0 ? R.tl.segs[R.tl.openIdx].at : R.tl.total;
  t = clamp(t, 0, ceiling);
  clearScheduled(); hushSpeech();
  for (const c of R.cues) { c.node = null; c.fired = c.t < t - 0.05; }
  if (R.paused) R.frozen = t; else R.startT = nowS() - t;
  R.off = null; R.seg = -1; R.head = 0;
  pump(); UI.paint(true);
}

function skip(dir) {
  if (!R.running) return;
  const e = elapsed(), i = segNow(e), s = R.tl.segs[i];
  if (dir > 0) {
    if (i === R.tl.openIdx) { doneOpen(); return; }
    seek(s.at + s.dur);
  } else {
    seek(e - s.at > 2 ? s.at : (i > 0 ? R.tl.segs[i - 1].at : 0));
  }
}

/** End the open hold here: record what it lasted and let the timeline continue. */
function doneOpen() {
  const oi = R.tl.openIdx;
  if (oi < 0) return;
  const s = R.tl.segs[oi];
  const e = elapsed();
  if (e < s.at) return;
  const measured = clamp(Math.round(e - s.at), 1, LIMITS.dur[1]);
  R.over[oi] = measured;

  const item = cfg.items[s.item];
  if (item && measured > (item.best | 0)) { item.best = measured; save(); }

  const at = s.at + measured;
  rebuild(at);
  // fold the result into the line that was going to play anyway, rather than
  // speaking over it — every cue pre-empts the last
  const edge = R.cues.find((c) => !c.fired && c.rank === 'edge' && Math.abs(c.t - at) < 0.06);
  if (edge) edge.say = spokenDuration(measured) + '. ' + edge.say;
  pump(); UI.paint(true);
  announce(s.name + ' held ' + fmt(measured));   // after paint, which announces the new segment
}

/** Lengthen or shorten the segment under the playhead, mid-session. */
function adjust(delta) {
  if (!R.running) return;
  const e = elapsed();
  if (inOpen(e)) return;                     // an open hold has no length to adjust
  const i = segNow(e);
  const s = R.tl.segs[i];
  const floor = Math.max(LIMITS.dur[0], Math.ceil(e - s.at) + 1);   // always leave a second
  const dur = clamp(Math.round(s.dur + delta), floor, LIMITS.dur[1]);
  if (dur === s.dur) return;
  R.over[i] = dur;
  rebuild(e);
  pump(); UI.paint(true);
  announce(s.name + ' now ' + fmt(dur));       // after paint, which announces the new segment
}

function beforeUnload(ev) { ev.preventDefault(); ev.returnValue = ''; return ''; }

/* ────────────────────────────────────────── background tick worker ── */

let worker = null;
try {
  worker = new Worker(URL.createObjectURL(new Blob(
    ['var i=0;onmessage=function(e){clearInterval(i);if(e.data)i=setInterval(function(){postMessage(0)},e.data)}'],
    { type: 'text/javascript' })));
  worker.onmessage = pump;
} catch { worker = null; }

let fallbackTick = 0;
function ticker(ms) {
  if (worker) { worker.postMessage(ms); return; }
  clearInterval(fallbackTick);
  if (ms) fallbackTick = setInterval(pump, ms);
}

/* ────────────────────────────────────────────────────── wake lock ── */

let wl = null;
function requestWakeLock() {
  if (!R.running || !cfg.wake || !('wakeLock' in navigator) || wl || document.hidden) return;
  navigator.wakeLock.request('screen').then((l) => {
    wl = l;
    l.addEventListener('release', () => { wl = null; });
  }).catch(() => {});
}
function releaseWakeLock() { if (wl) { try { wl.release(); } catch { /* already released */ } wl = null; } }

/* ─────────────────────────────────────────────────── media session ── */

const MEDIA_ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack', 'stop'];

/** Registered once per session, not once per segment. */
function mediaHandlers(on) {
  if (!('mediaSession' in navigator)) return;
  try {
    if (on) {
      navigator.mediaSession.setActionHandler('play', () => setPaused(false));
      navigator.mediaSession.setActionHandler('pause', () => setPaused(true));
      navigator.mediaSession.setActionHandler('nexttrack', () => skip(1));
      navigator.mediaSession.setActionHandler('previoustrack', () => skip(-1));
      navigator.mediaSession.setActionHandler('stop', stop);
      navigator.mediaSession.playbackState = R.paused ? 'paused' : 'playing';
    } else {
      navigator.mediaSession.playbackState = 'none';
      for (const a of MEDIA_ACTIONS) {
        try { navigator.mediaSession.setActionHandler(a, null); } catch { /* unsupported action */ }
      }
    }
  } catch { /* no media session */ }
}

function mediaMeta() {
  if (!('mediaSession' in navigator) || !R.tl) return;
  try {
    const s = R.tl.segs[Math.max(0, R.seg)];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: (s && s.name) || 'Plank session',
      artist: 'PLANK//MATRIX',
      album: fmtLong(R.tl.total) + (R.tl.open ? '+' : '') + ' total'
    });
  } catch { /* MediaMetadata unavailable */ }
}

/* ──────────────────────────────────────────────────────────── view ── */

function show(which) {
  $('setup').hidden = which !== 'setup';
  $('run').hidden = which !== 'run';
  if (which === 'setup') renderTotal();
}

/** One-shot line for screen readers; the voice cues are the sighted-user channel. */
function announce(text) { $('sr').textContent = text; }

const UI = (() => {
  const elNow = $('nowOut'), elClock = $('clock'), elStep = $('stepOut'), elNext = $('nextOut'),
        elProg = $('prog'), elBar = $('totalBar'), elRemain = $('remainOut'),
        elRound = $('roundOut'), elPause = $('pause'), elFlash = $('flash'),
        elNextBtn = $('next'), elPlus = $('plus'), elMinus = $('minus');
  const C = 2 * Math.PI * 47;
  const blank = () => ({ sec: -1, seg: -1, frac: -1, total: -1, paused: null, warn: null, open: null });
  let last = blank();
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  return {
    reset() { last = blank(); },

    paint(force) {
      if (!R.tl) return;
      const raw = elapsed();
      const si = segNow(raw);
      if (si < 0) return;
      const s = R.tl.segs[si];
      const open = si === R.tl.openIdx && raw >= s.at;
      const e = open ? raw : clamp(raw, 0, R.tl.total);

      // an open hold counts up from its start; everything else counts down
      const sec = open ? Math.floor(e - s.at + 0.0001)
                       : Math.ceil(Math.max(0, s.at + s.dur - e) - 0.0001);
      const frac = s.dur ? clamp((e - s.at) / s.dur, 0, 1) : 1;

      if (si !== last.seg || open !== last.open || force) {
        last.seg = si; last.open = open; R.seg = si;
        elNow.textContent = s.name;
        const nx = R.tl.segs[si + 1];
        elNext.textContent = '';
        if (nx) {
          const b = el('b');
          b.textContent = nx.name;
          elNext.append('next ▸ ', b);
        } else {
          elNext.append('final hold');
        }
        elStep.textContent = open ? 'to failure'
                                  : (s.type === 'work' ? 'hold ' + s.idx + '/' + s.of : s.type);
        elRound.textContent = cfg.rounds > 1 && s.round ? 'round ' + s.round + '/' + cfg.rounds : '';
        elNextBtn.textContent = open ? '✓ Done' : 'Skip ⏭';
        elPlus.disabled = open; elMinus.disabled = open;
        announce(s.name + (open ? ', hold to failure' : ', ' + fmt(s.dur)));
        mediaMeta();
      }
      if (sec !== last.sec || force) {
        last.sec = sec;
        elClock.textContent = fmt(sec);
        const warn = !open && sec <= 5 && s.type !== 'rest';
        if (warn !== last.warn) { elClock.classList.toggle('warn', warn); last.warn = warn; }
        if (warn && sec > 0 && !reduced && !R.paused) {
          elFlash.classList.remove('on'); void elFlash.offsetWidth; elFlash.classList.add('on');
        }
        elRemain.textContent = open
          ? 'open hold — tap ✓ done when you drop'
          : fmtLong(R.tl.total - e) + ' left of ' + fmtLong(R.tl.total) + (R.tl.open ? '+' : '');
      }
      if (Math.abs(frac - last.frac) > 0.002 || force) {
        last.frac = frac;
        elProg.setAttribute('stroke-dashoffset', (C * frac).toFixed(1));
      }
      const tf = R.tl.total ? clamp(e / R.tl.total, 0, 1) : 0;
      if (Math.abs(tf - last.total) > 0.002 || force) {
        last.total = tf;
        elBar.style.transform = 'scaleX(' + tf.toFixed(4) + ')';
      }
      if (R.paused !== last.paused || force) {
        last.paused = R.paused;
        elPause.textContent = R.paused ? '▶ Resume' : '❚❚ Pause';
      }
    }
  };
})();

let raf = 0;
function frame() { raf = requestAnimationFrame(frame); UI.paint(false); }
function startRAF() { if (!raf && !document.hidden) { raf = requestAnimationFrame(frame); UI.paint(true); } }
function stopRAF() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

/* ────────────────────────────────────────────────── setup rendering ── */

const rowsEl = $('rows');

function actBtn(label, aria, data, pressed) {
  const b = el('button', 'ib');
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.title = aria;
  if (pressed != null) b.setAttribute('aria-pressed', String(!!pressed));
  for (const k in data) b.dataset[k] = data[k];
  return b;
}

function renderRows() {
  const frag = document.createDocumentFragment();

  cfg.items.forEach((it, i) => {
    const row = el('div', 'row');

    const sel = el('select');
    sel.dataset.i = i; sel.dataset.k = 'hold';
    sel.setAttribute('aria-label', 'Hold ' + (i + 1));
    for (const h of HOLDS) {
      const o = el('option');
      o.value = h; o.textContent = h;
      if (!it.custom && it.name === h) o.selected = true;
      sel.appendChild(o);
    }
    const oc = el('option');
    oc.value = CUSTOM; oc.textContent = 'Custom…';
    if (it.custom) oc.selected = true;
    sel.appendChild(oc);
    row.appendChild(sel);

    const dur = el('span', 'dur');
    const minus = el('button');
    minus.type = 'button'; minus.textContent = '−';
    minus.dataset.i = i; minus.dataset.d = -LIMITS.step;
    minus.setAttribute('aria-label', 'Less time');
    const input = el('input');
    input.type = 'text'; input.inputMode = 'numeric';
    input.value = fmt(it.dur);
    input.dataset.i = i; input.dataset.k = 'dur';
    input.setAttribute('aria-label', it.open ? 'Target duration' : 'Duration');
    const plus = el('button');
    plus.type = 'button'; plus.textContent = '+';
    plus.dataset.i = i; plus.dataset.d = LIMITS.step;
    plus.setAttribute('aria-label', 'More time');
    dur.append(minus, input, plus);
    row.appendChild(dur);

    // the name field belongs directly under its picker, above the action strip
    if (it.custom) {
      const nm = el('input', 'nm');
      nm.type = 'text'; nm.value = it.name;
      nm.dataset.i = i; nm.dataset.k = 'name';
      nm.placeholder = 'Name this hold';
      nm.setAttribute('aria-label', 'Custom hold name');
      nm.maxLength = LIMITS.name;
      row.appendChild(nm);
    }

    const acts = el('div', 'rowacts');
    const up = actBtn('↑', 'Move hold ' + (i + 1) + ' up', { i, mv: -1 });
    up.disabled = i === 0;
    const down = actBtn('↓', 'Move hold ' + (i + 1) + ' down', { i, mv: 1 });
    down.disabled = i === cfg.items.length - 1;
    acts.append(
      actBtn('∞', 'Hold ' + (i + 1) + ' to failure', { i, k: 'open' }, it.open),
      up, down,
      actBtn('⧉', 'Duplicate hold ' + (i + 1), { i, dup: 1 }),
      actBtn('✕', 'Remove hold ' + (i + 1), { i, x: 1 })
    );
    row.appendChild(acts);

    if (it.open) {
      const note = el('span', 'note');
      note.textContent = it.best
        ? 'to failure · target ' + fmt(it.dur) + ' · best ' + fmt(it.best)
        : 'to failure · target ' + fmt(it.dur);
      row.appendChild(note);
    }

    frag.appendChild(row);
  });

  rowsEl.textContent = '';
  rowsEl.appendChild(frag);
  renderTotal();
}

function focusRow(i, sel) {
  const target = rowsEl.querySelector(sel.replace('%i', i));
  if (target && !target.disabled) { target.focus(); return; }
  const fallback = rowsEl.querySelector('select[data-k=hold][data-i="' + i + '"]');
  if (fallback) fallback.focus();
}

function renderTotal() {
  const tl = buildTimeline(cfg);
  $('totalOut').textContent = tl.total
    ? 'total ' + fmtLong(tl.total) + (tl.open ? '+' : '')
    : 'empty';
}

rowsEl.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || !rowsEl.contains(b)) return;
  const i = +b.dataset.i;
  const it = cfg.items[i];
  if (!it) return;

  if (b.dataset.x) {
    if (cfg.items.length > 1) { cfg.items.splice(i, 1); save(); renderRows(); }
    return;
  }
  if (b.dataset.dup) {
    if (cfg.items.length >= LIMITS.items) return;
    cfg.items.splice(i + 1, 0, { ...it });
    save(); renderRows();
    focusRow(i + 1, 'button[data-dup][data-i="%i"]');
    return;
  }
  if (b.dataset.mv) {
    const dir = +b.dataset.mv;
    const j = i + dir;
    if (j < 0 || j >= cfg.items.length) return;
    cfg.items.splice(j, 0, cfg.items.splice(i, 1)[0]);
    save(); renderRows();
    // keep focus on the same arrow so a hold can be walked up the list
    focusRow(j, 'button[data-mv="' + dir + '"][data-i="%i"]');
    return;
  }
  if (b.dataset.k === 'open') {
    it.open = !it.open;
    save(); renderRows();
    focusRow(i, 'button[data-k=open][data-i="%i"]');
    return;
  }
  if (b.dataset.d) {
    it.dur = clamp(it.dur + Number(b.dataset.d), LIMITS.dur[0], LIMITS.dur[1]);
    const inp = rowsEl.querySelector('input[data-k=dur][data-i="' + i + '"]');
    if (inp) inp.value = fmt(it.dur);
    save();
    if (it.open) renderRows(); else renderTotal();
  }
});

rowsEl.addEventListener('change', (ev) => {
  const t = ev.target;
  const i = +t.dataset.i;
  const it = cfg.items[i];
  // A field that has been re-rendered away still fires change when it loses
  // focus. Left unguarded that writes a stale name into whatever now sits at
  // this index — e.g. typing a custom name and then loading a preset.
  if (!it || !rowsEl.contains(t)) return;

  if (t.dataset.k === 'hold') {
    if (t.value === CUSTOM) { it.custom = true; it.name = ''; }
    else { it.custom = false; it.name = t.value; }
    save(); renderRows();
    if (it.custom) focusRow(i, 'input[data-k=name][data-i="%i"]');
    return;
  }
  if (t.tagName !== 'INPUT') return;
  if (t.dataset.k === 'name') {
    if (!it.custom) return;
    it.name = t.value.trim() || 'Custom hold';
    t.value = it.name;
  } else {
    it.dur = clamp(parseDur(t.value, it.dur), LIMITS.dur[0], LIMITS.dur[1]);
    t.value = fmt(it.dur);
  }
  save();
  if (it.open) renderRows(); else renderTotal();
});

// keep a custom name in sync as it is typed, so starting without blurring works
rowsEl.addEventListener('input', (ev) => {
  const t = ev.target;
  const it = cfg.items[+t.dataset.i];
  if (t.tagName === 'INPUT' && t.dataset.k === 'name' && it && it.custom && rowsEl.contains(t)) {
    it.name = t.value.slice(0, LIMITS.name);
    save();
  }
});

$('addRow').addEventListener('click', () => {
  if (cfg.items.length >= LIMITS.items) return;
  cfg.items.push({ name: HOLDS[0], dur: 60, custom: false, open: false, best: 0 });
  save(); renderRows();
  focusRow(cfg.items.length - 1, 'select[data-k=hold][data-i="%i"]');
});

// preset picker
{
  const sel = $('preset');
  for (const p of PRESETS) {
    const o = el('option');
    o.value = p.id; o.textContent = p.label;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === sel.value);
    if (!p) return;
    cfg.items = p.items.map((i) => ({
      name: i.name, dur: i.dur, custom: HOLDS.indexOf(i.name) < 0, open: !!i.open, best: 0
    }));
    sel.value = '';
    save(); renderRows();
  });
}

// numeric steppers
function bindStepper(inputId, key, min, max, isTime) {
  const inp = $(inputId);
  const paint = () => { inp.value = isTime ? fmt(cfg[key]) : String(cfg[key]); };
  paint();
  inp.addEventListener('change', () => {
    cfg[key] = clamp(isTime ? parseDur(inp.value, cfg[key]) : (parseInt(inp.value, 10) || min), min, max);
    paint(); save(); renderTotal();
  });
  inp.parentNode.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    cfg[key] = clamp(cfg[key] + (Number(b.dataset.r || b.dataset.rest || b.dataset.prep) || 0), min, max);
    paint(); save(); renderTotal();
  });
}
bindStepper('rounds', 'rounds', ...LIMITS.rounds, false);
bindStepper('rest', 'rest', ...LIMITS.rest, true);
bindStepper('prep', 'prep', ...LIMITS.prep, true);

// toggles
function bindToggle(id, key, on, off, after) {
  const b = $(id);
  const paint = () => {
    b.setAttribute('aria-pressed', String(!!cfg[key]));
    if (on) b.textContent = cfg[key] ? on : off;
  };
  b.addEventListener('click', () => { cfg[key] = !cfg[key]; paint(); save(); if (after) after(); });
  paint();
}
bindToggle('wakeToggle', 'wake', 'Screen ▸ awake', 'Screen ▸ free', () => {
  if (cfg.wake) requestWakeLock(); else releaseWakeLock();
});
bindToggle('soundToggle', 'sound', null, null, () => {
  Audio_.setMuted(!cfg.sound);
  $('soundToggle').textContent = cfg.sound ? '♪' : '✕';
  if (!cfg.sound) hushSpeech();
});
$('soundToggle').textContent = cfg.sound ? '♪' : '✕';
bindToggle('rainToggle', 'rain', null, null, () => Rain.setEnabled(cfg.rain));

// cue level: full → minimal → beeps
{
  const b = $('cueToggle');
  const LABEL = { full: 'Cues ▸ full', minimal: 'Cues ▸ minimal', beeps: 'Cues ▸ beeps only' };
  const HINT = {
    full: 'Every cue spoken.',
    minimal: 'Only the lines that say what to do next; the countdown stays a beep.',
    beeps: 'No speech at all.'
  };
  const paint = () => {
    b.textContent = LABEL[cfg.cues];
    b.setAttribute('aria-label', LABEL[cfg.cues] + '. ' + HINT[cfg.cues] + ' Activate to change.');
  };
  b.addEventListener('click', () => {
    cfg.cues = CUE_LEVELS[(CUE_LEVELS.indexOf(cfg.cues) + 1) % CUE_LEVELS.length];
    paint(); save(); hushSpeech();
  });
  paint();
}

/* ───────────────────────────────────────────────────── digital rain ── */

const Rain = (() => {
  const cv = $('rain'), ctx = cv.getContext('2d', { alpha: false });
  const GLYPHS = 'ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789=*+-<>:.".';
  const atlas = document.createElement('canvas'), actx = atlas.getContext('2d');
  let W = 0, H = 0, dpr = 1, cell = 16, cols = 0;
  let y = null, sp = null, prev = null;
  let raf_ = 0, last = 0, enabled = cfg.rain, visible = true;
  const interval = 1000 / 20;
  let fade = 'rgba(0,0,0,.055)';

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function buildAtlas() {
    const px = Math.round(cell * dpr);
    atlas.width = GLYPHS.length * px;
    atlas.height = px * 2;
    actx.clearRect(0, 0, atlas.width, atlas.height);
    actx.font = (px * 0.92) + 'px ui-monospace,Menlo,Consolas,monospace';
    actx.textAlign = 'center';
    actx.textBaseline = 'middle';
    const tail = css('--rain-tail') || '#00c235', head = css('--rain-head') || '#d8ffe4';
    for (let r = 0; r < 2; r++) {
      actx.fillStyle = r ? head : tail;
      for (let i = 0; i < GLYPHS.length; i++) {
        actx.fillText(GLYPHS[i], i * px + px / 2, r * px + px / 2);
      }
    }
    fade = 'rgba(' + (css('--rain-fade') || '0,0,0') + ',' + (css('--fade-a') || '.055') + ')';
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const w = cv.clientWidth || innerWidth, h = cv.clientHeight || innerHeight;
    W = Math.round(w * dpr); H = Math.round(h * dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    cell = w < 420 ? 14 : 16;
    cols = Math.ceil(w / cell) + 1;
    y = new Float32Array(cols); sp = new Float32Array(cols); prev = new Int16Array(cols);
    for (let i = 0; i < cols; i++) {
      y[i] = -Math.random() * 40;
      sp[i] = 0.45 + Math.random() * 0.65;
      prev[i] = -999;
    }
    buildAtlas();
    wipe();
  }

  function wipe() {
    ctx.fillStyle = css('--bg') || '#000';
    ctx.fillRect(0, 0, W, H);
  }

  function draw(ts) {
    raf_ = requestAnimationFrame(draw);
    if (ts - last < interval) return;
    last = ts;
    const px = Math.round(cell * dpr), rows = H / px;
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < cols; i++) {
      y[i] += sp[i];
      const r = y[i] | 0;
      if (r !== prev[i] && r >= 0) {
        prev[i] = r;
        ctx.drawImage(atlas, ((Math.random() * GLYPHS.length) | 0) * px, px, px, px,
                      i * px, r * px, px, px);
      }
      if (y[i] > rows && Math.random() > 0.975) { y[i] = -Math.random() * 12; prev[i] = -999; }
    }
  }

  function run() {
    if (raf_ || !enabled || !visible) return;
    last = 0; raf_ = requestAnimationFrame(draw);
  }
  function halt() { if (raf_) { cancelAnimationFrame(raf_); raf_ = 0; } }

  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); }, { passive: true });

  resize();
  cv.style.display = enabled ? 'block' : 'none';
  if (enabled) run();

  return {
    setEnabled(on) {
      enabled = on; cv.style.display = on ? 'block' : 'none';
      if (on) { resize(); run(); } else halt();
    },
    pause() { visible = false; halt(); },
    play() { visible = true; run(); },
    retheme() { if (!enabled) return; buildAtlas(); wipe(); }
  };
})();

/* ─────────────────────────────────────────────────────────── theme ── */
/* system | dark | light. "system" stores nothing and tracks the OS live. */

const THEME_KEY = 'plankmatrix.theme';
const themeBtns = document.querySelectorAll('.seg button[data-theme]');
const sysLight = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
let themeMode = 'system';
try {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') themeMode = stored;
} catch { /* storage blocked */ }

function applyTheme() {
  const t = themeMode === 'system' ? (sysLight && sysLight.matches ? 'light' : 'dark') : themeMode;
  document.documentElement.dataset.theme = t;
  const tc = $('tc');
  if (tc) tc.content = t === 'light' ? '#dcece0' : '#000000';
  for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.theme === themeMode));
  Rain.retheme();
}

for (const b of themeBtns) {
  b.addEventListener('click', () => {
    themeMode = b.dataset.theme;
    applyTheme();
    try {
      if (themeMode === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, themeMode);
    } catch { /* storage blocked */ }
  });
}
if (sysLight) {
  const onSys = () => { if (themeMode === 'system') applyTheme(); };
  if (sysLight.addEventListener) sysLight.addEventListener('change', onSys);
  else if (sysLight.addListener) sysLight.addListener(onSys);   // Safari < 14
}
applyTheme();

/* ──────────────────────────────────────────────────────── transport ── */

$('start').addEventListener('click', start);
$('pause').addEventListener('click', () => setPaused(!R.paused));
$('next').addEventListener('click', () => skip(1));
$('prev').addEventListener('click', () => skip(-1));
$('stop').addEventListener('click', stop);
$('plus').addEventListener('click', () => adjust(LIMITS.step));
$('minus').addEventListener('click', () => adjust(-LIMITS.step));

document.addEventListener('keydown', (ev) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    if (!R.running) start(); else setPaused(!R.paused);
    return;
  }
  if (!R.running) return;
  if (ev.key === 'ArrowRight') skip(1);
  else if (ev.key === 'ArrowLeft') skip(-1);
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); adjust(LIMITS.step); }
  else if (ev.key === 'ArrowDown') { ev.preventDefault(); adjust(-LIMITS.step); }
  else if (ev.key === 'Escape') stop();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flushSave();
    stopRAF();
    Rain.pause();
    return;
  }
  Rain.play();
  if (R.running && !R.paused) {
    Audio_.resume(); Audio_.hold(true);
    R.off = null; pump(); startRAF();
  }
  requestWakeLock();
});

/* ───────────────────────────────────────────────────────── startup ── */

renderRows();
show('setup');

// small debug surface (used by tools/verify.mjs)
window.__PLANK__ = {
  buildTimeline, buildCues, segAt, fmt, fmtLong, parseDur, spokenDuration,
  speak, cfg, R, LIMITS,
  adjust, doneOpen
};

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
