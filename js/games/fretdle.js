// Fretdle: a daily chord puzzle, Wordle on a fretboard.
//
// A hidden four-note chord voicing sits on the top four strings (D G B E),
// one note per string. A guess is one fret on each string. Feedback is by
// pitch class, so any octave of the right note counts:
//   green  = right note on this string
//   yellow = that note is in the chord, on another string
//   grey   = that note is not in the chord
//
//   intro -> play (six guesses) -> finished board -> results overlay.
// Daily keeps today's guesses and the stats in the store; practice is endless.

import { rng, dailySeed, dayNumber, todayKey, lifecycle, TEST } from '../core/util.js';
import { chord, midiAt, pcAt, pcName, STRING_LETTERS } from '../core/theory.js';
import { audio } from '../core/audio.js';
import { store } from '../core/store.js';
import { createFretboard } from '../core/fretboard.js';
import * as ui from '../core/ui.js';

const ID = 'fretdle';
const { h } = ui;

const STRINGS = [2, 3, 4, 5]; // D G B high E; a guess is [fret, fret, fret, fret] in this order
const ROWS = [3, 2, 1, 0]; // indexes into STRINGS, top of the screen first (high E on top)
const MAX_GUESSES = 6;
const SETS = { triads: ['maj', 'min'], sevenths: ['7', 'maj7', 'm7'], both: ['maj', 'min', '7', 'maj7', 'm7'] };
const SET_LABELS = { triads: 'Triads', sevenths: 'Sevenths', both: 'Triads and sevenths' };
// While the chord is unknown every note gets one fixed everyday name, so the
// spelling never gives the chord away. Once the name is out we spell for it.
const PLAIN = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const STEP = TEST.fast ? 20 : 80; // delay between tiles turning over
const FLIP = TEST.fast ? 60 : 240; // one tile turning over
const RESULTS_AFTER = TEST.fast ? 250 : 2100;

// ---- the puzzle ---------------------------------------------------------------

/**
 * Every playable way to put this chord on the top four strings: all chord
 * tones present, nothing else, fretted notes within a four-fret hand span.
 * Open strings are only mixed in down in open position, never against a
 * shape high up the neck.
 */
function voicings(ch) {
  const out = [];
  const f = [0, 0, 0, 0];
  const ok = (i) => ch.pcs.includes(pcAt(STRINGS[i], f[i]));
  for (f[0] = 0; f[0] <= 12; f[0]++) {
    if (!ok(0)) continue;
    for (f[1] = 0; f[1] <= 12; f[1]++) {
      if (!ok(1)) continue;
      for (f[2] = 0; f[2] <= 12; f[2]++) {
        if (!ok(2)) continue;
        for (f[3] = 0; f[3] <= 12; f[3]++) {
          if (!ok(3)) continue;
          if (new Set(f.map((x, i) => pcAt(STRINGS[i], x))).size !== ch.pcs.length) continue;
          const fretted = f.filter((x) => x > 0);
          if (fretted.length) {
            const hi = Math.max(...fretted);
            if (hi - Math.min(...fretted) > 3) continue;
            if (fretted.length < 4 && hi > 4) continue;
          }
          out.push(f.slice());
        }
      }
    }
  }
  return out;
}

function makePuzzle(r, set) {
  const root = r.int(12);
  const type = r.pick(SETS[set] || SETS.both);
  const ch = chord(root, type);
  return { ch, frets: r.pick(voicings(ch)) };
}

const pcsOf = (frets) => frets.map((f, i) => pcAt(STRINGS[i], f));

/**
 * Note names once the chord is known: chord tones as the chord spells them,
 * every other note in sharps or flats to match (theory.js would mix them,
 * e.g. E♭ beside the A♯ of F♯7).
 */
function speller(ch) {
  const sharps = ch.notes.some((n) => n.includes('♯'));
  const flats = ch.notes.some((n) => n.includes('♭'));
  return (pc) => {
    const i = ch.pcs.indexOf(pc);
    if (i >= 0) return ch.notes[i];
    return sharps === flats ? PLAIN[pc] : pcName(pc, sharps ? 'sharp' : 'flat');
  };
}

