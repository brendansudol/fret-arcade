// Lick HORSE: one side plays a short lick, the other has to play it back by
// ear. Miss it twice and you take a letter; first to spell the word loses.
//
// Flow: intro -> rounds (the setter swaps every round) -> results.
//   CPU sets:     listen -> copy (two tries, three listens) -> matched, or a letter and a lesson
//   player sets:  tap 3-6 notes -> the CPU plays it back and either nails it or slips
//   pass and play: look-away card -> set -> pass card -> listen and copy -> swap
//
// Scripted checks (only when the page is loaded with ?fast) can steer a match
// through window.__lickHorse, set before Start is tapped:
//   .seed = 'abc'     repeatable licks and CPU rolls
//   .cpuRoll = 0..1   force the CPU's copy roll (0 always slips, 0.999 never does)
//   .letters = n      play to the first n letters of the word (default 1 with ?fast)
//   .first = 0 | 1    who sets round 1 (0 = you / Player 1, 1 = CPU / Player 2)
//   .peek()           { phase, round, setter, copier, lick: [{ s, f, midi }], letters, ... }

import { rng, clamp, lifecycle, TEST } from '../core/util.js';
import { midiAt, pcAt, pcName, positionsOfMidi, prefForKey, mod12, SCALES, MAX_FRET } from '../core/theory.js';
import { audio } from '../core/audio.js';
import { mic } from '../core/mic.js';
import { store } from '../core/store.js';
import { createFretboard } from '../core/fretboard.js';
import * as ui from '../core/ui.js';

const ID = 'lick-horse';
const { h } = ui;
const FAST = TEST.fast;
const SPEED = FAST ? 0.2 : 1; // ?fast shortens every pause and plays licks five times faster
const t = (ms) => ms * SPEED;

const LISTENS = 3; // the first play plus two repeats
const MIN_NOTES = 3;
const MAX_NOTES = 6;

// len: lick length range when the CPU sets. first / scale: hints on the neck.
// unit: length of the CPU's short note in seconds. ears: the CPU's chance of a
// slip on the plainest and on the trickiest lick you can set.
const LEVELS = {
  easy: { len: [3, 4], first: true, scale: true, unit: 0.36, ears: [0.15, 0.85], vs: '3-4 notes, start and scale shown', pass: 'start note and scale shown' },
  medium: { len: [4, 5], first: true, scale: false, unit: 0.32, ears: [0.08, 0.7], vs: '4-5 notes, start note shown', pass: 'start note shown' },
  hard: { len: [5, 6], first: false, scale: false, unit: 0.28, ears: [0.04, 0.55], vs: '5-6 notes, no help', pass: 'no help' },
};

const article = (letter) => ('AEFHILMNORSX'.includes(letter) ? 'an' : 'a');
const cellKey = (s, f) => `${s}:${f}`;

// ---- lick maths -----------------------------------------------------------------

/** The simple scale (minor pentatonic or major, any key) that holds most of these notes. */
function bestScale(midis) {
  let best = null;
  for (const steps of [SCALES.minPent, SCALES.major]) {
    for (let root = 0; root < 12; root++) {
      const pcs = steps.map((x) => mod12(root + x));
      const inside = midis.filter((m) => pcs.includes(mod12(m))).length;
      if (!best || inside > best.inside) best = { pcs, inside };
    }
  }
  return best;
}

/** Fewest notes that fall outside `steps` in any key. */
function outside(midis, steps) {
  let fewest = midis.length;
  for (let root = 0; root < 12; root++) {
    const pcs = steps.map((x) => mod12(root + x));
    fewest = Math.min(fewest, midis.filter((m) => !pcs.includes(mod12(m))).length);
  }
  return fewest;
}

/**
 * How hard a lick is to copy by ear, 0..1. Longer licks, big leaps, changes of
 * direction and notes outside a simple scale all add; repeated notes take away.
 */
function trickiness(midis) {
  const n = midis.length;
  if (n < 2) return 0;
  let v = (Math.min(n, MAX_NOTES) - MIN_NOTES) * 0.11;
  let leaps = 0;
  let turns = 0;
  let dir = 0;
  for (let i = 1; i < n; i++) {
    const d = midis[i] - midis[i - 1];
    const a = Math.abs(d);
    leaps += a <= 2 ? 0 : a <= 4 ? 0.04 : a <= 7 ? 0.09 : a <= 11 ? 0.15 : 0.2;
    if (d && dir && Math.sign(d) !== dir) turns++;
    if (d) dir = Math.sign(d);
  }
  const outMajor = outside(midis, SCALES.major);
  const outPent = outside(midis, SCALES.minPent);
  v += Math.min(0.42, leaps) + Math.min(0.09, turns * 0.03);
  v += Math.min(0.4, outMajor * 0.17) + Math.min(0.08, (outPent - outMajor) * 0.03);
  v -= (n - new Set(midis).size) * 0.06;
  return clamp(v, 0, 1);
}

const slipChance = (lv, trick) => lv.ears[0] + (lv.ears[1] - lv.ears[0]) * Math.pow(trick, 0.9);

/** The spot with this pitch closest to `ref` (or lowest on the neck). */
function nearestCell(midi, ref) {
  const all = positionsOfMidi(midi);
  if (!all.length) return null;
  const cost = (c) => (ref ? Math.abs(c.f - ref.f) + Math.abs(c.s - ref.s) * 0.5 : c.f);
  return all.sort((a, b) => cost(a) - cost(b))[0];
}

/**
 * Where the CPU fluffs a lick: most likely on a leap or an odd note, and it
 * lands a fret or two away, short of the leap more often than past it.
 */
