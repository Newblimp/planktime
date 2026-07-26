# Working on PLANK//MATRIX

A plank interval timer. Static files in the repo root, no build step, deployed
straight from `main` to GitHub Pages. Read `README.md` for what the app does.

## Commands

```
npm test          # everything (unit + assets ~0.2s, then e2e ~90s)
npm run test:unit # node --test on the pure core and the asset lists — fast, run this constantly
npm run test:e2e  # Playwright; boots its own server, no separate terminal needed
npm run serve     # http://127.0.0.1:8099 for hand-testing
npm run icons     # regenerate the PNG icons from icon.svg
```

`test:e2e` needs Playwright and Chromium (`npx playwright install chromium`).
Pass a base URL to point it at a server you are already running.

## Layout

| File | What lives there |
|---|---|
| `core.js` | Pure functions only: timeline, cue schedule, formatting, config normalisation. No DOM, no audio, no storage, no clock. |
| `app.js` | Everything that touches the world: audio graph, speech, the run loop, the DOM, storage, wake lock, media session, the rain canvas. |
| `index.html` | Markup + all CSS. Theme tokens live in `:root` / `:root[data-theme=light]`. |
| `sw.js` | Offline precache. `ASSETS` is hand-written — see below. |
| `tools/core.test.mjs` | Unit checks for `core.js`. |
| `tools/assets.test.mjs` | Guards against `sw.js` drifting from what the app actually loads. |
| `tools/verify.mjs` | End-to-end checks for the things only a browser can prove. |

**Put new logic in `core.js` if it can be pure.** That is what keeps the fast
test tier useful; anything stranded in `app.js` can only be tested through a
browser launch.

## Invariants — breaking these breaks the whole point of the app

1. **`performance.now()` is the only clock.** It is monotonic and keeps counting
   while the page is frozen. Never derive elapsed time from `Date.now()`, from a
   timer's own firing, or from the audio clock.
2. **Never drive a cue from `setTimeout`/`setInterval`.** Phone browsers throttle
   or freeze JS timers with the screen off. Every audible cue must be
   pre-scheduled onto the Web Audio clock in `pump()`, up to `LOOKAHEAD` seconds
   ahead. The tick loop only decides *what to schedule*; it is never what makes a
   cue fire on time.
3. **The pump re-anchors after a suspend.** `R.off` maps timeline time onto
   `AudioContext.currentTime`; the OS can suspend and resume the context, which
   moves that mapping. Cues woken up late (`> 1.2s`) are dropped, not fired in a
   burst.
4. **Completion is checked even when audio is missing or parked.** A session that
   ends while the audio context is asleep must still return to setup.
5. **Every new cue needs a `rank`** — `'edge'` (says what to do next) or `'num'`
   (countdown). The cue-level setting filters on it.
6. **A newer spoken cue always pre-empts an older one.** Utterances queue, so a
   long line would push every short one after it late, and a countdown number is
   worthless a second after its second. If you add a line, keep it short enough
   to finish before the next cue.
7. **Adding a file means adding it to `ASSETS` in `sw.js`** and bumping `CACHE`.
   `tools/assets.test.mjs` fails if you forget.
8. **`buildTimeline` overrides are keyed by segment index**, and overrides never
   change the number or order of segments. That stability is what lets a live
   ±15s and a measured open hold both just rebuild the timeline in place.

## Conventions

- No frameworks, no dependencies at runtime, no network requests after first
  load. Keep it that way — the whole app is ~21 KB gzipped.
- ES modules and modern syntax are fine; every browser with Web Audio has them.
- The run view repaints from `requestAnimationFrame` but writes to the DOM only
  when a displayed value actually changes. Keep new UI on that pattern, and keep
  per-frame work off the layout path (`transform`, `stroke-dashoffset`).
- Secondary text uses `--dim`, which is tuned to clear 4.5:1 on both themes.
  Check contrast before changing a colour token.
- Storage shape changes need a `SCHEMA` bump in `core.js` and a migration in
  `normalize()`, keyed off the stored `v`. Add a unit test for the migration.