/** Wordle marking with its usual rule for repeated notes. -> ['good' | 'warn' | 'off'] x 4 */
function judge(guessPcs, answerPcs) {
  const res = ['off', 'off', 'off', 'off'];
  const spare = new Map();
  for (let i = 0; i < 4; i++) {
    if (guessPcs[i] === answerPcs[i]) res[i] = 'good';
    else spare.set(answerPcs[i], (spare.get(answerPcs[i]) || 0) + 1);
  }
  for (const i of ROWS) {
    // top string first, the way a column reads
    if (res[i] === 'good') continue;
    const n = spare.get(guessPcs[i]) || 0;
    if (n > 0) {
      res[i] = 'warn';
      spare.set(guessPcs[i], n - 1);
    }
  }
  return res;
}

/** Everything the guesses so far have proved. */
function learn(guesses, marks) {
  const kn = {
    green: [null, null, null, null], // pitch class known for each string
    greenFret: [null, null, null, null], // where the player found it
    notHere: [0, 1, 2, 3].map(() => new Set()), // pitch classes ruled out per string
    yellowAt: [0, 1, 2, 3].map(() => new Set()),
    min: new Map(), // pc -> at least this many in the chord
    exact: new Map(), // pc -> exactly this many (known once one copy came back grey)
    placed: (pc) => kn.green.filter((g) => g === pc).length,
  };
  guesses.forEach((g, n) => {
    const seen = new Map();
    pcsOf(g).forEach((pc, i) => {
      const m = marks[n][i];
      if (m === 'good') {
        kn.green[i] = pc;
        kn.greenFret[i] = g[i];
      } else {
        kn.notHere[i].add(pc);
        if (m === 'warn') kn.yellowAt[i].add(pc);
      }
      const c = seen.get(pc) || [0, 0];
      c[0] += 1;
      if (m !== 'off') c[1] += 1;
      seen.set(pc, c);
    });
    seen.forEach(([count, coloured], pc) => {
      kn.min.set(pc, Math.max(kn.min.get(pc) || 0, coloured));
      if (coloured < count) kn.exact.set(pc, coloured);
    });
  });
  return kn;
}

/** What is known about one note on one string: 'good' | 'out' | 'in' | ''. */
function cellState(kn, i, pc) {
  if (kn.green[i] === pc) return 'good';
  if (kn.green[i] != null || kn.notHere[i].has(pc)) return 'out';
  const placed = kn.placed(pc);
  if (kn.exact.has(pc) && placed >= kn.exact.get(pc)) return 'out';
  if ((kn.min.get(pc) || 0) > placed) return 'in';
  return '';
}

/** What is known about a note anywhere: 'good' (placed) | 'warn' (in, not placed) | 'off' | ''. */
function noteState(kn, pc) {
  const placed = kn.placed(pc);
  if ((kn.min.get(pc) || 0) > placed) return 'warn';
  if (placed) return 'good';
  if (kn.exact.get(pc) === 0) return 'off';
  return '';
}

// ---- stats --------------------------------------------------------------------

const statsKey = (daily) => (daily ? 'stats' : 'practice-stats');
function readStats(daily) {
  const st = { played: 0, wins: 0, streak: 0, best: 0, dist: [0, 0, 0, 0, 0, 0], lastWin: null, ...store.get(ID, statsKey(daily), {}) };
  st.dist = Array.from({ length: MAX_GUESSES }, (_, i) => Number(st.dist?.[i]) || 0);
  return st;
}
/** A daily streak only counts while it is still alive (won today or yesterday). */
function liveStreak(st, daily) {
  if (!daily) return st.streak;
  return st.lastWin != null && st.lastWin >= dayNumber() - 1 ? st.streak : 0;
}
function recordStats(daily, won, used) {
  const st = readStats(daily);
  st.played += 1;
  if (won) {
    st.wins += 1;
    st.dist[used - 1] += 1;
    st.streak = daily ? (st.lastWin === dayNumber() - 1 ? st.streak + 1 : 1) : st.streak + 1;
    st.lastWin = dayNumber();
    st.best = Math.max(st.best, st.streak);
  } else {
    st.streak = 0;
  }
  store.set(ID, statsKey(daily), st);
  return st;
}

function todaysSave() {
  const s = store.get(ID, 'daily', null);
  if (!s || s.key !== todayKey() || !Array.isArray(s.guesses)) return null;
  const guesses = s.guesses.filter((g) => Array.isArray(g) && g.length === 4 && g.every((f) => Number.isInteger(f) && f >= 0 && f <= 12)).slice(0, MAX_GUESSES);
  return { ...s, guesses };
}

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

