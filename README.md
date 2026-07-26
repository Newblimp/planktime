# PLANK//MATRIX

A plank interval timer in the style of the Matrix, built to run from GitHub Pages
on a phone and keep calling out cues with the screen off.

```
 SEQUENCE ▸ front plank 2:00 · side plank left 0:30 · side plank right 0:30 · back plank 1:00
 CUES     ▸ every whole minute remaining · 30s · 10s · 5·4·3·2·1 · “switch — side plank left”
```

## Using it

Open the page, edit the sequence (name + duration per hold), hit **START**.

| Control | What it does |
|---|---|
| **Sequence** | Any number of holds. Each picks from front / side right / side left / back plank, or **Custom…** to type your own name. `+`/`−` step the time by 15s, or type `2:00` / `90`. |
| **∞ ↑ ↓ ⧉ ✕** | Per hold: make it open-ended, move it up or down the list, duplicate it, remove it. |
| **Preset** | Five ready-made routines; loading one replaces the sequence. |
| **Rounds** | Repeat the whole sequence *n* times. |
| **Rest between** | Optional rest segment inserted between holds (not after the last one). |
| **Lead-in** | Countdown before the first hold — 10s by default, enough room for a full 5·4·3·2·1. |
| **Cues** | *full* — every cue spoken. *minimal* — only the lines that say what to do next; the countdown stays a beep. *beeps only* — no speech. |
| **Screen** | Requests a screen wake lock so the phone doesn't dim mid-hold. |
| **♪ / ▚** | Mute, digital rain on/off. |
| **◐ ☾ ☀** | Theme: follow the system, force dark, force light. Following the system tracks it live, including a change made while the page is open. |

Mid-session, **−15s / +15s** stretches or trims the hold you are actually in —
the rest of the timeline shifts with it and the cues reschedule.

Keyboard: `space` start / pause, `←` `→` previous / next hold, `↑` `↓` ±15s,
`esc` end session. Lock-screen media controls (play/pause/next/previous) work too.

Your routine and theme are saved in `localStorage`, so the page comes back the way
you left it.

## Hold to failure

`∞` on a hold makes it open-ended. It counts **up** instead of down, calls the
elapsed time every 30 seconds, and waits — the session will not roll past it, no
matter how long you last. Tap **✓ Done** when you drop and the timer records what
it lasted, folds that into the "switch" call, re-lays the rest of the session
around the real number, and keeps your best under that hold in the editor.

The **Max hold test** preset is three open holds and nothing else.

## Cue schedule

For each hold, counted from the time remaining:

- every whole minute (`2:00` hold → "one minute remaining" at the 1:00 mark)
- `0:30` → "thirty seconds"
- `0:10` → "ten seconds"
- `5 · 4 · 3 · 2 · 1` ticks with the numbers spoken
- at zero: a chime plus "switch — *next hold*", or the finish fanfare on the last one

An open-ended hold has no zero to count down to, so it gets the opposite: the
elapsed time called every 30 seconds, until you end it.

Cues that don't fit are skipped rather than crowded: a 30-second hold gets the
10-second call and the final five, not "thirty seconds" the instant it starts.
A rest under 10 seconds is left silent after its opening line — counting one down
would talk over the only cue that says what is coming next.

Spoken lines are kept short and each new cue pre-empts any line still playing.
Browser speech synthesis *queues* utterances, so one long line will push every
short one after it late — which is how a 5·4·3·2·1 ends up compressed into the
last two seconds. A countdown number is worthless a second after its second, so
the newest cue always wins.

## Keeping time with the screen off

Phone browsers throttle or freeze JavaScript timers when the screen goes off, so
nothing here depends on a timer firing on time:

- **`performance.now()` is the clock.** It's monotonic and keeps counting while the
  page is frozen, so the timer is never "behind" — it's correct the instant the page
  gets a chance to run again.
- **Every cue is pre-scheduled on the Web Audio clock**, up to 120 seconds ahead.
  Once a beep is scheduled it is the audio thread's job, not JavaScript's, so cues
  fire on time even while the page itself is frozen.
- **A silent looping `<audio>` element** holds the OS media session open, which is
  what keeps the audio clock running with the screen locked. The session also
  publishes metadata + transport handlers, so the timer shows on the lock screen.
- **A `Worker` drives the tick loop**, since worker timers are throttled less than
  main-thread ones, and the main thread only paints while the page is visible.
- **The audio clock is re-anchored** to wall time whenever the OS suspends and
  resumes the context, and cues that were missed while parked are dropped instead
  of firing in a burst on wake.
- **A screen wake lock** is requested on start (toggleable), which on Android and
  iOS 16.4+ keeps the screen on and sidesteps the whole problem.

What this cannot survive: force-quitting the browser, or the OS reclaiming the tab
under memory pressure. Leave the tab in the foreground when you lock the screen.
Spoken lines depend on the platform's speech engine, which some browsers silence in
the background — the beeps are the reliable channel, and each cue type has its own
pattern (single, double, triple, tick, three-note switch, four-note finish).

## Performance notes

- No frameworks, no fonts, no network requests after first load — `index.html` +
  `app.js` + `core.js` are ~66 KB of source, ~21 KB gzipped over the wire, and a
  service worker precaches them for offline use.
- The cue pump walks only the window of cues that are actually due or schedulable,
  so a 20-round session with thousands of cues costs the same per tick as a
  four-minute one.
- The digital rain is the only animation: it renders from a pre-rasterised glyph
  atlas via `drawImage`, caps at 20 fps, halts entirely when the tab is hidden or
  disabled, and defaults off under `prefers-reduced-motion`.
- The running view repaints from `requestAnimationFrame` but writes to the DOM only
  when a displayed value actually changes; progress uses `stroke-dashoffset` and a
  `transform`, so there's no layout work per frame.

## Publishing to GitHub Pages

Everything is static, in the repository root, so no build step is involved:
**Settings → Pages → Deploy from a branch**, `main` / `(root)`. Every push to
`main` republishes the site, usually within a minute.

Then open the URL on your phone and, optionally, *Add to Home Screen* — the app has
a manifest and works offline, and standalone mode gives it the full screen.

Serving locally works too: `npx http-server -p 8099 -s .` (a service worker needs
`https` or `localhost`).

## Development

```
npm test              # everything
npm run test:unit     # 44 checks on the pure core + asset lists — ~0.2s, no browser
npm run test:e2e      # 121 checks in a real browser — ~90s, boots its own server
npm run serve         # http://127.0.0.1:8099 for hand-testing
npm run icons         # regenerate the PNG icons from the shapes in icon.svg
```

`core.js` holds every pure function — the timeline, the cue schedule, formatting,
config migrations — so they can be tested in Node without a browser. `app.js` holds
everything that touches the world. `test:e2e` needs Playwright and Chromium
(`npx playwright install chromium`); pass a base URL to point it at a server you
are already running instead of the one it starts.

`CLAUDE.md` documents the invariants that keep the timer accurate with the screen
off. Read it before changing anything in the run loop.