function pickSlip(r, notes) {
  const midis = notes.map((n) => n.midi);
  const { pcs } = bestScale(midis);
  const weights = notes.map((n, i) => (i ? 1 + Math.abs(midis[i] - midis[i - 1]) * 0.35 : 0.4) + (pcs.includes(mod12(n.midi)) ? 0 : 2));
  const i = r.weighted(notes.map((_, k) => k), weights);
  const cur = notes[i];
  const pull = i && midis[i - 1] !== cur.midi ? Math.sign(midis[i - 1] - cur.midi) : r() < 0.5 ? 1 : -1;
  const deltas = r() < 0.65 ? [pull, -pull, 2 * pull, -2 * pull] : [2 * pull, pull, -pull, -2 * pull];
  for (const d of deltas) {
    const midi = cur.midi + d;
    if (i && midi === midis[i - 1]) continue;
    const f = cur.f + d;
    const cell = f >= 0 && f <= MAX_FRET ? { s: cur.s, f } : nearestCell(midi, cur);
    if (cell) return { i, note: { s: cell.s, f: cell.f, midi } };
  }
  const f = cur.f < MAX_FRET ? cur.f + 1 : cur.f - 1;
  return { i, note: { s: cur.s, f, midi: midiAt(cur.s, f) } };
}

/**
 * A CPU lick: a walk through one scale box (minor pentatonic or major, random
 * key and position, 2-3 neighbouring strings), mostly by step with the odd
 * skip, that comes to rest on a note of the home chord.
 */
function makeLick(r, lv, len) {
  for (let tries = 0; tries < 2000; tries++) {
    const minor = r() < 0.6;
    const root = r.int(12);
    const pcs = (minor ? SCALES.minPent : SCALES.major).map((x) => mod12(root + x));
    const home = (minor ? [0, 3, 7] : [0, 4, 7]).map((x) => mod12(root + x));
    const strings = lv.scale || r() < 0.45 ? 2 : 3;
    const span = r() < 0.5 ? 4 : 5;
    const s0 = r.int(7 - strings);
    const f0 = r.int(14 - span);
    const cells = [];
    for (let s = s0; s < s0 + strings; s++) {
      for (let f = f0; f < f0 + span; f++) {
        if (pcs.includes(pcAt(s, f))) cells.push({ s, f, midi: midiAt(s, f) });
      }
    }
    const pool = [];
    for (const c of [...cells].sort((a, b) => a.midi - b.midi || b.s - a.s)) {
      if (!pool.length || pool[pool.length - 1].midi !== c.midi) pool.push(c);
    }
    if (pool.length < 4) continue;
    // a proper box has no holes: every scale note between its lowest and highest is in reach
    const holes = pool.some((c, k) => {
      for (let m = c.midi + 1; k + 1 < pool.length && m < pool[k + 1].midi; m++) if (pcs.includes(mod12(m))) return true;
      return false;
    });
    if (holes) continue;
    const ends = pool.map((c, k) => (home.includes(mod12(c.midi)) ? k : -1)).filter((k) => k >= 0);
    if (!ends.length) continue;

    let i = r.int(pool.length);
    let dir = r() < 0.5 ? 1 : -1;
    const path = [i];
    while (path.length < len - 1) {
      if (r() < 0.3) dir = -dir;
      const step = r() < 0.78 ? 1 : 2;
      let j = i + dir * step;
      if (j < 0 || j >= pool.length) {
        dir = -dir;
        j = i + dir * step;
      }
      if (j < 0 || j >= pool.length) j = i + dir;
      if (j < 0 || j >= pool.length) break;
      path.push(j);
      i = j;
    }
    if (path.length < len - 1) continue;
    const near = ends.filter((e) => e !== i && Math.abs(e - i) <= 3);
    if (!near.length) continue;
    path.push(r.weighted(near, near.map((e) => 1 / (e - i) ** 2)));
    if (new Set(path).size < 3) continue; // two notes going back and forth is not a lick

    const unit = lv.unit * (0.94 + r() * 0.12);
    const gaps = [];
    for (let k = 1; k < len; k++) gaps.push(unit * (lv.scale ? (r() < 0.55 ? 2 : 1) : r.weighted([1, 2, 3], [0.55, 0.38, 0.07])));
    return {
      notes: path.map((p) => ({ ...pool[p] })),
      gaps,
      hint: cells.map(({ s, f }) => ({ s, f })),
      scale: `${pcName(root, prefForKey(root, minor))} ${minor ? 'minor pentatonic' : 'major'}`,
    };
  }
  // Never reached in practice: A minor pentatonic at the fifth fret.
  const notes = [[3, 5], [3, 7], [4, 5], [3, 7], [3, 5], [2, 7]].slice(6 - len).map(([s, f]) => ({ s, f, midi: midiAt(s, f) }));
  return { notes, gaps: notes.slice(1).map(() => lv.unit), hint: notes.map(({ s, f }) => ({ s, f })), scale: 'A minor pentatonic' };
}

/** Easy-level help for a lick a person set: the best-fitting scale around where it was played. */
function zoneHint(notes) {
  let s0 = Math.min(...notes.map((n) => n.s));
  let s1 = Math.max(...notes.map((n) => n.s));
  let f0 = Math.min(...notes.map((n) => n.f));
  let f1 = Math.max(...notes.map((n) => n.f));
  while (f1 - f0 < 3) {
    if (f1 < MAX_FRET) f1++;
    if (f1 - f0 < 3 && f0 > 0) f0--;
  }
  if (s0 === s1) {
    if (s1 < 5) s1++;
    else s0--;
  }
  const { pcs } = bestScale(notes.map((n) => n.midi));
  const cells = [];
  for (let s = s0; s <= s1; s++) {
    for (let f = f0; f <= f1; f++) {
      if (pcs.includes(pcAt(s, f)) || notes.some((n) => n.s === s && n.f === f)) cells.push({ s, f });
    }
  }
  return cells;
}