// ---- styles -------------------------------------------------------------------

const CSS = `
.fd-mode { font: 600 12px/1 var(--font-label); letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-2); }
.fd-play { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 0 16px 4px; }
.fd-top { flex: 1; min-height: 0; display: flex; align-items: center; gap: 18px; padding-bottom: 4px; }

.fd-hist { display: flex; gap: 5px; align-items: flex-end; }
.fd-gutter, .fd-col { display: flex; flex-direction: column; gap: 4px; align-items: center; }
.fd-gutter { width: 11px; }
.fd-gutter span { height: 31px; display: grid; place-items: center; font: 700 11px/1 var(--font-label); color: var(--ink-3); }
.fd-col-n { height: 11px; font: 700 10px/11px var(--font-label); letter-spacing: 0.08em; color: var(--ink-3); opacity: 0.7; }
.fd-col.is-active .fd-col-n { color: var(--ink); opacity: 1; }
.fd-tile { width: 46px; height: 31px; border-radius: 7px; border: 2px solid var(--surface-2); display: grid; place-items: center; font: 700 17px/1 var(--font-label); letter-spacing: 0.02em; color: var(--ink); }
.fd-col.is-active .fd-tile { border-color: var(--ink-3); }
.fd-col.is-active .fd-tile.is-set { background: var(--surface); border-color: var(--edge); }
.fd-tile.is-pop { animation: fd-set 0.13s ease-out; }
.fd-tile.is-good, .fd-tile.is-warn, .fd-tile.is-off { border-color: var(--edge); color: var(--on-game); }
.fd-tile.is-good { background: var(--good); }
.fd-tile.is-warn { background: var(--warn); }
.fd-tile.is-off { background: var(--board-off); color: var(--board-ink); }
.fd-tile.is-flip { animation: fd-flip ${FLIP}ms ease-in-out backwards; animation-delay: calc(var(--i) * ${STEP}ms); }

.fd-side { flex: 1; min-width: 0; display: grid; grid-template-columns: 1fr 166px; gap: 9px 10px; align-content: center; }
.fd-display { height: 104px; padding: 0 18px; display: flex; flex-direction: column; justify-content: center; gap: 6px; overflow: hidden; }
.fd-cap, .fd-sub { font: 600 12px/1 var(--font-label); letter-spacing: 0.16em; text-transform: uppercase; white-space: nowrap; }
.fd-sub { color: var(--lcd-ink); opacity: 0.85; }
.fd-big { font-size: 46px; line-height: 1; white-space: nowrap; }
.fd-big.is-count { text-transform: uppercase; }
.fd-big.is-new { animation: pop 0.16s ease-out; transform-origin: left center; }
.fd-btns { display: flex; flex-direction: column; justify-content: center; gap: 9px; }
.fd-btns .btn-big { width: 100%; padding: 0; }
.fd-btns .btn-small { width: 100%; height: 34px; padding: 0; }
.fd-btns .btn.is-ready { animation: fd-ready 0.22s ease-out; }
.fd-hint-note { height: 34px; display: grid; place-items: center; font: 600 11px/1 var(--font-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); }

.fd-notes { grid-column: 1 / -1; display: flex; gap: 4px; }
.fd-chip { flex: 1; height: 27px; border-radius: 7px; border: 1.5px solid var(--ink-3); display: grid; place-items: center; font: 700 13.5px/1 var(--font-label); color: var(--ink-2); }
.fd-chip.is-good, .fd-chip.is-warn { border-color: var(--edge); color: var(--on-game); }
.fd-chip.is-good { background: var(--good); }
.fd-chip.is-warn { background: var(--warn); }
.fd-chip.is-off { background: var(--board-off); border-color: var(--board-off); color: var(--board-ink); opacity: 0.55; }
.fd-chip.is-new { animation: fd-set 0.16s ease-out; }

.fd-off { opacity: 0.8; }
.fd-small .fb-mk-in { transform: scale(1.12); }
.fd-small text { font-size: 10.5px; }
.fd-open-off { fill: var(--ink-3) !important; opacity: 0.3; }

.fd-res-display { align-items: center; gap: 16px; }
.fd-res-chord { display: flex; flex-direction: column; gap: 5px; font-family: var(--font-label); font-weight: 600; }
.fd-res-chord > b { font: 700 27px/1 var(--font-label); letter-spacing: 0.03em; }
.fd-res-chord > span { font-size: 12px; line-height: 1; letter-spacing: 0.14em; text-transform: uppercase; color: var(--lcd-dim); white-space: nowrap; }
.fd-dist { display: flex; flex-direction: column; gap: 5px; }
.fd-dist-row { display: grid; grid-template-columns: 10px 1fr; gap: 8px; align-items: center; font: 700 13px/1 var(--font-label); color: var(--ink-2); }
.fd-dist-bar { height: 19px; min-width: 24px; border-radius: 5px; background: var(--surface-2); display: flex; align-items: center; justify-content: flex-end; padding: 0 7px; color: var(--ink); font-variant-numeric: tabular-nums; }
.fd-dist-row.is-now .fd-dist-bar { background: var(--good); color: var(--on-game); outline: 1.5px solid var(--edge); }
.fd-side-note { margin-top: auto; font: 600 11px/1.3 var(--font-label); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }

@keyframes fd-set { from { transform: scale(1.18); } }
@keyframes fd-ready { 40% { transform: scale(1.05); } }
@keyframes fd-flip {
  0% { transform: scaleY(1); background: var(--surface); color: var(--ink); }
  49% { transform: scaleY(0.04); background: var(--surface); color: var(--ink); }
  51% { transform: scaleY(0.04); }
  100% { transform: scaleY(1); }
}
`;

