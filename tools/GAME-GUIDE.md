# Fret Arcade: how a game is built

Fret Arcade is a set of small guitar-learning games that share one shell. It is
plain ES modules, no build step, no frameworks. A phone held in landscape is
the target; the shell scales one fixed stage to whatever screen it is on.

## Layout of the project

```
index.html            dev page (served by tools/serve.mjs on port 4747)
css/app.css           design tokens and every shared style
js/main.js            shell: stage scaling, hub (pedalboard), routing, progress
js/core/util.js       rng (seeded), dailySeed, dayNumber, lifecycle, TEST.fast
js/core/theory.js     tuning, note names, intervals, scales, chord() spelling
js/core/fretboard.js  createFretboard(): the shared SVG neck (API in its header)
js/core/audio.js      audio.pluck / strum / sfx / drum kit / clock (API in comments)
js/core/mic.js        optional real-guitar pitch input
js/core/store.js      settings, bests, heat map, streak (localStorage, safe)
js/core/ui.js         h(), button, segmented, gameScreen, intro, results, ... (API in header)
js/core/net.js        other players: shared score cards and the live room (optional, see below)
js/core/boards.js     score boards that include real players
js/games/<id>.js      one file per game; fret-sprint.js is the reference
js/games/live-duel-online.js   Live Duel's two-device mode
js/games/index.js     registry (do not edit)
tools/shot.mjs        headless screenshot + scripted play
tools/mock-claude.js  local stand-in for the shared page's runtime (?mock=name)
tools/online-check.mjs  two pretend players: a full online match, boards, access levels
tools/build.mjs       bundles everything into dist/fret-arcade.html for publishing
```

Read `js/games/fret-sprint.js` first, then the header comments of
`fretboard.js`, `ui.js`, `audio.js`, `store.js`, `theory.js`, `util.js`.

## The stage

- Always **844 x 390 px**. `gameScreen()` gives you a 44 px HUD and a
  **844 x 346 px body**. Lay out in plain px. Nothing may overflow or scroll.
- The default fretboard is 812 x 208 (6 strings, 31 px rows, frets 0-12). Dock it
  at the bottom of the body with 16 px side padding, as Fret Sprint does. Pass
  `strings`, `rowH`, `width` for other shapes.
- String index 0 = low E ... 5 = high E. The neck is drawn high E on top.
- Touch first: gameplay reacts on `pointerdown` (the fretboard already does).
  Tappable things are at least 40 px in one dimension. No hover-only cues, no
  keyboard, no text inputs.

## A game module

```js
export default {
  id: 'my-game',              // must match the file name and the stub it replaces
  title: 'My Game',
  kind: 'three or four words', // shown on the hub pedal
  color: 'var(--surf)',        // keep the colour already in your stub
  knobs: [-40, 30],            // keep from the stub
  pedal: ['Two', 'Lines'],     // optional: pedal label lines if the title is long
  readout() {},                // short text (max ~7 chars) for the pedal display, or null
  mount(root, app) {           // build everything; return a function that cleans up
    // app.exit() goes back to the hub
  },
}
```

Flow every game follows: `ui.intro` (start screen with up to 3 short steps and
up to 4 option rows) -> play -> `ui.results` (with "Again" as the primary
action and "Options" to return to the intro). Use `lifecycle()` from util.js
for every timer, loop and listener, and dispose it in the function `mount`
returns. Stop audio clocks and `mic.stop()` there too.

Keep your styles in the game file via `ui.injectCSS(id, css)` and prefix class
names (Fret Sprint uses `.fs-`).

## Look and feel (keep it consistent)

- Clean, flat, a little retro. One loud element per screen: the dark
  **`.display`** panel (a tuner-style dot-matrix screen) that holds the main
  prompt. Everything else stays quiet.
- Type: big text inside the display uses class **`dot`** (the dot-matrix face).
  Only use `dot` at 40 px or larger; it is unreadable small. Everything else is
  the label face (`var(--font-label)`, caps, tracked) or body face. Small caps
  captions: class `stat-label`; inside a display use class `dim` for captions.
- Note and chord names go through `ui.noteEl()` / `ui.noteHTML()` so sharps and
  flats render properly.
- Colour only through CSS variables: `--bg --surface --surface-2 --ink --ink-2
  --ink-3 --edge --shadow --board --board-ink --lcd-bg --lcd-ink --lcd-dim`,
  the game's own `--game` (text on it: `--on-game`), and meaning colours
  `--good --bad --warn`. Never hard-code a colour; both light and dark themes
  must work.
- Controls: `ui.button` (one `primary` per view), `ui.segmented`, `ui.bar`,
  `ui.lives` (guitar picks), `ui.toast`, `ui.countdown`.
- Fretboard feedback: `fb.flash(s, f, 'good' | 'bad')`, `fb.mark(...)` kinds
  `accent good bad warn ink ghost off`, `fb.link` for lines between notes.