// ---- styles ---------------------------------------------------------------------

const CSS = `
.lh .intro-options { gap: 8px; }
.lh .intro-right { padding: 12px 16px 14px; gap: 10px; }
.lh .toast { top: 6px; }
.lh-play { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; padding: 0 16px 4px; }
.lh-play .fretboard { transition: opacity 0.2s; }
.lh-play.is-listen .fretboard { opacity: 0.45; }
.lh-play.is-listen .fretboard.is-beat { animation: lh-neck 0.24s ease-out; }
.lh-play .fb-mk.k-ghost { opacity: 0.6; }
.lh-top { flex: 1; min-height: 0; width: 100%; display: grid; grid-template-columns: 1fr 150px; gap: 12px; align-items: center; }
.lh-display { height: 118px; display: grid; grid-template-columns: auto 1fr auto; grid-template-rows: auto auto; align-content: center; align-items: center; column-gap: 10px; row-gap: 8px; padding: 0 14px; outline: 3px solid transparent; outline-offset: 1px; transition: outline-color 0.2s; }
.lh-display.is-listen { outline-color: var(--game); }
.lh-side, .lh-mid { display: contents; }
.lh-who { grid-row: 1; grid-column: 1; display: flex; align-items: center; gap: 6px; font: 600 12px/1 var(--font-label); letter-spacing: 0.16em; text-transform: uppercase; white-space: nowrap; color: var(--lcd-dim); transition: color 0.15s; }
.lh-side.is-right .lh-who { grid-column: 3; justify-self: end; flex-direction: row-reverse; }
.lh-led { width: 8px; height: 8px; border-radius: 50%; background: color-mix(in srgb, var(--lcd-dim) 35%, transparent); transition: background-color 0.15s; }
.lh-side.is-on .lh-who { color: var(--lcd-ink); }
.lh-side.is-on .lh-led { background: var(--game); }
.lh-letters { grid-row: 2; grid-column: 1; display: flex; gap: 5px; }
.lh-side.is-right .lh-letters { grid-column: 3; }
.lh-letter { width: 44px; height: 64px; display: grid; place-items: center; border-radius: 7px; border: 2px solid color-mix(in srgb, var(--lcd-dim) 40%, transparent); color: color-mix(in srgb, var(--lcd-dim) 50%, transparent); font-size: 52px; line-height: 1; }
.lh-side.is-long .lh-letter { width: 31px; height: 58px; font-size: 40px; }
.lh-letter.is-lit { background: var(--lcd-ink); border-color: var(--lcd-ink); color: var(--lcd-bg); }
.lh-letter.is-new { animation: lh-stamp 0.24s ease-out; }
.lh-cap { grid-row: 1; grid-column: 2; justify-self: center; min-height: 12px; font: 600 12px/1 var(--font-label); letter-spacing: 0.11em; text-transform: uppercase; white-space: nowrap; color: var(--lcd-dim); }
.lh-main { grid-row: 2; grid-column: 2; display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 0; }
.lh-word { font-size: 42px; line-height: 1; white-space: nowrap; }
.lh-display.is-long .lh-word { font-size: 40px; }
.lh-word.is-new { animation: pop 0.16s ease-out; }
.lh-word.is-beat { animation: lh-beat 0.18s ease-out; }
.lh-dots i { font-style: normal; animation: lh-dot 0.9s ease-in-out infinite; }
.lh-dots i:nth-child(2) { animation-delay: 0.15s; }
.lh-dots i:nth-child(3) { animation-delay: 0.3s; }
.lh-slots { display: flex; align-items: center; gap: 7px; height: 24px; }
.lh-slot { width: 23px; height: 23px; display: grid; place-items: center; border-radius: 50%; border: 2px solid var(--lcd-dim); color: var(--lcd-dim); font: 700 12px/1 var(--font-label); }
.lh-slot.is-opt { border-style: dashed; opacity: 0.55; }
.lh-slot.is-cursor { border-color: var(--lcd-ink); color: var(--lcd-ink); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lcd-ink) 28%, transparent); }
.lh-slot.is-kept { border-color: var(--good); color: var(--good); }
.lh-slot.is-fill { background: var(--lcd-ink); border-color: var(--lcd-ink); color: var(--lcd-bg); opacity: 1; border-style: solid; }
.lh-slot.is-good { background: var(--good); border-color: var(--good); color: var(--on-game); }
.lh-slot.is-bad { background: var(--bad); border-color: var(--bad); color: var(--on-game); }
.lh-slot.is-ping { animation: lh-ping 0.24s ease-out; }
.lh-col { height: 118px; display: flex; flex-direction: column; justify-content: space-between; padding: 3px 0 4px; }
.lh-meter { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lh-meter b { font: 700 16px/1.12 var(--font-label); letter-spacing: 0.05em; text-transform: uppercase; }
.lh-meter .lives svg { width: 19px; height: 21px; }
.lh-pips { display: flex; gap: 4px; }
.lh-pips i { flex: 1; height: 11px; border-radius: 4px; border: 2px solid var(--edge); background: var(--surface); }
.lh-pips i.is-on { background: var(--game); }
.lh-note { font-size: 12.5px; line-height: 1.3; color: var(--ink-2); }
.lh-btns { display: flex; gap: 8px; }
.lh-btns .btn { flex: 1; height: 44px; padding: 0 6px; }
.lh-tag { font: 600 11px/1 var(--font-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); }
.lh-over { top: 44px; }
.lh-card { display: flex; flex-direction: column; align-items: center; gap: 12px; min-width: 400px; padding: 22px 32px 24px; text-align: center; background: var(--surface); border: 2px solid var(--edge); border-radius: 16px; box-shadow: 0 5px 0 var(--shadow); animation: rise 0.22s ease-out; }
.lh-card-title { font-size: 40px; line-height: 1; text-transform: uppercase; white-space: nowrap; }
.lh-card p { font-size: 16px; line-height: 1.3; color: var(--ink-2); max-width: 42ch; }
.lh-card .btn { min-width: 200px; margin-top: 4px; }
@keyframes lh-ping { from { transform: scale(1.6); background: var(--lcd-ink); box-shadow: 0 0 0 6px color-mix(in srgb, var(--lcd-ink) 35%, transparent); } }
@keyframes lh-beat { 35% { transform: scale(1.05); } }
@keyframes lh-neck { from { opacity: 0.72; } }
@keyframes lh-stamp { from { transform: scale(1.8); opacity: 0.3; } }
@keyframes lh-dot { 0%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
`;