// ---- the game -----------------------------------------------------------------

const game = {
  id: ID,
  title: 'Fretdle',
  kind: 'Daily chord puzzle',
  color: 'var(--butterscotch)',
  knobs: [20, -50],
  boards: {
    day: { title: 'Today', unit: 'guesses', lower: true, fmt: (v) => (v > MAX_GUESSES ? `X/${MAX_GUESSES}` : `${v}/${MAX_GUESSES}`) },
    best: { title: 'Best streak', unit: 'days in a row' },
  },
  /** This browser's scores for the shared boards: today's guess count (7 = not solved) and the best daily streak. */
  scores() {
    const s = store.get(ID, 'daily', null);
    const done = s && s.key === todayKey() && s.over && Array.isArray(s.guesses);
    return { day: done ? (s.won ? s.guesses.length : MAX_GUESSES + 1) : null, best: readStats(true).best || null };
  },
  /** Current daily streak for the pedal's display, once there has been a win. */
  readout() {
    const st = readStats(true);
    if (!st.wins) return null;
    const n = liveStreak(st, true);
    return `${n} DAY${n === 1 ? '' : 'S'}`;
  },

  mount(root, app) {
    ui.injectCSS(ID, CSS);
    let run = null; // lifecycle of the puzzle on screen: its timers and its overlay
    const scr = ui.gameScreen(root, game, { onBack: app.exit });
    const cfg = { run: 'daily', set: 'both', names: 'on', ...store.get(ID, 'cfg', {}) };
    const saveCfg = () => store.set(ID, 'cfg', cfg);
    const clearOverlays = () => scr.el.querySelectorAll('.overlay').forEach((o) => o.remove());

    function showIntro() {
      run?.dispose();
      run = null;
      clearOverlays();
      scr.hud.setStats([]);
      scr.hud.mid.replaceChildren();
      const daily = cfg.run === 'daily';
      const today = daily ? todaysSave() : null;
      const options = [
        ui.segmented({
          label: 'Puzzle',
          options: [
            { value: 'daily', label: `Daily #${dayNumber()}` },
            { value: 'practice', label: 'Practice' },
          ],
          value: cfg.run,
          onChange: (v) => {
            cfg.run = v;
            saveCfg();
            showIntro();
          },
        }),
      ];
      if (!daily) {
        options.push(
          ui.segmented({
            label: 'Chords',
            options: [
              { value: 'triads', label: 'Triads' },
              { value: 'sevenths', label: 'Sevenths' },
              { value: 'both', label: 'Both' },
            ],
            value: cfg.set,
            onChange: (v) => {
              cfg.set = v;
              saveCfg();
            },
          }),
        );
      }
      options.push(
        ui.segmented({
          label: 'Note names on your dots',
          options: [
            { value: 'on', label: 'Names on' },
            { value: 'off', label: 'Off (harder)' },
          ],
          value: cfg.names,
          onChange: (v) => {
            cfg.names = v;
            saveCfg();
          },
        }),
      );
      const st = readStats(daily);
      let best = null;
      if (daily && st.wins) best = { label: 'Daily streak', value: days(liveStreak(st, true)) };
      else if (!daily && st.played) best = { label: 'Practice solved', value: `${st.wins} of ${st.played}` };
      ui.intro(scr, {
        title: 'Fretdle',
        tagline: daily ? 'One hidden chord a day on the top four strings. Six guesses to find it.' : 'A fresh hidden chord on the top four strings, as often as you like.',
        steps: ['Tap one fret on each of the four strings, then strum your guess.', 'Green: right note on that string. Yellow: in the chord, but on another string. Grey: not in the chord.', 'The answer is always a real, playable shape. Name the chord, then find it.'],
        options,
        best,
        startLabel: today?.guesses.length ? (today.over ? 'See the board' : 'Carry on') : 'Start',
        onStart: () => start(),
      });
    }

    function start() {
      run?.dispose();
      run = lifecycle();
      clearOverlays();

      const daily = cfg.run === 'daily';
      const mode = daily ? 'daily' : 'practice';
      const showNames = cfg.names !== 'off';
      const dayKey = todayKey();
      const number = dayNumber();
      const { ch, frets: answer } = makePuzzle(rng(daily ? dailySeed(ID) : undefined), daily ? 'both' : cfg.set);
      const answerPcs = pcsOf(answer);
      if (TEST.fast) window.__fretdle = { answer: answer.slice(), name: ch.name }; // test-only peek, never set in normal play

      // ---- puzzle state ----
      const saved = daily ? todaysSave() : null;
      const guesses = saved ? saved.guesses.map((g) => g.slice()) : [];
      const marks = guesses.map((g) => judge(pcsOf(g), answerPcs));
      let hinted = !!saved?.hinted;
      let scored = !!saved?.scored;
      let over = false;
      let won = false;
      let busy = false;
      let kn = learn(guesses, marks);
      let pick = [null, null, null, null];
      let res = null; // the results overlay, while it is open
      let resultsSeen = false;

      const settle = () => {
        won = marks.length > 0 && marks[marks.length - 1].every((m) => m === 'good');
        over = won || guesses.length >= MAX_GUESSES;
      };
      const persist = () => {
        if (daily) store.set(ID, 'daily', { key: dayKey, guesses, hinted, scored, over, won });
      };
      const score = () => {
        if (scored) return;
        scored = true;
        recordStats(daily, won, guesses.length);
        store.recordRun(ID, won ? guesses.length : 7, { mode, lowerIsBetter: true });
      };
      const spelled = speller(ch);
      const nm = (pc) => (hinted || over ? spelled(pc) : PLAIN[pc]); // spell for the chord once its name is out
      const midis = (frets) => frets.map((f, i) => midiAt(STRINGS[i], f));
      const shownShape = () => (won ? guesses[guesses.length - 1] : answer); // a win keeps the dots where the player put them
      const preset = () => kn.greenFret.slice(); // each new guess starts with what is already green

      // ---- build the play screen ----
      scr.hud.mid.replaceChildren(h('span', { class: 'fd-mode' }, daily ? `Daily #${number}` : `Practice: ${SET_LABELS[cfg.set] || SET_LABELS.both}`));
      scr.hud.setStats([{ key: 'streak', label: daily ? 'Day streak' : 'Win streak', value: liveStreak(readStats(daily), daily) }]);

      const cols = [];
      const hist = h('div', { class: 'fd-hist' }, h('div', { class: 'fd-gutter' }, ROWS.map((i) => h('span', null, STRING_LETTERS[STRINGS[i]]))));
      for (let c = 0; c < MAX_GUESSES; c++) {
        const tiles = [];
        const el = h('div', { class: 'fd-col' }, h('span', { class: 'fd-col-n' }, String(c + 1)));
        for (const i of ROWS) {
          tiles[i] = h('div', { class: 'fd-tile' });
          el.append(tiles[i]);
        }
        cols.push({ el, tiles });
        hist.append(el);
      }

      const capEl = h('span', { class: 'fd-cap dim' });
      const bigEl = h('span', { class: 'fd-big dot' });
      const subEl = h('span', { class: 'fd-sub' });
      const chips = PLAIN.map(() => h('span', { class: 'fd-chip' }));
      const btnBox = h('div', { class: 'fd-btns' });
      const strumBtn = ui.button('Strum', { kind: 'primary', cls: 'btn-big', sound: null, onClick: submit });
      const hintBtn = ui.button('Reveal chord name', { small: true, onClick: useHint });
      const hintNote = h('span', { class: 'fd-hint-note' });
      const resultsBtn = ui.button('Results', { kind: 'primary', cls: 'btn-big', onClick: openResults });
      const hearBtn = ui.button('Hear it', { small: true, sound: null, onClick: () => audio.strum(midis(shownShape()), { gap: 0.05 }) });

      const play = h(
        'div',
        { class: 'fd-play' },
        h(
          'div',
          { class: 'fd-top' },
          hist,
          h('div', { class: 'fd-side' }, h('div', { class: 'display fd-display' }, capEl, bigEl, subEl), btnBox, h('div', { class: 'fd-notes', role: 'img', 'aria-label': 'What you know about each of the twelve notes' }, chips)),
        ),
      );
      scr.body.replaceChildren(play);
      const fb = createFretboard(play, { strings: STRINGS, rowH: 38, onTap });

      // ---- painting: every view is drawn from the state above ----
      function setTile(tile, sig, cls, content) {
        if (tile.dataset.sig === sig) return false;
        tile.dataset.sig = sig;
        tile.className = `fd-tile ${cls}`.trim();
        tile.replaceChildren(...(content == null ? [] : [content]));
        return true;
      }
      function paintGrid() {
        cols.forEach(({ el, tiles }, c) => {
          const active = !over && c === guesses.length;
          el.classList.toggle('is-active', active);
          for (let i = 0; i < 4; i++) {
            if (c < guesses.length) {
              const name = nm(pcAt(STRINGS[i], guesses[c][i]));
              setTile(tiles[i], `done:${name}:${marks[c][i]}`, `is-${marks[c][i]}`, ui.noteEl(name));
            } else if (active && pick[i] != null) {
              const name = showNames ? nm(pcAt(STRINGS[i], pick[i])) : '•';
              if (setTile(tiles[i], `set:${pick[i]}:${name}`, 'is-set', ui.noteEl(name))) tiles[i].classList.add('is-pop');
            } else {
              setTile(tiles[i], 'empty', '', null);
            }
          }
        });
      }

      function paintChips() {
        chips.forEach((el, pc) => {
          const state = over ? (ch.pcs.includes(pc) ? 'good' : kn.exact.get(pc) === 0 ? 'off' : '') : noteState(kn, pc);
          const sig = `${nm(pc)}:${state}`;
          if (el.dataset.sig === sig) return;
          const first = el.dataset.sig == null;
          el.dataset.sig = sig;
          el.className = `fd-chip${state ? ` is-${state}` : ''}${first ? '' : ' is-new'}`;
          el.replaceChildren(ui.noteEl(nm(pc)));
        });
      }

      const marked = new Map(); // "s:f" -> signature of the dot drawn there
      const shaded = new Set();
      function paintNeck() {
        const wantMarks = new Map();
        const wantShades = new Set();
        if (over) {
          shownShape().forEach((f, i) => wantMarks.set(`${STRINGS[i]}:${f}`, { kind: won ? 'good' : 'accent', label: ch.degreeOf(pcAt(STRINGS[i], f)) }));
        } else {
          STRINGS.forEach((s, i) => {
            for (let f = 0; f <= 12; f++) {
              const pc = pcAt(s, f);
              const state = cellState(kn, i, pc);
              const label = showNames ? nm(pc) : '';
              if (state === 'out') wantShades.add(`${s}:${f}`);
              if (pick[i] === f) {
                // your dot takes the colour of what you already know about that spot
                wantMarks.set(`${s}:${f}`, { kind: state === 'good' ? 'good' : state === 'in' ? 'warn' : state === 'out' ? 'ghost' : 'ink', label });
              } else if (state === 'good') {
                wantMarks.set(`${s}:${f}`, { kind: 'good', small: true, label });
              } else if (kn.green[i] == null && kn.yellowAt[i].has(pc) && noteState(kn, pc) === 'warn') {
                wantMarks.set(`${s}:${f}`, { kind: 'warn', small: true, label }); // in the chord, but not on this string
              }
            }
          });
        }
        const cell = (key) => key.split(':').map(Number);
        for (const [key, sig] of marked) {
          if (JSON.stringify(wantMarks.get(key)) !== sig) {
            fb.unmark(...cell(key));
            marked.delete(key);
          }
        }
        for (const [key, m] of wantMarks) {
          if (marked.has(key)) continue;
          const g = fb.mark(...cell(key), m);
          if (m.small) g.classList.add('fd-small');
          marked.set(key, JSON.stringify(m));
        }
        for (const key of shaded) {
          if (!wantShades.has(key)) {
            fb.unshade(...cell(key));
            shaded.delete(key);
          }
        }
        for (const key of wantShades) {
          if (shaded.has(key)) continue;
          const [s, f] = cell(key);
          const rect = fb.shade(s, f, { kind: 'off' });
          rect.classList.add(f === 0 ? 'fd-open-off' : 'fd-off'); // the open column sits on the page, not the board
          shaded.add(key);
        }
      }

      let bigSig = null;
      function paintDisplay() {
        const n = Math.min(guesses.length + 1, MAX_GUESSES);
        const left = pick.filter((f) => f == null).length;
        let cap;
        let big;
        let sub;
        if (over) {
          cap = won ? (guesses.length === 1 ? 'Got it in one' : `Solved in ${guesses.length}`) : 'The chord was';
          big = ch.name;
          sub = `${ch.label}: ${ch.notes.join(' ')}`;
        } else {
          cap = hinted ? `Guess ${n} of ${MAX_GUESSES}, name revealed` : 'Guess';
          big = hinted ? ch.name : `${n} of ${MAX_GUESSES}`;
          sub = left === 0 ? 'Strum to check it' : left === 4 ? 'One note on each string' : `${left} more string${left === 1 ? '' : 's'}`;
        }
        capEl.textContent = cap;
        subEl.innerHTML = ui.noteHTML(sub);
        if (big !== bigSig) {
          const count = !over && !hinted;
          bigEl.className = `fd-big dot${count ? ' is-count' : ''}`;
          bigEl.innerHTML = ui.noteHTML(big);
          if (bigSig != null) {
            void bigEl.offsetWidth;
            bigEl.classList.add('is-new');
          }
          bigSig = big;
        }
      }

      let wasReady = false;
      const setButtons = (a, b) => {
        if (btnBox.firstChild !== a || btnBox.lastChild !== b) btnBox.replaceChildren(a, b);
      };
      function paintControls() {
        if (over) {
          setButtons(resultsBtn, hearBtn);
          return;
        }
        const ready = !busy && pick.every((f) => f != null);
        strumBtn.disabled = !ready;
        strumBtn.classList.toggle('is-ready', ready && !wasReady);
        wasReady = ready;
        hintBtn.disabled = busy;
        hintNote.textContent = hinted ? 'Hint used' : 'Hint after guess 3';
        setButtons(strumBtn, !hinted && guesses.length >= 3 ? hintBtn : hintNote);
      }

      function paint() {
        paintGrid();
        paintChips();
        paintNeck();
        paintDisplay();
        paintControls();
      }

      // ---- playing ----
      function onTap({ s, f }) {
        if (busy || over) return;
        pick[STRINGS.indexOf(s)] = f;
        paint();
      }

      function useHint() {
        if (busy || over || hinted || guesses.length < 3) return;
        hinted = true;
        persist();
        paint();
      }

      function submit() {
        if (busy || over || pick.some((f) => f == null)) return;
        busy = true;
        fb.setEnabled(false);
        const guess = pick.slice();
        const mk = judge(pcsOf(guess), answerPcs);
        const col = cols[guesses.length];
        guesses.push(guess);
        marks.push(mk);
        settle();
        if (over) score(); // book the result now, so leaving mid-reveal cannot lose it
        persist();
        strumBtn.disabled = true;
        hintBtn.disabled = true;
        wasReady = false;
        audio.strum(midis(guess), { gap: 0.04 });

        // turn the column over from the low string up, the way the strum travels
        guess.forEach((f, i) => {
          const pc = pcAt(STRINGS[i], f);
          const name = hinted ? spelled(pc) : PLAIN[pc]; // a final guess keeps its spelling until the reveal is over
          const tile = col.tiles[i];
          setTile(tile, `done:${name}:${mk[i]}`, `is-${mk[i]} is-flip`, ui.noteEl(name));
          tile.style.setProperty('--i', i);
          run.timeout(() => {
            fb.flash(STRINGS[i], f, mk[i], { label: showNames ? name : '' });
            audio.sfx(mk[i] === 'good' ? 'tick' : 'tock');
          }, i * STEP + FLIP / 2);
        });

        run.timeout(() => {
          kn = learn(guesses, marks);
          busy = false;
          if (over) {
            finish();
            return;
          }
          pick = preset();
          fb.setEnabled(true);
          paint();
        }, 3 * STEP + FLIP + 80);
      }

      function finish() {
        pick = [null, null, null, null];
        fb.setEnabled(false);
        paint();
        scr.hud.set('streak', liveStreak(readStats(daily), daily));
        scr.hud.bump('streak');
        audio.sfx(won ? 'win' : 'lose');
        run.timeout(() => audio.strum(midis(shownShape()), { gap: 0.07, dur: 2.8 }), TEST.fast ? 60 : 750);
        run.timeout(() => {
          if (!resultsSeen) openResults();
        }, RESULTS_AFTER);
      }

      function shareText() {
        const head = `Fretdle ${daily ? `#${number}` : 'practice'} ${won ? guesses.length : 'X'}/${MAX_GUESSES}${hinted ? ' (hint)' : ''}`;
        const square = { good: '🟩', warn: '🟨', off: '⬛' };
        return [head, ...marks.map((mk) => mk.map((m) => square[m]).join(''))].join('\n');
      }

      function openResults() {
        if (!over || run.dead) return;
        resultsSeen = true;
        res?.close();
        const st = readStats(daily);
        const top = Math.max(1, ...st.dist);
        const dist = h(
          'div',
          { class: 'fd-dist', role: 'img', 'aria-label': `Wins by number of guesses: ${st.dist.join(', ')}` },
          st.dist.map((count, i) => h('div', { class: `fd-dist-row${won && i === guesses.length - 1 ? ' is-now' : ''}` }, h('span', null, String(i + 1)), h('span', { class: 'fd-dist-bar', style: { width: `${Math.round((count / top) * 100)}%` } }, String(count)))),
        );
        const rows = [
          ['Played', st.played],
          ['Win rate', `${st.played ? Math.round((st.wins / st.played) * 100) : 0}%`],
          [daily ? 'Day streak' : 'Win streak', liveStreak(st, daily)],
          ['Best streak', st.best],
        ];
        const actions = [
          daily
            ? ui.button('Practice', {
                kind: 'primary',
                onClick: () => {
                  cfg.run = 'practice';
                  saveCfg();
                  start();
                },
              })
            : ui.button('Again', { kind: 'primary', onClick: start }),
          ui.button('Copy result', {
            onClick: async () => {
              const ok = await ui.copyText(shareText());
              ui.toast(scr, ok ? 'Copied' : 'Copy not available here', { kind: ok ? 'good' : 'info' });
            },
          }),
          ui.button('Options', { onClick: showIntro }),
          ui.button('Board', { onClick: () => res?.close() }),
        ];
        const card = h(
          'div',
          { class: 'results-card' },
          h(
            'div',
            { class: 'results-main' },
            h('div', { class: 'results-title' }, daily ? `Daily #${number}` : 'Practice', hinted ? h('span', { class: 'badge' }, 'Hint used') : null),
            h(
              'div',
              { class: 'display results-display fd-res-display' },
              h('span', { class: 'results-big dot' }, `${won ? guesses.length : 'X'}/${MAX_GUESSES}`),
              h('span', { class: 'fd-res-chord' }, h('b', null, ui.noteEl(ch.name)), h('span', { html: ui.noteHTML(`${ch.label}: ${ch.notes.join(' ')}`) }), h('span', null, won ? (hinted ? 'Solved with the name revealed' : 'Solved') : 'Not this time')),
            ),
            h('dl', { class: 'results-rows' }, rows.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, String(v))))),
            h('div', { class: 'results-actions' }, actions),
          ),
          h('div', { class: 'results-side' }, h('div', { class: 'side-title' }, 'Wins by guesses'), dist, h('div', { class: 'fd-side-note' }, daily ? 'A new chord every day' : SET_LABELS[cfg.set] || SET_LABELS.both)),
        );
        res = ui.overlay(scr, card);
      }
      run.add(() => res?.close());

      // ---- go: a fresh puzzle, or today's board as it was left ----
      settle();
      if (over) {
        score();
        persist();
        fb.setEnabled(false);
      } else {
        pick = preset();
      }
      paint();
    }

    showIntro();
    return () => {
      run?.dispose();
      if (TEST.fast) delete window.__fretdle;
    };
  },
};

export default game;