- Sound: tapping the neck already plucks the note. Use `audio.sfx('good')`,
  `'bad'`, `'great'`, `'level'`, `'win'`, `'lose'`, `'tick'` for feedback.
- Motion is short (under 250 ms) and means something. Global keyframes you can
  reuse: `pop`, `rise`, `fade`, `bump`.
- Words: plain and short, written to the player ("Tap it on the neck"). Source
  text in sentence case; labels are upper-cased by CSS. No emoji in the
  interface (emoji are fine inside copied share text). Any computer opponent is
  labelled CPU, never dressed up as a real person.

## Progress hooks

- `store.get(id, key, fallback)` / `store.set(id, key, value)` for options,
  stats, ratings, daily state.
- `store.recordRun(id, score, { mode })` when a run or match ends (drives the
  streak and "played today" light).
- `store.recordNote(s, f, ok, ms)` whenever the player is asked to find or name
  the note at one specific spot (feeds the shared heat map).
- Daily modes use `rng(dailySeed(id))` so everyone gets the same puzzle, and
  `dayNumber()` for "#16".
- `ui.houseScores(seed, {...})` + `ui.rankWith(...)` give a CPU-tagged board to
  rank against.

## Other players (optional, never required)

The published page can be given three things by the platform: who is looking
(`user`), a small shared store (`db`) and everyone who has the page open now
(`room`). `core/net.js` wraps them. On the local copy, on any other host, or
when one is refused, that part stays off and every game still works alone.

- A game joins the shared boards by adding two members to its module:
  `boards: { day: { title, unit, lower, fmt }, best: {...} }` and
  `scores()` returning `{ day, best }` from this browser's progress
  (`day` = today's score in the daily mode, `best` = all-time). The shell
  gathers these into one small card per player and `net` shares it.
- In a results panel use `resultsBoard({ gameId, kind: 'day', you, cpu })` from
  `core/boards.js` as the `board`: real players first, CPU rows as filler.
- Live play uses presence only (`net.room.set`, `others`, `onPeers`), never
  events, so people with view-only access can take part. Presence is whole
  state: write what is true now, and make every reader safe against a missed
  update. Everything read from another player is cleaned before use.
- Who can do what is decided by the page's sharing settings, not by the code:
  the owner (and people given edit or contributor access) save scores; others
  can read the board, and their scores show while they are in the room and are
  saved by the owner's page when it is open too.
- Try it locally with `http://localhost:4747/?mock=ann` in one tab and
  `?mock=bob` in another (see `tools/mock-claude.js` for `&viewer`, `&owner`,
  `&lag=150`). `node tools/online-check.mjs` runs the whole thing headless.

## Publishing

There are two live copies, and they update in different ways.

- **GitHub Pages** serves the repository as it is (branch `main`, root folder),
  so a push updates it within a minute. Nothing is built. `index.html` only
  loads `tools/mock-claude.js` on localhost.
- **The claude.ai copy** is the one-file bundle: run `node tools/build.mjs`
  and publish `dist/fret-arcade.html` to the same page as before, so its link
  and its saved scores are kept. The page declares these abilities, which carry
  forward when a publish leaves them out:

  ```json
  {
    "db": { "rules": [
      { "path": "players", "read": "view", "write": "owner" },
      { "path": "players/{self}", "write": "interact" }
    ] },
    "user": { "scopes": ["profile"] },
    "room": {}
  }
  ```

  One document per player lives at `players/<their id>`. Everyone admitted can
  read them; each person writes only their own; the owner can write any, which
  is how the owner's page saves scores for people with view-only access.

## Checking your work

The dev server is **already running on port 4747. Do not start another.**

```
node --check js/games/<id>.js
node tools/shot.mjs <id> <out.png>                      # start screen
node tools/shot.mjs <id> <out.png> --js "tapText('start'); await sleep(2500);"
node tools/shot.mjs <id> <out.png> --dark ...           # dark theme
node tools/shot.mjs <id> <out.png> --fast ...           # ?fast: honour TEST.fast to shorten long timers
node tools/shot.mjs <id> <out.png> --js-file script.js  # longer scripted play
```

Inside `--js` you have `tap(selector)`, `tapText('button text')`,
`cell(string, fret)` (taps a fretboard cell), `sleep(ms)`, and whatever you
`return` is printed. The tool prints console errors and exits non-zero if
there were any. Open the PNG with the Read tool and actually look at it:
check for overflow, overlap, clipped text, unreadable contrast, tiny type.

Before you report back: no console errors; start, mid-play and end screens
checked in light theme and at least one in dark; a scripted play-through that
proves scoring, win and loss paths work; `mount`'s cleanup leaves no timers
or sound running after leaving for the hub.

Only edit your own game file. The core files are shared with other people
working in parallel; if something in the core is missing or wrong, work around
it in your file and say so in your report.