// ---- the game -------------------------------------------------------------------

const game = {
  id: ID,
  title: 'Lick HORSE',
  kind: 'Copy the lick by ear',
  color: 'var(--placid)',
  knobs: [35, 110],
  boards: { best: { title: 'Wins', unit: 'versus the CPU' } },
  /** This browser's score for the shared board: matches won against the CPU. */
  scores() {
    const r = store.get(ID, 'record', null);
    return { day: null, best: r && r.w > 0 ? r.w : null };
  },
  /** Versus record for the pedal's display on the hub. */
  readout() {
    const r = store.get(ID, 'record', null);
    return r && r.w + r.l > 0 ? `W${r.w} L${r.l}` : null;
  },

  mount(root, app) {
    ui.injectCSS(ID, CSS);
    const life = lifecycle();
    let run = null; // lifecycle of the current match
    const scr = ui.gameScreen(root, game, { onBack: app.exit });
    scr.el.classList.add('lh');
    const cfg = { mode: 'versus', word: 'PIG', level: 'easy', input: 'tap', ...store.get(ID, 'cfg', {}) };
    const saveCfg = () => store.set(ID, 'cfg', cfg);
    const record = () => ({ w: 0, l: 0, ...store.get(ID, 'record', {}) });
    const clearOverlays = () => scr.el.querySelectorAll('.overlay').forEach((o) => o.remove());

    function showIntro() {
      run?.dispose();
      mic.stop();
      clearOverlays();
      scr.hud.setStats([]);
      scr.hud.mid.replaceChildren();
      const vs = cfg.mode === 'versus';
      const lv = LEVELS[cfg.level] || LEVELS.easy;
      const seg = (label, key, options, redraw = false) =>
        ui.segmented({
          label,
          options,
          value: cfg[key],
          onChange: (v) => {
            cfg[key] = v;
            saveCfg();
            if (redraw) showIntro();
          },
        });
      const options = [
        seg('Mode', 'mode', [{ value: 'versus', label: 'Versus CPU' }, { value: 'pass', label: 'Pass and play' }], true),
        seg('Play to', 'word', [{ value: 'PIG', label: 'PIG' }, { value: 'HORSE', label: 'HORSE' }], true),
        seg(`Level: ${vs ? lv.vs : lv.pass}`, 'level', [{ value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' }], true),
      ];
      if (mic.supported) options.push(seg('Play with', 'input', [{ value: 'tap', label: 'Taps' }, { value: 'guitar', label: 'Real guitar' }]));
      const rec = record();
      ui.intro(scr, {
        title: 'Lick HORSE',
        tagline: vs ? 'Copy the lick by ear, or take a letter. You against the CPU.' : 'Copy the lick by ear, or take a letter. Two players, one phone.',
        steps: [
          vs ? 'You and the CPU take turns to play a short lick.' : 'Take turns to play a short lick while the other looks away.',
          'The other side plays it back by ear. Two tries, three listens.',
          `Miss it and take a letter. First to spell ${cfg.word} loses.`,
        ],
        options,
        best: vs && rec.w + rec.l > 0 ? { label: 'Versus record', value: `W${rec.w} L${rec.l}` } : null,
        onStart: start,
      });
    }

    async function start() {
      run?.dispose();
      const my = (run = lifecycle());
      clearOverlays();

      let useMic = cfg.input === 'guitar' && mic.supported;
      let micFailed = false;
      if (!useMic) mic.stop();
      else if (!(await mic.start())) {
        useMic = false;
        micFailed = true;
        ui.toast(scr, 'No microphone here. Using taps.', { ms: 1800 });
      }
      if (my.dead) return;
      if (!store.settings.sound) my.timeout(() => ui.toast(scr, 'Sound is off. Turn it on at the hub.', { ms: 2400 }), micFailed ? 1900 : 0);

      // ---- match state ----
      const hook = FAST ? (window.__lickHorse ||= {}) : null; // test switches, see the top of the file
      const R = rng(hook?.seed);
      const vs = cfg.mode === 'versus';
      const lv = LEVELS[cfg.level] || LEVELS.easy;
      const full = cfg.word === 'HORSE' ? 'HORSE' : 'PIG';
      const WORD = full.slice(0, hook?.letters ?? (FAST ? 1 : full.length));
      const sides = (vs ? ['You', 'CPU'] : ['Player 1', 'Player 2']).map((name, i) => ({ name, cpu: vs && i === 1, letters: 0, faced: 0, matched: 0 }));
      const rec0 = record();
      // Player 1 opens a pass-and-play game; against the CPU the opener swaps game by game.
      let setter = hook?.first ?? (vs && (rec0.w + rec0.l) % 2 === 0 ? 1 : 0);
      let copier = 1 - setter;
      let round = 0;
      let cpuSets = 0;
      let cpuSlips = 0;
      let phase = 'idle';
      let lick = null;
      let onNeck = null; // who gets taps and mic notes right now
      let micMute = 0; // ignore the mic until this time (it hears our own speaker)
      let playing = null;
      const info = {};

      // ---- build the play screen ----
      scr.hud.setStats([{ key: 'round', label: 'Round', value: 1 }]);
      scr.hud.mid.replaceChildren(useMic ? h('span', { class: 'lh-tag' }, 'Guitar on. Taps work too.') : '');
      const board = sides.map((sd, i) => {
        const tiles = [...WORD].map((ch) => h('span', { class: 'lh-letter dot' }, ch));
        const letters = h('div', { class: 'lh-letters', role: 'img', 'aria-label': `${sd.name}: no letters` }, tiles);
        const el = h('div', { class: `lh-side${i ? ' is-right' : ''}${WORD.length > 3 ? ' is-long' : ''}` }, h('span', { class: 'lh-who' }, h('i', { class: 'lh-led' }), sd.name), letters);
        return { el, tiles, letters };
      });
      const capEl = h('span', { class: 'lh-cap' });
      const wordEl = h('span', { class: 'lh-word dot' });
      const slotsEl = h('div', { class: 'lh-slots' });
      const display = h('div', { class: `display lh-display${WORD.length > 3 ? ' is-long' : ''}` }, board[0].el, h('div', { class: 'lh-mid', 'aria-live': 'polite' }, capEl, h('div', { class: 'lh-main' }, wordEl, slotsEl)), board[1].el);
      const meterEl = h('div', { class: 'lh-meter' });
      const btnsEl = h('div', { class: 'lh-btns' });
      const play = h('div', { class: 'lh-play' }, h('div', { class: 'lh-top' }, display, h('div', { class: 'lh-col' }, meterEl, btnsEl)));
      scr.body.replaceChildren(play);
      const fb = createFretboard(play, {
        onTap: (cell) => {
          micMute = performance.now() + 1000; // the mic hears the tap's own pluck
          onNeck?.(cell);
        },
      });
      fb.setEnabled(false);
      const picks = ui.lives(LISTENS);
      if (useMic) {
        my.add(
          mic.onNote((n) => {
            if (performance.now() >= micMute) onNeck?.({ s: null, f: null, midi: n.midi });
          }),
        );
      }

      // ---- display helpers ----
      const retrigger = (el, cls) => {
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
      };
      function say(word, cap, dots = false) {
        if (cap != null) capEl.textContent = cap;
        if (word == null) return;
        wordEl.textContent = word;
        if (dots) wordEl.append(h('span', { class: 'lh-dots', 'aria-hidden': 'true' }, h('i', null, '.'), h('i', null, '.'), h('i', null, '.')));
        wordEl.classList.remove('is-beat');
        retrigger(wordEl, 'is-new');
      }
      function setPhase(p) {
        phase = p;
        play.classList.toggle('is-listen', p === 'listen');
        display.classList.toggle('is-listen', p === 'listen');
        if (p !== 'listen') fb.el.classList.remove('is-beat');
      }
      const setActive = (i) => board.forEach((b, k) => b.el.classList.toggle('is-on', k === i));
      const setButtons = (...kids) => btnsEl.replaceChildren(...kids.filter(Boolean));
      const setMeter = (...kids) => meterEl.replaceChildren(...kids.filter(Boolean));
      let slots = [];
      function setSlots(n, optionalFrom = n) {
        slots = Array.from({ length: n }, (_, i) => h('span', { class: `lh-slot${i >= optionalFrom ? ' is-opt' : ''}` }, String(i + 1)));
        slotsEl.replaceChildren(...slots);
      }
      function slotState(i, state) {
        if (!slots[i]) return;
        slots[i].classList.remove('is-fill', 'is-good', 'is-bad', 'is-kept');
        if (state) slots[i].classList.add(`is-${state}`);
      }
      /** One beat of the lick: the slot blinks, the word nods and the whole neck glows. Never shows where the note is. */
      function ping(i) {
        if (slots[i]) retrigger(slots[i], 'is-ping');
        wordEl.classList.remove('is-new');
        retrigger(wordEl, 'is-beat');
        if (phase === 'listen') retrigger(fb.el, 'is-beat');
      }
      function trickMeter(v, n) {
        const lit = n < 2 ? 0 : Math.max(1, Math.round(v * 5));
        const word = n < MIN_NOTES ? '' : v < 0.2 ? 'Easy pickings' : v < 0.45 ? 'Fair' : v < 0.7 ? 'Tricky' : 'Nasty';
        setMeter(h('span', { class: 'stat-label' }, 'Trickiness'), h('div', { class: 'lh-pips' }, [0, 1, 2, 3, 4].map((k) => h('i', { class: k < lit ? 'is-on' : '' }))), h('b', null, word));
      }
      function giveLetter(i) {
        const sd = sides[i];
        const letter = WORD[sd.letters];
        const tile = board[i].tiles[sd.letters];
        sd.letters++;
        tile.classList.add('is-lit');
        retrigger(tile, 'is-new');
        board[i].letters.setAttribute('aria-label', `${sd.name}: ${WORD.slice(0, sd.letters)}`);
        return letter;
      }

      // ---- the neck: hints underneath, numbered notes on top ----
      const hints = new Map(); // key -> { s, f, opts }
      const marks = new Map(); // key -> { s, f, list: [{ num, kind, kept }] }
      function paint(s, f) {
        const k = cellKey(s, f);
        const list = marks.get(k)?.list;
        if (list?.length) {
          const nums = list.map((e) => e.num);
          fb.mark(s, f, { label: nums.length > 2 ? String(nums[nums.length - 1]) : nums.join('·'), kind: list[list.length - 1].kind });
        } else if (hints.has(k)) fb.mark(s, f, hints.get(k).opts);
        else fb.unmark(s, f);
      }
      function addNote(s, f, num, kind) {
        const k = cellKey(s, f);
        if (!marks.has(k)) marks.set(k, { s, f, list: [] });
        marks.get(k).list.push({ num, kind, kept: false });
        paint(s, f);
      }
      function recolour(num, kind) {
        for (const m of marks.values()) {
          const e = m.list.find((x) => x.num === num && !x.kept);
          if (!e) continue;
          e.kind = kind;
          paint(m.s, m.f);
        }
      }
      /** After a first try: wrong guesses leave the neck, right ones stay on show. */
      function keepGood() {
        for (const [k, m] of [...marks]) {
          m.list = m.list.filter((e) => e.kind === 'good');
          m.list.forEach((e) => (e.kept = true));
          if (!m.list.length) marks.delete(k);
          paint(m.s, m.f);
        }
      }
      const hasKept = (s, f, num) => !!marks.get(cellKey(s, f))?.list.some((e) => e.kept && e.num === num);
      function setHint(s, f, opts) {
        hints.set(cellKey(s, f), { s, f, opts });
        paint(s, f);
      }
      function clearNeck() {
        hints.clear();
        marks.clear();
        fb.clearMarks();
      }
      function showHints() {
        if (lv.scale) for (const c of lick.hint || zoneHint(lick.notes)) setHint(c.s, c.f, { kind: 'ghost', small: true });
        if (lv.first) setHint(lick.notes[0].s, lick.notes[0].f, { kind: 'accent', shape: 'ring', label: '1', pulse: true });
      }

      /**
       * Play a lick out loud. Notes are booked a moment ahead so the rhythm is
       * exact, yet leaving the game cancels whatever has not sounded yet.
       * onNote(i) fires as each note sounds. Returns { done, cancel }.
       */
      function playLick(lk, onNote) {
        const pl = lifecycle();
        const off = my.add(() => pl.dispose());
        const n = lk.notes.length;
        const at = [0];
        for (const g of lk.gaps) at.push(at[at.length - 1] + g * SPEED * 1000);
        const begin = performance.now() + 50;
        micMute = begin + at[n - 1] + 900;
        let next = 0;
        let finish;
        const done = new Promise((res) => (finish = res));
        const pump = () => {
          const now = performance.now();
          while (next < n && begin + at[next] - now < 140) {
            const i = next++;
            const wait = Math.max(0, begin + at[i] - now);
            const note = lk.notes[i];
            // with the mic on the last note is damped early, so the guitar is heard as soon as it is your turn
            const ring = i === n - 1 ? (useMic ? 0.8 : 1.5) : clamp((at[i + 1] - at[i]) / 1000 + (lk.notes[i + 1].s === note.s ? 0.05 : 0.32), 0.12, 1.3);
            audio.pluck(note.midi, { when: audio.now() + wait / 1000, gain: i ? 0.74 : 0.84, dur: ring });
            pl.timeout(() => onNote?.(i), wait);
            if (i === n - 1) {
              pl.timeout(() => {
                off();
                pl.dispose();
                finish();
              }, wait + t(750));
            }
          }
        };
        pump();
        pl.interval(pump, 25);
        return {
          done,
          cancel() {
            off();
            pl.dispose();
          },
        };
      }

      /** A card over the play area that waits for a tap (pass-and-play hand-offs). */
      function card(title, text) {
        return new Promise((res) => {
          const ov = ui.overlay(
            scr,
            h(
              'div',
              { class: 'lh-card' },
              h('div', { class: 'lh-card-title dot' }, title),
              h('p', null, text),
              ui.button('Ready', {
                kind: 'primary',
                cls: 'btn-big',
                onClick: () => {
                  ov.close();
                  res();
                },
              }),
            ),
            { cls: 'lh-over' },
          );
          my.add(() => ov.close());
        });
      }
      function standby() {
        setPhase('wait');
        onNeck = null;
        fb.setEnabled(false);
        clearNeck();
        setSlots(0);
        setButtons();
        setMeter();
        setActive(null);
        say('READY', '');
      }

      // ---- a round where someone copies `lick` by ear ----
      async function copyRound() {
        const n = lick.notes.length;
        const me = sides[copier];
        const owner = `${sides[setter].name}'s`;
        const kept = new Array(n).fill(false);
        let listens = LISTENS;
        let attempt = 1;
        let entry = [];
        let entered = null;
        me.faced++;

        const hearBtn = ui.button('Hear again', { disabled: true, sound: null, onClick: () => hear() });
        const cursor = () => slots.forEach((el, k) => el.classList.toggle('is-cursor', phase === 'copy' && k === entry.length));
        const showListens = () => {
          picks.set(listens);
          setMeter(h('span', { class: 'stat-label' }, 'Listens left'), picks.el);
          info.listens = listens;
        };

        async function listenNow(lead) {
          setPhase('listen');
          onNeck = null;
          fb.setEnabled(false);
          hearBtn.disabled = true;
          cursor();
          listens--;
          showListens();
          say('LISTEN', `${owner} lick · ${n} notes`);
          await my.wait(t(lead));
          await playLick(lick, ping).done;
        }
        function open() {
          setPhase('copy');
          if (attempt === 1) say('YOUR TURN', useMic ? `Play or tap the ${n} notes` : `Tap the ${n} notes in order`);
          else say('ONE MORE', kept.some(Boolean) ? `Greens were right. Play all ${n}.` : `None right yet. Play all ${n}.`);
          hearBtn.disabled = listens <= 0;
          fb.setEnabled(true);
          onNeck = take;
          cursor();
        }
        async function hear() {
          if (phase !== 'copy' || listens <= 0) return;
          await listenNow(300);
          open();
        }
        function take(cell) {
          if (phase !== 'copy' || entry.length >= n) return;
          const i = entry.length;
          let pos = cell;
          if (cell.s == null) {
            // heard through the mic: show it at the handiest spot for that pitch
            let ref = null;
            for (const e of entry) if (e.pos) ref = e.pos;
            pos = nearestCell(cell.midi, ref);
          }
          entry.push({ midi: cell.midi, pos });
          slotState(i, 'fill');
          if (pos && !hasKept(pos.s, pos.f, i + 1)) addNote(pos.s, pos.f, i + 1, 'ink');
          cursor();
          if (entry.length === n) {
            onNeck = null;
            fb.setEnabled(false);
            hearBtn.disabled = true;
            entered?.();
          }
        }

        setActive(copier);
        clearNeck();
        setSlots(n);
        setButtons(hearBtn);
        showHints();
        await listenNow(900);

        for (attempt = 1; attempt <= 2; attempt++) {
          info.attempt = attempt;
          entry = [];
          if (attempt === 2) {
            for (let i = 0; i < n; i++) slotState(i, kept[i] ? 'kept' : null);
            keepGood();
          }
          open();
          await new Promise((res) => (entered = res));

          // reveal, slot by slot
          setPhase('reveal');
          cursor();
          say('CHECKING', 'Note by note');
          await my.wait(t(400));
          let right = 0;
          for (let i = 0; i < n; i++) {
            const ok = entry[i].midi === lick.notes[i].midi;
            kept[i] = ok;
            if (ok) right++;
            slotState(i, ok ? 'good' : 'bad');
            retrigger(slots[i], 'is-ping');
            recolour(i + 1, ok ? 'good' : 'bad');
            audio.sfx(ok ? 'tick' : 'tock');
            await my.wait(t(260));
          }
          await my.wait(t(220));
          if (right === n) {
            me.matched++;
            say('MATCHED', attempt === 1 ? 'Clean copy. No letter.' : 'Got it this time. No letter.');
            audio.sfx('great');
            await my.wait(t(1700));
            return;
          }
          if (attempt === 1) {
            say('NOT QUITE', `${right} of ${n} right. One more try.`);
            audio.sfx('bad');
            await my.wait(t(1500));
          }
        }

        // missed twice: a letter, then the lesson
        const letter = giveLetter(copier);
        const last = me.letters >= WORD.length;
        say('MISSED', `${me.name} take${me.name === 'You' ? '' : 's'} ${article(letter)} ${letter}`);
        audio.sfx('drop');
        await my.wait(t(1500));
        await teach(last);
      }

      /** Replay the lick with its notes lighting up in order, then let the player noodle on it. */
      async function teach(last) {
        const n = lick.notes.length;
        let goOn;
        const gone = new Promise((res) => (goOn = res));
        const againBtn = ui.button('Again', { sound: null, onClick: () => show() });
        const nextBtn = ui.button(last ? 'Finish' : 'Next', { kind: 'primary', onClick: () => goOn() });
        function show() {
          playing?.cancel();
          setPhase('teach');
          clearNeck();
          setSlots(n);
          fb.setEnabled(false);
          againBtn.disabled = true;
          say('LEARN IT', 'Watch where the notes fall');
          const p = (playing = playLick(lick, (i) => {
            const note = lick.notes[i];
            addNote(note.s, note.f, i + 1, 'accent');
            slotState(i, 'fill');
            ping(i);
          }));
          p.done.then(() => {
            if (playing !== p) return;
            againBtn.disabled = false;
            fb.setEnabled(true); // free play: try the lick yourself
            say(null, 'Try it on the neck, then go on');
          });
        }
        onNeck = null;
        setMeter(h('span', { class: 'stat-label' }, lick.scale ? 'It was in' : 'The lick'), h('b', null, lick.scale ? ui.noteEl(lick.scale) : `${n} notes`));
        setButtons(againBtn, nextBtn);
        show();
        await gone;
        playing?.cancel();
        playing = null;
        fb.setEnabled(false);
      }

      // ---- a round where a person sets the lick ----
      function setRound() {
        return new Promise((resolve) => {
          const taps = [];
          const redoBtn = ui.button('Redo', { disabled: true, onClick: () => reset() });
          const doneBtn = ui.button('Done', { kind: 'primary', disabled: true, onClick: () => finish() });
          const refresh = () => {
            redoBtn.disabled = !taps.length;
            doneBtn.disabled = taps.length < MIN_NOTES;
            if (vs) trickMeter(trickiness(taps.map((x) => x.midi)), taps.length);
            capEl.textContent = taps.length >= MAX_NOTES ? 'Six notes. Done or redo.' : taps.length >= MIN_NOTES ? 'Add more, or tap Done' : `Tap ${MIN_NOTES} to ${MAX_NOTES} notes, then Done`;
          };
          function reset() {
            taps.length = 0;
            clearNeck();
            setSlots(MAX_NOTES, MIN_NOTES);
            fb.setEnabled(true);
            refresh();
          }
          function finish() {
            if (phase !== 'set' || taps.length < MIN_NOTES) return;
            // rhythm comes from the taps, kept within musical bounds
            const gaps = taps.slice(1).map((x, i) => clamp((x.at - taps[i].at) / 1000, 0.15, 0.9));
            setPhase('wait');
            onNeck = null;
            fb.setEnabled(false);
            clearNeck();
            resolve({ notes: taps.map(({ s, f, midi }) => ({ s, f, midi })), gaps, hint: null, scale: null });
          }
          setPhase('set');
          setActive(setter);
          setButtons(redoBtn, doneBtn);
          if (!vs) setMeter(h('span', { class: 'stat-label' }, 'Secret lick'), h('span', { class: 'lh-note' }, `${sides[copier].name} has to copy it by ear.`));
          say('YOUR LICK', '');
          reset();
          onNeck = (cell) => {
            if (phase !== 'set' || cell.s == null || taps.length >= MAX_NOTES) return;
            taps.push({ s: cell.s, f: cell.f, midi: cell.midi, at: performance.now() });
            slotState(taps.length - 1, 'fill');
            addNote(cell.s, cell.f, taps.length, 'accent');
            if (taps.length >= MAX_NOTES) fb.setEnabled(false);
            refresh();
          };
        });
      }

      // ---- the CPU has a go at the player's lick ----
      async function cpuRound() {
        const n = lick.notes.length;
        const trick = trickiness(lick.notes.map((x) => x.midi));
        const chance = slipChance(lv, trick);
        const roll = typeof hook?.cpuRoll === 'number' ? hook.cpuRoll : R();
        const slip = roll < chance ? pickSlip(R, lick.notes) : null;
        Object.assign(info, { trick, slipChance: chance, slipAt: slip ? slip.i : null });
        sides[copier].faced++;

        setPhase('cpu');
        setActive(copier);
        setSlots(n);
        trickMeter(trick, n);
        setButtons(h('p', { class: 'lh-note' }, 'Long licks, big leaps and odd notes trip it up.'));
        say('HMM', 'CPU is working it out', true);
        await my.wait(t(1300));
        say('CPU PLAYS', 'Listen for a slip');
        await my.wait(t(400));
        const played = { notes: lick.notes.map((note, i) => (slip && slip.i === i ? slip.note : note)), gaps: lick.gaps };
        await playLick(played, (i) => {
          const bad = !!slip && slip.i === i;
          addNote(played.notes[i].s, played.notes[i].f, i + 1, bad ? 'bad' : 'good');
          slotState(i, bad ? 'bad' : 'good');
          ping(i);
        }).done;
        if (slip) {
          const was = lick.notes[slip.i];
          setHint(was.s, was.f, { kind: 'ghost', label: String(slip.i + 1) }); // where it should have been
          const letter = giveLetter(copier);
          say(['CPU SLIPS', 'CLANGER', 'WHOOPS'][cpuSlips++ % 3], `Sour note ${slip.i + 1}. CPU takes ${article(letter)} ${letter}.`);
          audio.sfx('good');
        } else {
          sides[copier].matched++;
          if (trick < 0.2) say('TOO EASY', 'CPU matched it. Go trickier.');
          else say('NAILED IT', 'CPU matched it. No letter.');
          audio.sfx('tock');
        }
        await my.wait(t(2200));
      }

      async function finish(loser) {
        const winner = 1 - loser;
        setPhase('over');
        onNeck = null;
        fb.setEnabled(false);
        setButtons();
        setMeter();
        setActive(null);
        say('GAME OVER', `${sides[loser].name} spelled ${WORD}`);
        await my.wait(t(1300));
        my.dispose();
        mic.stop();

        const rate = (sd) => `${sd.matched} of ${sd.faced}`;
        const rows = [['Rounds', round]];
        let big;
        if (vs) {
          const rec = record();
          if (winner === 0) rec.w++;
          else rec.l++;
          store.set(ID, 'record', rec);
          store.recordRun(ID, sides[0].matched, { mode: 'versus' });
          audio.sfx(winner === 0 ? 'win' : 'lose');
          big = winner === 0 ? 'YOU WIN' : 'CPU WINS';
          rows.push(['You matched', `${rate(sides[0])} licks`], ['CPU matched', `${rate(sides[1])} licks`], ['Versus record', `W${rec.w} L${rec.l}`]);
        } else {
          store.recordRun(ID, sides[0].matched + sides[1].matched, { mode: 'pass' });
          audio.sfx('win');
          big = `${sides[winner].name} wins`.toUpperCase();
          rows.push(['Play to', full], [`${sides[0].name} matched`, `${rate(sides[0])} licks`], [`${sides[1].name} matched`, `${rate(sides[1])} licks`]);
        }
        const res = ui.results(scr, {
          title: vs ? `Versus CPU, play to ${full}` : 'Pass and play',
          big,
          unit: `${sides[loser].name} spelled ${WORD}`,
          rows,
          actions: [
            { label: 'Again', kind: 'primary', onClick: start },
            { label: 'Options', onClick: showIntro },
          ],
        });
        life.add(() => res.close());
      }

      if (hook) {
        hook.peek = () => ({
          phase,
          round,
          setter,
          copier,
          word: WORD,
          names: sides.map((sd) => sd.name),
          letters: sides.map((sd) => sd.letters),
          faced: sides.map((sd) => sd.faced),
          matched: sides.map((sd) => sd.matched),
          lick: lick ? lick.notes.map(({ s, f, midi }) => ({ s, f, midi })) : null,
          gaps: lick ? lick.gaps.slice() : null,
          scale: lick?.scale ?? null,
          mic: useMic,
          ...info,
        });
      }

      // ---- go: one lick per round, setter and copier swap each time ----
      for (;;) {
        round++;
        scr.hud.set('round', round);
        lick = null;
        if (sides[setter].cpu) {
          const [lo, hi] = lv.len;
          lick = makeLick(R, lv, clamp(lo + Math.floor(cpuSets / 2), lo, hi)); // licks grow as the game goes on
          cpuSets++;
          await copyRound();
        } else if (sides[copier].cpu) {
          lick = await setRound();
          await cpuRound();
        } else {
          standby();
          await card(`${sides[copier].name}, look away`, `${sides[setter].name} is about to set a lick. No peeking.`);
          lick = await setRound();
          standby();
          await card('Pass the phone', `${sides[copier].name}: listen, then play it back by ear.`);
          await copyRound();
        }
        const loser = sides.findIndex((sd) => sd.letters >= WORD.length);
        if (loser >= 0) {
          finish(loser);
          return;
        }
        [setter, copier] = [copier, setter];
        await my.wait(t(300));
      }
    }

    showIntro();
    return () => {
      run?.dispose();
      life.dispose();
      mic.stop();
    };
  },
};

export default game;
