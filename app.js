/* PLANK//MATRIX — interval timer with background-safe audio cues.
 *
 * Timing model
 * ------------
 * `performance.now()` is the source of truth for elapsed time: monotonic and
 * unaffected by the screen turning off. Every audible cue is *pre-scheduled*
 * onto the Web Audio clock up to LOOKAHEAD seconds ahead, so cues still fire
 * on time when JS timers are throttled or frozen by the OS. A rolling pump
 * re-anchors the audio clock offset if the context is ever suspended/resumed.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var nowS = function () { return performance.now() / 1000; };

  /* ────────────────────────────────────────────────────────── config ── */

  var PRESETS = [
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
    ] }
  ];

  // the picker's fixed options; anything else is a custom hold
  var HOLDS = ['Front plank', 'Side plank right', 'Side plank left', 'Back plank'];
  var CUSTOM = '__custom';

  var DEFAULTS = {
    items: PRESETS[0].items.map(function (i) { return { name: i.name, dur: i.dur, custom: false }; }),
    rounds: 1, rest: 0, prep: 10, voice: true, wake: true, sound: true, rain: true
  };

  var KEY = 'plankmatrix.v1';
  var SCHEMA = 2;   // 2: lead-in lengthened so the countdown has room to breathe
  var cfg = load();

  function load() {
    var c = {}, k, was = 0;
    for (k in DEFAULTS) c[k] = DEFAULTS[k];
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      was = raw.v | 0;
      for (k in DEFAULTS) if (raw[k] != null) c[k] = raw[k];
      if (!Array.isArray(c.items) || !c.items.length) c.items = DEFAULTS.items;
      c.items = c.items.map(function (i) {
        var name = String(i.name || 'Hold').slice(0, 40);
        return { name: name, dur: clamp(i.dur | 0, 1, 3600),
                 // routines saved before the picker existed: anything off the
                 // list is treated as a custom hold
                 custom: i.custom == null ? HOLDS.indexOf(name) < 0 : !!i.custom };
      });
      c.rounds = clamp(c.rounds | 0, 1, 20);
      c.rest = clamp(c.rest | 0, 0, 600);
      c.prep = clamp(c.prep | 0, 0, 60);
    } catch (e) { /* corrupt storage → defaults */ }
    // the old 5s lead-in didn't leave room for a 5·4·3·2·1 count; nudge it once,
    // but leave a lead-in the user has deliberately set to something else alone
    if (was < 2 && c.prep > 0 && c.prep <= 5) c.prep = DEFAULTS.prep;
    c.v = SCHEMA;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches &&
        localStorage.getItem(KEY) === null) c.rain = false;
    return c;
  }
  var saveT = 0;
  function writeCfg() {
    saveT = 0;
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {}
  }
  function save() { clearTimeout(saveT); saveT = setTimeout(writeCfg, 250); }
  // a phone can take the tab away between an edit and the debounce firing
  function flushSave() { if (saveT) { clearTimeout(saveT); writeCfg(); } }
  addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flushSave(); });

  /* ─────────────────────────────────────────────────────────── format ── */

  function fmt(s) {
    s = Math.max(0, Math.round(s));
    var m = (s / 60) | 0;
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function fmtLong(s) {
    s = Math.max(0, Math.round(s));
    var h = (s / 3600) | 0;
    if (!h) return fmt(s);
    var m = ((s % 3600) / 60) | 0, r = s % 60;
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function parseDur(str, fallback) {
    str = String(str).trim();
    if (!str) return fallback;
    var p = str.split(':');
    var v;
    if (p.length > 1) v = (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
    else v = parseInt(p[0], 10);
    if (!isFinite(v)) return fallback;
    return clamp(v, 0, 3600);
  }

  /* ─────────────────────────────────────────────────────── audio core ── */

  var Audio_ = {
    ctx: null, master: null, el: null, ready: false,

    init: function () {
      if (this.ctx) { this.resume(); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = cfg.sound ? 1 : 0;
      this.master.connect(this.ctx.destination);

      // A DC-free, effectively inaudible looping element keeps the OS media
      // session alive so the audio clock keeps running with the screen off.
      try {
        this.el = document.createElement('audio');
        this.el.src = silentWavURL(4);
        this.el.loop = true;
        this.el.preload = 'auto';
        this.el.setAttribute('playsinline', '');
        this.el.volume = 1;
        document.body.appendChild(this.el);
      } catch (e) {}
      this.ready = true;
      this.resume();
    },

    resume: function () {
      if (this.ctx && this.ctx.state !== 'running') { try { this.ctx.resume(); } catch (e) {} }
    },
    hold: function (on) {
      if (!this.el) return;
      if (on) { var p = this.el.play(); if (p && p.catch) p.catch(function () {}); }
      else { try { this.el.pause(); } catch (e) {} }
    },
    setMuted: function (muted) {
      if (!this.master) return;
      var t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(muted ? 0 : 1, t);
    },

    /* one shaped tone; returns the oscillator so it can be cancelled */
    tone: function (at, freq, dur, vol, type) {
      var o = this.ctx.createOscillator(), g = this.ctx.createGain();
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

    play: function (pattern, at) {
      var p = PATTERNS[pattern];
      if (!p || !this.ctx) return null;
      var out = [];
      for (var i = 0; i < p.length; i++) {
        var s = p[i];
        out.push(this.tone(at + s[0], s[1], s[2], s[3], s[4]));
      }
      return out;
    },

    cancel: function (nodes) {
      if (!nodes) return;
      for (var i = 0; i < nodes.length; i++) {
        var o = nodes[i];
        try { o.stop(0); } catch (e) {}
        try { o.disconnect(); o.__g.disconnect(); } catch (e) {}
      }
    }
  };

  // [offset, freq, duration, gain, waveform]
  var PATTERNS = {
    start:  [[0, 660, 0.16, 0.30], [0.18, 880, 0.24, 0.30]],
    minute: [[0, 880, 0.20, 0.30]],
    half:   [[0, 880, 0.12, 0.30], [0.17, 880, 0.14, 0.30]],
    ten:    [[0, 988, 0.10, 0.28], [0.14, 988, 0.10, 0.28], [0.28, 988, 0.12, 0.28]],
    tick:   [[0, 700, 0.09, 0.22, 'square']],
    rest:   [[0, 523.25, 0.18, 0.28], [0.22, 392, 0.30, 0.28]],
    'switch': [[0, 523.25, 0.14, 0.32], [0.15, 783.99, 0.14, 0.32], [0.30, 1046.5, 0.36, 0.34]],
    finish: [[0, 523.25, 0.15, 0.32], [0.16, 659.25, 0.15, 0.32],
             [0.32, 783.99, 0.15, 0.32], [0.48, 1046.5, 0.70, 0.34]]
  };

  function silentWavURL(seconds) {
    var sr = 8000, n = Math.floor(sr * seconds);
    var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), i;
    var wr = function (off, s) { for (var j = 0; j < s.length; j++) v.setUint8(off + j, s.charCodeAt(j)); };
    wr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wr(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wr(36, 'data'); v.setUint32(40, n * 2, true);
    // ±1 LSB alternating: non-zero (so the stream counts as playing) yet inaudible
    for (i = 0; i < n; i++) v.setInt16(44 + i * 2, i & 1 ? 1 : -1, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /* ─────────────────────────────────────────────────────────── speech ── */

  var voice = null, speechOK = 'speechSynthesis' in window;
  function pickVoice() {
    if (!speechOK) return;
    var vs = speechSynthesis.getVoices() || [], i, v;
    for (i = 0; i < vs.length; i++) {
      v = vs[i];
      if (v.lang && v.lang.toLowerCase().indexOf('en') === 0 && v.localService) { voice = v; return; }
    }
    for (i = 0; i < vs.length; i++) {
      v = vs[i];
      if (v.lang && v.lang.toLowerCase().indexOf('en') === 0) { voice = v; return; }
    }
  }
  if (speechOK) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  function speak(text) {
    if (!text || !speechOK || !cfg.voice || !cfg.sound) return;
    try {
      // Utterances queue, so a line still playing would push the next one late —
      // and a countdown number is worthless a second after its second. The newest
      // cue is always the relevant one, so it pre-empts whatever is still talking.
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05; u.pitch = 1; u.volume = 1; u.lang = (voice && voice.lang) || 'en-US';
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  function hushSpeech() { if (speechOK) { try { speechSynthesis.cancel(); } catch (e) {} } }

  /* ───────────────────────────────────────────────── timeline & cues ── */

  function buildTimeline(c) {
    var segs = [], t = 0, r, i, it, last;
    var items = c.items.filter(function (x) { return x.dur > 0; });
    if (!items.length) return { segs: segs, total: 0 };
    if (c.prep > 0) { segs.push({ type: 'prep', name: 'Lead-in', dur: c.prep, at: 0, round: 0, idx: 0 }); t = c.prep; }
    for (r = 0; r < c.rounds; r++) {
      for (i = 0; i < items.length; i++) {
        it = items[i];
        segs.push({ type: 'work', name: it.name || 'Hold', dur: it.dur, at: t,
                    round: r + 1, idx: i + 1, of: items.length });
        t += it.dur;
        last = (r === c.rounds - 1 && i === items.length - 1);
        if (c.rest > 0 && !last) {
          segs.push({ type: 'rest', name: 'Rest', dur: c.rest, at: t, round: r + 1, idx: i + 1, of: items.length });
          t += c.rest;
        }
      }
    }
    return { segs: segs, total: t };
  }

  function buildCues(tl) {
    var cues = [], segs = tl.segs, i, k, m, s, next, bt, say;
    for (i = 0; i < segs.length; i++) {
      s = segs[i];
      next = segs[i + 1];
      if (i === 0) {
        // keep the opening line short: it has to be out of the way before the
        // lead-in countdown starts talking
        cues.push({ t: 0, tone: 'start',
          say: s.type === 'prep' ? (segs[1] ? segs[1].name : '') : s.name });
      }
      // every whole minute remaining
      for (m = 60; m < s.dur; m += 60) {
        k = m / 60;
        cues.push({ t: s.at + s.dur - m, tone: 'minute',
          say: k === 1 ? 'One minute remaining' : k + ' minutes remaining' });
      }
      if (s.dur > 30) cues.push({ t: s.at + s.dur - 30, tone: 'half', say: 'Thirty seconds' });
      if (s.dur > 10) cues.push({ t: s.at + s.dur - 10, tone: 'ten', say: 'Ten seconds' });
      for (k = 5; k >= 1; k--) if (s.dur > k) cues.push({ t: s.at + s.dur - k, tone: 'tick', say: String(k) });

      bt = s.at + s.dur;
      if (next) {
        if (next.type === 'rest') say = 'Rest. Next up, ' + (segs[i + 2] ? segs[i + 2].name : 'finish');
        else if (s.type === 'prep') say = 'Begin';   // the name was called at the top of the lead-in
        else if (s.type === 'rest') say = 'Go. ' + next.name;
        else say = 'Switch. ' + next.name;
        cues.push({ t: bt, tone: next.type === 'rest' ? 'rest' : 'switch', say: say });
      } else {
        cues.push({ t: bt, tone: 'finish', say: 'Session complete. Nice work.' });
      }
    }
    cues.sort(function (a, b) { return a.t - b.t; });
    for (i = 0; i < cues.length; i++) { cues[i].fired = false; cues[i].node = null; cues[i].at = 0; }
    return cues;
  }

  /* ────────────────────────────────────────────────────────── runtime ── */

  var LOOKAHEAD = 120;   // seconds of audio scheduled ahead of the playhead
  var TICK_MS = 100;     // pump cadence: the upper bound on how late a spoken cue can be
  var R = { running: false, paused: false, tl: null, cues: null, startT: 0, frozen: 0, off: null, seg: -1 };

  function elapsed() { return R.paused ? R.frozen : nowS() - R.startT; }

  function segAt(e) {
    var segs = R.tl.segs, lo = 0, hi = segs.length - 1, mid;
    if (e >= R.tl.total) return segs.length - 1;
    while (lo < hi) {
      mid = (lo + hi + 1) >> 1;
      if (segs[mid].at <= e) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function clearScheduled() {
    if (!R.cues) return;
    for (var i = 0; i < R.cues.length; i++) {
      if (R.cues[i].node) { Audio_.cancel(R.cues[i].node); R.cues[i].node = null; }
    }
  }

  function pump() {
    if (!R.running || R.paused || !Audio_.ctx) return;
    if (Audio_.ctx.state !== 'running') {
      // the OS parked our audio: nothing can be scheduled meaningfully until it
      // comes back, and the audio clock is frozen, so don't churn the graph
      Audio_.resume();
      return;
    }
    var e = elapsed(), cues = R.cues, i, c, at, raw;

    raw = Audio_.ctx.currentTime - e;
    if (R.off === null || Math.abs(raw - R.off) > 0.35) R.off = raw;   // (re)anchor after a suspend

    for (i = 0; i < cues.length; i++) {
      c = cues[i];
      if (c.fired) continue;
      if (e >= c.t) {
        if (e < c.t + 1.2) {               // skip cues we woke up late for
          if (!c.node) Audio_.play(c.tone, Audio_.ctx.currentTime + 0.01);  // never got scheduled
          speak(c.say);
        }
        c.fired = true; c.node = null;
        continue;
      }
      if (c.t - e > LOOKAHEAD) break;      // cues are sorted: nothing further is due
      at = c.t + R.off;
      if (!c.node) {
        c.node = Audio_.play(c.tone, Math.max(at, Audio_.ctx.currentTime + 0.01));
        c.at = at;
      } else if (Math.abs(c.at - at) > 0.3) {
        Audio_.cancel(c.node);
        c.node = Audio_.play(c.tone, Math.max(at, Audio_.ctx.currentTime + 0.01));
        c.at = at;
      }
    }

    if (e >= R.tl.total + 0.05) finish();
  }

  function start() {
    var tl = buildTimeline(cfg);
    if (!tl.total) return;
    Audio_.init();
    Audio_.hold(true);
    R.tl = tl;
    R.cues = buildCues(tl);
    R.running = true; R.paused = false; R.off = null; R.seg = -1;
    R.startT = nowS();
    requestWakeLock();
    setMediaSession(true);
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
    ticker(0); stopRAF(); releaseWakeLock(); setMediaSession(false);
    window.removeEventListener('beforeunload', beforeUnload);
    setTimeout(function () { Audio_.hold(false); }, 2500);
    show('setup');
  }

  function stop() {
    R.running = false; R.paused = false;
    clearScheduled(); hushSpeech();
    ticker(0); stopRAF(); releaseWakeLock(); setMediaSession(false);
    Audio_.hold(false);
    window.removeEventListener('beforeunload', beforeUnload);
    show('setup');
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
    setMediaSession(R.running);
    UI.paint(true);
  }

  function seek(t) {
    if (!R.running) return;
    t = clamp(t, 0, R.tl.total);
    clearScheduled(); hushSpeech();
    for (var i = 0; i < R.cues.length; i++) {
      R.cues[i].node = null;
      R.cues[i].fired = R.cues[i].t < t - 0.05;
    }
    if (R.paused) R.frozen = t; else R.startT = nowS() - t;
    R.off = null; R.seg = -1;
    pump(); UI.paint(true);
  }

  function skip(dir) {
    if (!R.running) return;
    var e = elapsed(), i = segAt(e), s = R.tl.segs[i];
    if (dir > 0) seek(s.at + s.dur);
    else seek(e - s.at > 2 ? s.at : (i > 0 ? R.tl.segs[i - 1].at : 0));
  }

  function beforeUnload(ev) { ev.preventDefault(); ev.returnValue = ''; return ''; }

  /* ────────────────────────────────────────── background tick worker ── */

  var worker = null;
  try {
    worker = new Worker(URL.createObjectURL(new Blob(
      ['var i=0;onmessage=function(e){clearInterval(i);if(e.data)i=setInterval(function(){postMessage(0)},e.data)}'],
      { type: 'text/javascript' })));
    worker.onmessage = pump;
  } catch (e) { worker = null; }
  var fallbackTick = 0;
  function ticker(ms) {
    if (worker) { worker.postMessage(ms); return; }
    clearInterval(fallbackTick);
    if (ms) fallbackTick = setInterval(pump, ms);
  }

  /* ────────────────────────────────────────────────────── wake lock ── */

  var wl = null;
  function requestWakeLock() {
    if (!R.running || !cfg.wake || !('wakeLock' in navigator) || wl || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wl = l;
      l.addEventListener('release', function () { wl = null; });
    }).catch(function () {});
  }
  function releaseWakeLock() { if (wl) { try { wl.release(); } catch (e) {} wl = null; } }

  /* ─────────────────────────────────────────────────── media session ── */

  function setMediaSession(active) {
    if (!('mediaSession' in navigator)) return;
    try {
      if (active) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: R.tl ? (R.tl.segs[Math.max(0, R.seg)] || {}).name || 'Plank session' : 'Plank session',
          artist: 'PLANK//MATRIX',
          album: R.tl ? fmtLong(R.tl.total) + ' total' : ''
        });
        navigator.mediaSession.playbackState = R.paused ? 'paused' : 'playing';
        navigator.mediaSession.setActionHandler('play', function () { setPaused(false); });
        navigator.mediaSession.setActionHandler('pause', function () { setPaused(true); });
        navigator.mediaSession.setActionHandler('nexttrack', function () { skip(1); });
        navigator.mediaSession.setActionHandler('previoustrack', function () { skip(-1); });
        navigator.mediaSession.setActionHandler('stop', stop);
      } else {
        navigator.mediaSession.playbackState = 'none';
        ['play', 'pause', 'nexttrack', 'previoustrack', 'stop'].forEach(function (a) {
          try { navigator.mediaSession.setActionHandler(a, null); } catch (e) {}
        });
      }
    } catch (e) {}
  }

  /* ──────────────────────────────────────────────────────────── view ── */

  function show(which) {
    $('setup').hidden = which !== 'setup';
    $('run').hidden = which !== 'run';
    if (which === 'setup') renderTotal();
  }

  var UI = (function () {
    var elNow = $('nowOut'), elClock = $('clock'), elStep = $('stepOut'), elNext = $('nextOut'),
        elProg = $('prog'), elBar = $('totalBar'), elRemain = $('remainOut'),
        elRound = $('roundOut'), elPause = $('pause'), elFlash = $('flash');
    var C = 2 * Math.PI * 47;
    var last = { sec: -1, seg: -1, frac: -1, total: -1, paused: null, warn: null };
    var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    return {
      reset: function () { last = { sec: -1, seg: -1, frac: -1, total: -1, paused: null, warn: null }; },

      paint: function (force) {
        if (!R.tl) return;
        var e = clamp(elapsed(), 0, R.tl.total);
        var si = segAt(e), s = R.tl.segs[si];
        var left = Math.max(0, s.at + s.dur - e);
        var sec = Math.ceil(left - 0.0001);
        var frac = s.dur ? clamp((e - s.at) / s.dur, 0, 1) : 1;

        if (si !== last.seg || force) {
          last.seg = si; R.seg = si;
          elNow.textContent = s.name;
          var nx = R.tl.segs[si + 1];
          elNext.innerHTML = nx ? 'next ▸ <b>' + esc(nx.name) + '</b>' : 'final hold';
          elStep.textContent = s.type === 'work' ? 'hold ' + s.idx + '/' + s.of : s.type;
          elRound.textContent = cfg.rounds > 1 && s.round ? 'round ' + s.round + '/' + cfg.rounds : '';
          setMediaSession(R.running);
        }
        if (sec !== last.sec || force) {
          last.sec = sec;
          elClock.textContent = fmt(sec);
          var warn = sec <= 5 && s.type !== 'rest';
          if (warn !== last.warn) { elClock.classList.toggle('warn', warn); last.warn = warn; }
          if (warn && sec > 0 && !reduced && !R.paused) {
            elFlash.classList.remove('on'); void elFlash.offsetWidth; elFlash.classList.add('on');
          }
          elRemain.textContent = fmtLong(R.tl.total - e) + ' left of ' + fmtLong(R.tl.total);
        }
        if (Math.abs(frac - last.frac) > 0.002 || force) {
          last.frac = frac;
          elProg.setAttribute('stroke-dashoffset', (C * frac).toFixed(1));
        }
        var tf = R.tl.total ? e / R.tl.total : 0;
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

  var ESC = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };
  function esc(s) { return String(s).replace(/[<>&"]/g, function (c) { return ESC[c]; }); }

  var raf = 0;
  function frame() { raf = requestAnimationFrame(frame); UI.paint(false); }
  function startRAF() { if (!raf && !document.hidden) { raf = requestAnimationFrame(frame); UI.paint(true); } }
  function stopRAF() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  /* ────────────────────────────────────────────────── setup rendering ── */

  var rowsEl = $('rows');

  function renderRows() {
    var frag = document.createDocumentFragment();
    cfg.items.forEach(function (it, i) {
      var row = document.createElement('div'), opts = '', h;
      row.className = 'row';
      for (h = 0; h < HOLDS.length; h++) {
        opts += '<option value="' + esc(HOLDS[h]) + '"' +
                (!it.custom && it.name === HOLDS[h] ? ' selected' : '') + '>' + esc(HOLDS[h]) + '</option>';
      }
      opts += '<option value="' + CUSTOM + '"' + (it.custom ? ' selected' : '') + '>Custom…</option>';
      row.innerHTML =
        '<select data-i="' + i + '" data-k="hold" aria-label="Hold ' + (i + 1) + '">' + opts + '</select>' +
        '<span class="dur">' +
          '<button type="button" data-i="' + i + '" data-d="-15" aria-label="Less time">−</button>' +
          '<input type="text" inputmode="numeric" value="' + fmt(it.dur) + '" data-i="' + i + '" data-k="dur" aria-label="Duration">' +
          '<button type="button" data-i="' + i + '" data-d="15" aria-label="More time">+</button>' +
        '</span>' +
        '<button class="btn ghost" data-i="' + i + '" data-x="1" aria-label="Remove hold ' + (i + 1) + '">✕</button>' +
        (it.custom
          ? '<input class="nm" type="text" value="' + esc(it.name) + '" data-i="' + i + '" data-k="name" ' +
            'placeholder="Name this hold" aria-label="Custom hold name" maxlength="40">'
          : '');
      frag.appendChild(row);
    });
    rowsEl.textContent = '';
    rowsEl.appendChild(frag);
    renderTotal();
  }

  function focusRow(i, sel) {
    var el = rowsEl.querySelector(sel.replace('%i', i));
    if (el) el.focus();
  }

  function renderTotal() {
    var tl = buildTimeline(cfg);
    $('totalOut').textContent = tl.total ? 'total ' + fmtLong(tl.total) : 'empty';
  }

  rowsEl.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    var i = +b.dataset.i;
    if (b.dataset.x) {
      if (cfg.items.length > 1) { cfg.items.splice(i, 1); save(); renderRows(); }
      return;
    }
    if (b.dataset.d) {
      cfg.items[i].dur = clamp(cfg.items[i].dur + (+b.dataset.d), 5, 3600);
      var inp = rowsEl.querySelector('input[data-k=dur][data-i="' + i + '"]');
      if (inp) inp.value = fmt(cfg.items[i].dur);
      save(); renderTotal();
    }
  });

  rowsEl.addEventListener('change', function (ev) {
    var t = ev.target, i = +t.dataset.i, it = cfg.items[i];
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
      it.name = t.value.trim() || 'Custom hold'; t.value = it.name;
    }
    else { it.dur = clamp(parseDur(t.value, it.dur), 5, 3600); t.value = fmt(it.dur); }
    save(); renderTotal();
  });

  // keep a custom name in sync as it is typed, so starting without blurring works
  rowsEl.addEventListener('input', function (ev) {
    var t = ev.target, it = cfg.items[+t.dataset.i];
    if (t.tagName === 'INPUT' && t.dataset.k === 'name' && it && it.custom && rowsEl.contains(t)) {
      it.name = t.value.slice(0, 40);
      save();
    }
  });

  $('addRow').addEventListener('click', function () {
    cfg.items.push({ name: HOLDS[0], dur: 60, custom: false });
    save(); renderRows();
    focusRow(cfg.items.length - 1, 'select[data-k=hold][data-i="%i"]');
  });

  // preset picker
  (function () {
    var sel = $('preset');
    PRESETS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      var p = PRESETS.filter(function (x) { return x.id === sel.value; })[0];
      if (!p) return;
      cfg.items = p.items.map(function (i) {
        return { name: i.name, dur: i.dur, custom: HOLDS.indexOf(i.name) < 0 };
      });
      sel.value = '';
      save(); renderRows();
    });
  })();

  // numeric steppers
  function bindStepper(inputId, key, min, max, isTime) {
    var inp = $(inputId);
    var paint = function () { inp.value = isTime ? fmt(cfg[key]) : String(cfg[key]); };
    paint();
    inp.addEventListener('change', function () {
      cfg[key] = clamp(isTime ? parseDur(inp.value, cfg[key]) : (parseInt(inp.value, 10) || min), min, max);
      paint(); save(); renderTotal();
    });
    inp.parentNode.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      cfg[key] = clamp(cfg[key] + (+(b.dataset.r || b.dataset.rest || b.dataset.prep) || 0), min, max);
      paint(); save(); renderTotal();
    });
  }
  bindStepper('rounds', 'rounds', 1, 20, false);
  bindStepper('rest', 'rest', 0, 600, true);
  bindStepper('prep', 'prep', 0, 60, true);

  // toggles
  function bindToggle(id, key, on, off, after) {
    var b = $(id);
    var paint = function () {
      b.setAttribute('aria-pressed', String(!!cfg[key]));
      if (on) b.textContent = cfg[key] ? on : off;
    };
    b.addEventListener('click', function () { cfg[key] = !cfg[key]; paint(); save(); if (after) after(); });
    paint();
  }
  bindToggle('voiceToggle', 'voice', 'Voice ▸ on', 'Voice ▸ off', hushSpeech);
  bindToggle('wakeToggle', 'wake', 'Screen ▸ awake', 'Screen ▸ free', function () {
    if (cfg.wake) requestWakeLock(); else releaseWakeLock();
  });
  bindToggle('soundToggle', 'sound', null, null, function () {
    Audio_.setMuted(!cfg.sound);
    $('soundToggle').textContent = cfg.sound ? '♪' : '✕';
    if (!cfg.sound) hushSpeech();
  });
  $('soundToggle').textContent = cfg.sound ? '♪' : '✕';
  bindToggle('rainToggle', 'rain', null, null, function () { Rain.setEnabled(cfg.rain); });

  /* theme: system | dark | light. "system" stores nothing and tracks the OS live. */
  var THEME_KEY = 'plankmatrix.theme';
  var themeBtns = document.querySelectorAll('.seg button[data-theme]');
  var sysLight = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
  var themeMode = 'system';
  try {
    var stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') themeMode = stored;
  } catch (e) {}

  function applyTheme() {
    var t = themeMode === 'system' ? (sysLight && sysLight.matches ? 'light' : 'dark') : themeMode;
    document.documentElement.dataset.theme = t;
    var tc = $('tc');
    if (tc) tc.content = t === 'light' ? '#dcece0' : '#000000';
    for (var i = 0; i < themeBtns.length; i++) {
      themeBtns[i].setAttribute('aria-pressed', String(themeBtns[i].dataset.theme === themeMode));
    }
    if (Rain) Rain.retheme();   // Rain is hoisted; undefined until its IIFE runs below
  }

  for (var ti = 0; ti < themeBtns.length; ti++) {
    themeBtns[ti].addEventListener('click', function () {
      themeMode = this.dataset.theme;
      applyTheme();
      try {
        if (themeMode === 'system') localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, themeMode);
      } catch (e) {}
    });
  }
  if (sysLight) {
    var onSys = function () { if (themeMode === 'system') applyTheme(); };
    if (sysLight.addEventListener) sysLight.addEventListener('change', onSys);
    else if (sysLight.addListener) sysLight.addListener(onSys);   // Safari < 14
  }
  applyTheme();

  // transport
  $('start').addEventListener('click', start);
  $('pause').addEventListener('click', function () { setPaused(!R.paused); });
  $('next').addEventListener('click', function () { skip(1); });
  $('prev').addEventListener('click', function () { skip(-1); });
  $('stop').addEventListener('click', stop);

  document.addEventListener('keydown', function (ev) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      if (!R.running) start(); else setPaused(!R.paused);
    } else if (R.running && ev.key === 'ArrowRight') skip(1);
    else if (R.running && ev.key === 'ArrowLeft') skip(-1);
    else if (R.running && ev.key === 'Escape') stop();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopRAF(); Rain.pause(); }
    else {
      Rain.play();
      if (R.running && !R.paused) {
        Audio_.resume(); Audio_.hold(true);
        R.off = null; pump(); startRAF();
      }
      requestWakeLock();
    }
  });

  /* ───────────────────────────────────────────────────── digital rain ── */

  var Rain = (function () {
    var cv = $('rain'), ctx = cv.getContext('2d', { alpha: false });
    var GLYPHS = 'ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789=*+-<>:.".';
    var atlas = document.createElement('canvas'), actx = atlas.getContext('2d');
    var W = 0, H = 0, dpr = 1, cell = 16, cols = 0;
    var y = null, sp = null, prev = null;
    var raf = 0, last = 0, interval = 1000 / 20, enabled = cfg.rain, visible = true;
    var fade = 'rgba(0,0,0,.055)';

    function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

    function buildAtlas() {
      var px = Math.round(cell * dpr);
      atlas.width = GLYPHS.length * px;
      atlas.height = px * 2;
      actx.clearRect(0, 0, atlas.width, atlas.height);
      actx.font = (px * 0.92) + 'px ui-monospace,Menlo,Consolas,monospace';
      actx.textAlign = 'center';
      actx.textBaseline = 'middle';
      var tail = css('--rain-tail') || '#00c235', head = css('--rain-head') || '#d8ffe4';
      for (var r = 0; r < 2; r++) {
        actx.fillStyle = r ? head : tail;
        for (var i = 0; i < GLYPHS.length; i++) {
          actx.fillText(GLYPHS[i], i * px + px / 2, r * px + px / 2);
        }
      }
      var f = css('--rain-fade') || '0,0,0', a = css('--fade-a') || '.055';
      fade = 'rgba(' + f + ',' + a + ')';
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      var w = cv.clientWidth || innerWidth, h = cv.clientHeight || innerHeight;
      W = Math.round(w * dpr); H = Math.round(h * dpr);
      if (cv.width !== W) cv.width = W;
      if (cv.height !== H) cv.height = H;
      cell = w < 420 ? 14 : 16;
      cols = Math.ceil(w / cell) + 1;
      y = new Float32Array(cols); sp = new Float32Array(cols); prev = new Int16Array(cols);
      for (var i = 0; i < cols; i++) {
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
      raf = requestAnimationFrame(draw);
      if (ts - last < interval) return;
      last = ts;
      var px = Math.round(cell * dpr), rows = H / px, i, r;
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, W, H);
      for (i = 0; i < cols; i++) {
        y[i] += sp[i];
        r = y[i] | 0;
        if (r !== prev[i] && r >= 0) {
          prev[i] = r;
          ctx.drawImage(atlas, ((Math.random() * GLYPHS.length) | 0) * px, px, px, px,
                        i * px, r * px, px, px);
        }
        if (y[i] > rows && Math.random() > 0.975) { y[i] = -Math.random() * 12; prev[i] = -999; }
      }
    }

    function run() {
      if (raf || !enabled || !visible) return;
      last = 0; raf = requestAnimationFrame(draw);
    }
    function halt() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    var rt = 0;
    addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 150); }, { passive: true });

    resize();
    cv.style.display = enabled ? 'block' : 'none';
    if (enabled) run();

    return {
      setEnabled: function (on) {
        enabled = on; cv.style.display = on ? 'block' : 'none';
        if (on) { resize(); run(); } else halt();
      },
      pause: function () { visible = false; halt(); },
      play: function () { visible = true; run(); },
      retheme: function () { if (!enabled) return; buildAtlas(); wipe(); }
    };
  })();

  /* ───────────────────────────────────────────────────────── startup ── */

  renderRows();
  show('setup');

  // small debug surface (used by tools/verify.mjs)
  window.__PLANK__ = { buildTimeline: buildTimeline, buildCues: buildCues, fmt: fmt,
                       parseDur: parseDur, speak: speak, cfg: cfg, R: R };

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
