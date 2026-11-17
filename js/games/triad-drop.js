// Triad Drop: chord tiles fall toward the neck. Clear one by building that
// triad on three adjacent strings (one note per string, any inversion) before
// it lands. A landed tile costs a pick and shows you one shape for it.
//
// Flow: intro -> countdown -> play -> results -> again / options.
//
// For scripted checks the play screen carries its state in data attributes:
//   .td-play            data-strings="3,4,5" data-state data-level data-lives
//                       data-score data-cleared data-wrong data-posrun
//                       data-posbonus data-last (what the last clear was called)
//   .td-tile.is-active  data-chord="C/E" data-root data-type data-pcs="0,4,7"
//                       data-bass="4" (empty when any inversion will do)

import { rng, dailySeed, todayKey, lifecycle, clamp, TEST } from '../core/util.js';
import { pcAt, midiAt, chord, NATURAL_PCS, MAX_FRET, STRING_LETTERS } from '../core/theory.js';
import { audio } from '../core/audio.js';
import { store } from '../core/store.js';
import { createFretboard } from '../core/fretboard.js';
import * as ui from '../core/ui.js';
import { resultsBoard } from '../core/boards.js';

const ID = 'triad-drop';
const { h } = ui;

const SETS = [
  { id: 'gbe', label: 'G B E', strings: [3, 4, 5] },
  { id: 'dgb', label: 'D G B', strings: [2, 3, 4] },
  { id: 'adg', label: 'A D G', strings: [1, 2, 3] },
  { id: 'ead', label: 'E A D', strings: [0, 1, 2] },
];

const SPAN = 4; // a shape may reach across this many frets (a 5-fret window)
const LIVES = TEST.fast ? 1 : 3; // ?fast: one pick and a 3 s fall, so checks reach the end
const PER_LEVEL = 5; // clears per level
const FALL = [14, 12.5, 11.5, 11, 9.5, 8.5, 7.5, 6.8, 6.3, 6]; // seconds to fall, by level
const STAGGER = 0.6; // with two tiles, the second follows this far (of a fall) behind
const fallSeconds = (level) => (TEST.fast ? 3 : FALL[Math.min(level, FALL.length) - 1]);
const REVEAL_MS = 1200; // how long a landed chord's answer stays on the neck
const WRONG_DROP = 0.07; // a wrong shape knocks every tile this far down
const POS_BONUS = 150;
const TILE_W = 184;
const LANES = 3;

const LEVEL_SAYS = {
  1: 'Level 1: major triads, any inversion',
  2: 'Level 2: minor triads join in',
  3: 'Level 3: slash chords name the bass',
  4: 'Level 4: all 12 roots, two at once',
  5: 'Level 5: diminished triads, faster',
};
// What the first tile of a level shows off, so the toast matches what falls next.
const LEVEL_FEATURE = { 2: 'min', 3: 'slash', 4: 'sharp', 5: 'dim' };
const INVERSIONS = ['Root position', '1st inversion', '2nd inversion'];
const ALL_ROOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const SHARP_ROOTS = [1, 3, 6, 8, 10];
const DIM_ROOTS = [0, 1, 2, 4, 6, 7, 8, 9, 11]; // these spell without double flats

const CSS = `
.td-play { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; padding: 0 16px 4px; }
.td-zone { position: relative; flex: 1; min-height: 0; width: 100%; }
.td-lines, .td-fx { position: absolute; inset: 0; pointer-events: none; }
.td-lines { overflow: hidden; }
.td-fx { z-index: 3; }

.td-tile { position: absolute; left: 0; top: 0; width: ${TILE_W}px; z-index: 1; pointer-events: none; will-change: transform; }
.td-tile.is-active { z-index: 2; }
.td-card { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 8px 8px;
  border: 2px solid var(--edge); border-radius: 14px; box-shadow: 0 4px 0 var(--shadow);
  background: color-mix(in srgb, var(--game) 28%, var(--surface)); color: var(--ink-2);
  transform: scale(0.84); transition: transform 0.16s ease-out, background-color 0.16s, color 0.16s;
  animation: td-in 0.18s ease-out; }
.td-tile.is-active .td-card { background: var(--game); color: var(--on-game); transform: none; }
.td-tile.is-danger .td-card { box-shadow: 0 4px 0 var(--shadow), 0 0 0 3px var(--bad); }
.td-tile.is-landed .td-card { background: var(--bad); color: var(--on-game); transform: none; box-shadow: 0 2px 0 var(--shadow); }
.td-tile.is-hit .td-card { animation: td-hit 0.24s ease-out; }
.td-tile.is-burst .td-card { animation: td-burst 0.2s ease-out forwards; }
.td-tile.is-gone .td-card { animation: td-gone 0.2s ease-in forwards; }
.td-sym { font: 700 50px/1 var(--font-label); letter-spacing: 0.01em; white-space: nowrap; }
.td-sym .acc-sym { font-size: 0.7em; top: -0.22em; -webkit-text-stroke: 0.035em currentColor; }
.td-spell { font: 600 16px/1 var(--font-label); letter-spacing: 0.06em; word-spacing: 0.34em; white-space: nowrap; opacity: 0.8; }

.td-line { position: absolute; left: 0; top: 0; width: 4px; height: 240px; margin-left: -2px; opacity: 0;
  background: repeating-linear-gradient(to bottom, var(--ink-3) 0 5px, transparent 5px 11px); }
.td-pad { position: absolute; left: 0; bottom: 0; width: 104px; height: 5px; margin-left: -52px; border-radius: 3px 3px 0 0; background: var(--ink-3); opacity: 0; }
.td-line.is-on, .td-pad.is-on { opacity: 1; }
.td-line.is-danger { background: repeating-linear-gradient(to bottom, var(--bad) 0 5px, transparent 5px 11px); }
.td-pad.is-danger { background: var(--bad); }

.td-pop { position: absolute; left: 0; top: 0; font: 700 36px/1 var(--font-label); letter-spacing: 0.02em; color: var(--ink);
  white-space: nowrap; font-variant-numeric: tabular-nums; animation: td-pop 0.8s ease-out forwards; }
.td-bit { position: absolute; left: 0; top: 0; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 3px;
  background: var(--game); border: 1.5px solid var(--edge); animation: td-bit 0.42s cubic-bezier(0.15, 0.7, 0.3, 1) forwards; }
.td-bit.is-ink { background: var(--ink); }

.td-pips { display: inline-flex; align-items: center; gap: 4px; height: 24px; }
.td-pips i { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--ink-3); }
.td-pips i.is-on { background: var(--game); border-color: var(--edge); }
.td-lv { display: inline-flex; align-items: center; gap: 7px; }
.td-ticks { display: inline-flex; gap: 2px; }
.td-ticks i { width: 4px; height: 13px; border-radius: 1.5px; background: color-mix(in srgb, var(--ink-3) 40%, transparent); }
.td-ticks i.is-on { background: var(--ink); }
.td-keep { text-transform: none; }
.td-nowrap { white-space: nowrap; }

.td-play .fb-mk-in { transform: scale(1.2); }
.td-play .fb-mk.td-shake .fb-mk-in { animation: td-shake 0.3s ease-in-out; }
.td-play .fb-shade.k-pos { fill: var(--game); opacity: 0.2; }
.td-play .fretboard.td-thud { animation: td-thud 0.2s ease-out; }

@keyframes td-in { from { transform: scale(0.6); opacity: 0; } }
@keyframes td-hit { 0%, 60% { box-shadow: 0 4px 0 var(--shadow), 0 0 0 4px var(--bad); } }
@keyframes td-burst { to { transform: scale(1.22); opacity: 0; } }
@keyframes td-gone { to { transform: scale(0.9); opacity: 0; } }
@keyframes td-pop {
  0% { opacity: 0; transform: translate(-50%, 8px) scale(0.6); }
  16% { opacity: 1; transform: translate(-50%, -4px) scale(1.12); }
  30% { opacity: 1; transform: translate(-50%, -6px) scale(1); }
  75% { opacity: 1; transform: translate(-50%, -12px) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -20px) scale(1); }
}
@keyframes td-bit {
  from { transform: translate(var(--x0), var(--y0)); }
  to { transform: translate(var(--x1), var(--y1)) rotate(140deg) scale(0.3); opacity: 0; }
}
@keyframes td-shake {
  0%, 100% { transform: translateX(0) scale(1.2); }
  20% { transform: translateX(-6px) scale(1.2); }
  40% { transform: translateX(6px) scale(1.2); }
  60% { transform: translateX(-4px) scale(1.2); }
  80% { transform: translateX(3px) scale(1.2); }
}
@keyframes td-thud { 35% { transform: translateY(4px); } }
`;

/** Every close-voiced way to play these three pitch classes on three adjacent strings. */
function shapesFor(pcs, strings, bass = null) {
  const [a, b, c] = strings;
  const out = [];
  for (let fa = 0; fa <= MAX_FRET; fa++) {
    const pa = pcAt(a, fa);
    if (!pcs.includes(pa) || (bass != null && pa !== bass)) continue;
    for (let fm = 0; fm <= MAX_FRET; fm++) {
      const pb = pcAt(b, fm);
      if (pb === pa || !pcs.includes(pb)) continue;
      for (let fc = 0; fc <= MAX_FRET; fc++) {
        const pc = pcAt(c, fc);
        if (pc === pa || pc === pb || !pcs.includes(pc)) continue;
        const lo = Math.min(fa, fm, fc);
        const hi = Math.max(fa, fm, fc);
        if (hi - lo <= SPAN) out.push({ frets: [fa, fm, fc], lo, hi });
      }
    }
  }
  return out;
}

/** bassIdx 0 = any inversion; 1 or 2 = slash chord with the 3rd or 5th in the bass. */
function buildTarget(root, type, bassIdx, strings) {
  const ch = chord(root, type);
  const bass = bassIdx ? ch.pcs[bassIdx] : null;
  const order = [0, 1, 2].map((i) => (i + bassIdx) % 3);
  return {
    chord: ch,
    root,
    type,
    bassIdx,
    bass,
    name: bassIdx ? `${ch.name}/${ch.notes[bassIdx]}` : ch.name,
    spell: order.map((i) => ch.notes[i]).join(' '),
    shapes: shapesFor(ch.pcs, strings, bass),
  };
}

function pickTarget({ level, feature, strings, avoid, missed, r }) {
  // A chord that landed earlier comes round again now and then.
  if (!feature && missed.length && r() < 0.3) {
    const m = r.pick(missed);
    const t = buildTarget(m.root, m.type, m.bassIdx, strings);
    if (!avoid.has(t.name)) return t;
  }
  for (let i = 0; i < 80; i++) {
    let type = 'maj';
    if (feature === 'dim' || feature === 'min') type = feature;
    else if (level >= 5 && r() < 0.25) type = 'dim';
    else if (level >= 2 && r() < 0.5) type = 'min';
    let roots = feature === 'sharp' ? SHARP_ROOTS : level >= 4 ? ALL_ROOTS : NATURAL_PCS;
    if (type === 'dim') roots = roots.filter((x) => DIM_ROOTS.includes(x));
    const slash = level >= 3 && type !== 'dim' && (feature === 'slash' || r() < 0.45);
    const t = buildTarget(r.pick(roots), type, slash ? 1 + r.int(2) : 0, strings);
    if (!avoid.has(t.name) && t.shapes.length) return t;
  }
  return buildTarget(0, 'maj', 0, strings);
}

const game = {
  id: ID,
  title: 'Triad Drop',
  kind: 'Falling chords',
  color: 'var(--mist)',
  knobs: [60, -35],
  boards: { day: { title: 'Today', unit: 'points' }, best: { title: 'All time', unit: 'points' } },
  /** This browser's scores for the shared boards: today's best on any string set, and the best ever. */
  scores() {
    const d = store.get(ID, 'day', null);
    const today = d && d.key === todayKey() ? Object.values(d.best || {}) : [];
    return { day: today.length ? Math.max(...today) : null, best: store.topBest(ID) };
  },
  /** Short text for the pedal's display on the hub. */
  readout() {
    const b = store.topBest(ID);
    return b == null ? null : String(b);
  },

  mount(root, app) {
    ui.injectCSS(ID, CSS);
    const life = lifecycle();
    let run = null; // lifecycle of the current run
    const scr = ui.gameScreen(root, game, { onBack: app.exit });
    // spell: null means "on when starting at level 1" until the player picks.
    const cfg = { set: 'gbe', level: 1, spell: null, ...store.get(ID, 'cfg', {}) };
    const saveCfg = () => store.set(ID, 'cfg', cfg);
    const curSet = () => SETS.find((s) => s.id === cfg.set) || SETS[0];
    const spellOn = () => cfg.spell ?? cfg.level === 1;

    function showIntro() {
      run?.dispose();
      scr.el.querySelectorAll('.overlay, .toast').forEach((o) => o.remove());
      scr.hud.setStats([]);
      const set = curSet();
      const best = store.best(ID, set.id);
      ui.intro(scr, {
        title: 'Triad Drop',
        tagline: 'Chords fall. Build each one on three strings before it lands.',
        steps: [
          'A chord falls. Let it land and you lose a pick.',
          'Tap one note on each string. Any inversion counts.',
          'Three in a row inside the lit frets earns a bonus.',
        ],
        options: [
          ui.segmented({
            label: 'String set',
            options: SETS.map((s) => ({ value: s.id, label: s.label })),
            value: set.id,
            onChange: (v) => {
              cfg.set = v;
              saveCfg();
              showIntro();
            },
          }),
          ui.segmented({
            label: 'Start level',
            options: [1, 2, 3].map((n) => ({ value: n, label: String(n) })),
            value: cfg.level,
            onChange: (v) => {
              cfg.level = v;
              saveCfg();
              showIntro();
            },
          }),
          ui.segmented({
            label: 'Spell it out',
            options: [
              { value: true, label: 'On' },
              { value: false, label: 'Off' },
            ],
            value: spellOn(),
            onChange: (v) => {
              cfg.spell = v;
              saveCfg();
            },
          }),
        ],
        best: best == null ? null : { label: `Best on ${set.label}`, value: best },
        onStart: start,
      });
    }

    async function start() {
      run?.dispose();
      run = lifecycle();
      scr.el.querySelectorAll('.overlay, .toast').forEach((o) => o.remove());

      const set = curSet();
      const strings = set.strings; // low to high
      const spell = spellOn();
      const r = rng();

      // ---- run state ----
      let state = 'ready'; // ready | play | reveal | over
      let level = clamp(cfg.level, 1, 3);
      let feature = LEVEL_FEATURE[level] ?? null;
      let lives = LIVES;
      let score = 0;
      let cleared = 0;
      let wrong = 0;
      let posBonuses = 0;
      let held = 0; // bonus points already won but not yet shown
      let clock = 0; // seconds of actual play, so pauses never count
      let nextSpawn = 0.25;
      let nextId = 1;
      let active = null; // the lowest tile: the one a shape is checked against
      let lastLane = -1;
      let lastName = '';
      let lastShape = null;
      let posRun = []; // shapes cleared in a row inside one 5-fret window
      let fx = null; // feedback dots on the neck: { cells, timer }
      const tiles = [];
      const placed = new Map(); // string -> fret
      const landed = {}; // chord name -> times it landed this run
      const missed = []; // landed chords, to bring back later

      // ---- build the play screen ----
      const livesUI = ui.lives(LIVES);
      const pips = h('span', { class: 'td-pips' }, h('i'), h('i'), h('i'));
      const ticks = h('span', { class: 'td-ticks' }, Array.from({ length: PER_LEVEL }, () => h('i')));
      const levelNum = h('span', null, String(level));
      scr.hud.setStats([
        { key: 'pos', label: 'In position', value: pips },
        { key: 'level', label: 'Level', value: h('span', { class: 'td-lv' }, ticks, levelNum) },
        { key: 'lives', label: 'Picks', value: livesUI.el },
        { key: 'score', label: 'Score', value: 0 },
      ]);
      const lines = h('div', { class: 'td-lines' });
      const fxLayer = h('div', { class: 'td-fx' });
      const zone = h('div', { class: 'td-zone' }, lines, fxLayer);
      const play = h('div', { class: 'td-play', dataset: { strings: strings.join(','), set: set.id } }, zone);
      scr.body.replaceChildren(play);
      const fb = createFretboard(play, { strings, rowH: 44, pluck: false, onTap });
      fb.setEnabled(false);
      const zoneW = zone.clientWidth;
      const floorY = zone.clientHeight + 1; // a tile lands when its foot gets here
      const TOP_Y = 5;
      const zoneX = zone.offsetLeft; // zone -> stage coordinates, for toasts
      const zoneY = scr.body.offsetTop + zone.offsetTop;

      function sync() {
        Object.assign(play.dataset, {
          state,
          level,
          lives,
          score,
          cleared,
          wrong,
          posrun: posRun.length,
          posbonus: posBonuses,
        });
      }

      /** ui.toast, moved out of the tiles' way: the HUD strip unless x/y are given. */
      function say(text, { kind = 'info', ms = 1300, x = null, y = 5 } = {}) {
        const el = ui.toast(scr, text, { kind, ms });
        const mid = scr.hud.mid;
        const half = el.offsetWidth / 2;
        el.style.left = `${clamp(x ?? mid.offsetLeft + mid.offsetWidth / 2, half + 8, scr.el.clientWidth - half - 8)}px`;
        el.style.top = `${y}px`;
        return el;
      }

      /** Five ticks fill toward the next level; they stay full until it is announced. */
      function renderLevel(full = false) {
        const n = full ? PER_LEVEL : cleared % PER_LEVEL;
        [...ticks.children].forEach((t, i) => t.classList.toggle('is-on', i < n));
        if (!full) levelNum.textContent = String(level);
      }

      function showScore() {
        scr.hud.set('score', score - held);
        scr.hud.bump('score');
      }

      /** The pips count the run; the lit frets are where the next shape keeps it going. */
      function renderPos(full = false) {
        const n = full ? 3 : posRun.length;
        [...pips.children].forEach((p, i) => p.classList.toggle('is-on', i < n));
        fb.clearShades();
        if (!posRun.length) return;
        const lo = Math.min(...posRun.map((s) => s.lo));
        const hi = Math.max(...posRun.map((s) => s.hi));
        for (let f = Math.max(0, hi - SPAN); f <= Math.min(MAX_FRET, lo + SPAN); f++) {
          for (const s of strings) fb.shade(s, f, { kind: 'pos' });
        }
      }

      // ---- dots on the neck ----
      function clearFx() {
        if (!fx) return;
        clearTimeout(fx.timer);
        for (const c of fx.cells) fb.unmark(c.s, c.f);
        fb.clearLinks();
        fx = null;
      }
      function clearPlaced() {
        for (const [s, f] of placed) fb.unmark(s, f);
        placed.clear();
      }
      /** Show a whole shape with its degrees (R, 3, 5) for a beat. */
      function showShape(t, frets, kind, ms) {
        clearFx();
        const cells = strings.map((s, i) => ({ s, f: frets[i] }));
        for (const c of cells) fb.mark(c.s, c.f, { label: t.chord.degreeOf(pcAt(c.s, c.f)), kind });
        fb.link(cells[0], cells[1], { kind });
        fb.link(cells[1], cells[2], { kind });
        fx = { cells, timer: run.timeout(clearFx, ms) };
      }

      // ---- tiles ----
      const maxTiles = () => (level >= 4 ? 2 : 1);

      function setActive() {
        let a = null;
        for (const t of tiles) if (!a || t.p > a.p) a = t;
        if (a === active) return;
        active = a;
        for (const t of tiles) {
          const on = t === a;
          t.el.classList.toggle('is-active', on);
          t.line.classList.toggle('is-on', on);
          t.pad.classList.toggle('is-on', on);
        }
      }

      function draw(dt) {
        const k = dt ? 1 - Math.exp(-dt * 22) : 1; // eases the jolt after a wrong shape
        for (const t of tiles) {
          const target = TOP_Y + (floorY - t.h - TOP_Y) * Math.min(1, t.p);
          t.y += (target - t.y) * k;
          t.el.style.transform = `translate3d(${t.x}px,${t.y.toFixed(2)}px,0)`;
          t.line.style.transform = `translate3d(${t.cx}px,${(t.y + t.h + 8).toFixed(2)}px,0)`;
          const danger = t === active && t.p > 0.72;
          if (danger !== t.danger) {
            t.danger = danger;
            t.el.classList.toggle('is-danger', danger);
            t.line.classList.toggle('is-danger', danger);
            t.pad.classList.toggle('is-danger', danger);
          }
        }
      }

      function spawn() {
        const avoid = new Set(tiles.map((t) => t.name));
        if (lastName) avoid.add(lastName);
        const tg = pickTarget({ level, feature, strings, avoid, missed, r });
        feature = null;
        const taken = tiles.map((t) => t.lane);
        let lanes = [...Array(LANES).keys()].filter((l) => !taken.includes(l) && l !== lastLane);
        if (!lanes.length) lanes = [...Array(LANES).keys()].filter((l) => !taken.includes(l));
        const lane = r.pick(lanes);
        const el = h(
          'div',
          { class: 'td-tile', dataset: { id: nextId++, chord: tg.name, root: tg.root, type: tg.type, pcs: tg.chord.pcs.join(','), bass: tg.bass ?? '' } },
          h('div', { class: 'td-card' }, h('span', { class: 'td-sym' }, ui.noteEl(tg.name)), spell ? h('span', { class: 'td-spell', html: ui.noteHTML(tg.spell) }) : null),
        );
        const line = h('i', { class: 'td-line' });
        const pad = h('i', { class: 'td-pad' });
        zone.append(el);
        lines.append(line, pad);
        const cx = (zoneW * (lane + 0.5)) / LANES;
        pad.style.transform = `translate3d(${cx}px,0,0)`;
        const t = { ...tg, el, line, pad, lane, cx, x: cx - TILE_W / 2, y: TOP_Y, h: el.offsetHeight, p: 0, dur: fallSeconds(level), sec: Infinity, danger: false };
        tiles.push(t);
        lastLane = lane;
        nextSpawn = clock + (maxTiles() > 1 ? t.dur * STAGGER : 0);
        setActive();
        draw(0);
        audio.sfx('tock');
      }

      function retire(t) {
        tiles.splice(tiles.indexOf(t), 1);
        t.line.remove();
        t.pad.remove();
        lastName = t.name;
        if (active === t) active = null;
        setActive();
      }

      function burst(t, gained) {
        const cx = t.cx;
        const cy = t.y + t.h / 2;
        t.el.classList.add('is-burst');
        run.timeout(() => t.el.remove(), 220);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + r() * 0.5;
          const far = 0.75 + r() * 0.5;
          const bit = h('i', { class: `td-bit${i % 3 === 0 ? ' is-ink' : ''}` });
          bit.style.left = `${cx}px`;
          bit.style.top = `${cy}px`;
          bit.style.setProperty('--x0', `${(Math.cos(a) * 70).toFixed(0)}px`);
          bit.style.setProperty('--y0', `${(Math.sin(a) * 26).toFixed(0)}px`);
          bit.style.setProperty('--x1', `${(Math.cos(a) * 150 * far).toFixed(0)}px`);
          bit.style.setProperty('--y1', `${(Math.sin(a) * 78 * far).toFixed(0)}px`);
          fxLayer.append(bit);
          run.timeout(() => bit.remove(), 460);
        }
        const popY = clamp(cy - 42, 22, floorY - 86);
        const pop = h('div', { class: 'td-pop' }, `+${gained}`);
        pop.style.left = `${cx}px`;
        pop.style.top = `${popY}px`;
        fxLayer.append(pop);
        run.timeout(() => pop.remove(), 820);
        return { x: zoneX + cx, y: zoneY + popY + 42 };
      }

      function announceLevel() {
        renderLevel();
        scr.hud.bump('level');
        audio.sfx('level');
        say(LEVEL_SAYS[level] ?? `Level ${level}: faster still`, { ms: 1800 });
      }

      function clear(t, frets, pcs) {
        const shape = { frets, lo: Math.min(...frets), hi: Math.max(...frets) };
        const inv = t.chord.pcs.indexOf(pcs[0]);
        const gained = 100 + Math.round(((1 - Math.min(1, t.p)) * 100) / 5) * 5; // the higher the tile, the more it is worth
        score += gained;
        cleared++;
        lastShape = shape;
        const i = missed.findIndex((m) => m.root === t.root && m.type === t.type && m.bassIdx === t.bassIdx);
        if (i >= 0) missed.splice(i, 1);

        audio.strum(strings.map((s, j) => midiAt(s, frets[j])), { gain: 0.6, dur: 1.8 });
        placed.clear(); // showShape re-marks the same cells and owns them from here
        showShape(t, frets, 'good', 700);
        retire(t);
        const at = burst(t, gained);
        say(INVERSIONS[inv], { kind: 'good', ms: 1000, x: at.x, y: at.y });
        play.dataset.last = INVERSIONS[inv];
        showScore();

        // Voice leading: three shapes running that share one 5-fret window.
        const lo = Math.min(shape.lo, ...posRun.map((s) => s.lo));
        const hi = Math.max(shape.hi, ...posRun.map((s) => s.hi));
        posRun = hi - lo <= SPAN ? [...posRun, shape] : [shape];
        let wait = 0;
        if (posRun.length >= 3) {
          posRun = [];
          posBonuses++;
          score += POS_BONUS; // counted now, celebrated once the strum has rung
          held += POS_BONUS;
          renderPos(true);
          wait = 650;
          run.timeout(() => {
            held -= POS_BONUS;
            showScore();
            scr.hud.bump('pos');
            audio.sfx('great');
            say(`Stayed in position +${POS_BONUS}`, { kind: 'good', ms: 1200 });
            run.timeout(() => renderPos(), 700);
          }, wait);
        } else {
          renderPos();
        }
        // Level up every few clears. The rules change now; the fanfare follows the strum.
        const up = cleared % PER_LEVEL === 0;
        if (up) {
          level++;
          feature = LEVEL_FEATURE[level] ?? null;
          wait += 650;
          run.timeout(announceLevel, wait);
        }
        renderLevel(up);
        // The next tile: straight away if the screen is empty, with a breath on a level-up.
        if (!tiles.length) nextSpawn = clock + (up ? (wait + 300) / 1000 : 0.45);
        else nextSpawn = Math.max(nextSpawn, clock + 0.45);
        sync();
      }

      function miss(t, { tones, close, midi }) {
        wrong++;
        audio.pluck(midi, { gain: 0.45, dur: 0.6 });
        audio.sfx('bad');
        clearFx();
        const cells = [...placed].map(([s, f]) => ({ s, f }));
        for (const c of cells) fb.mark(c.s, c.f, { label: t.chord.nameOf(pcAt(c.s, c.f)), kind: 'bad' }).classList.add('td-shake');
        placed.clear();
        fx = { cells, timer: run.timeout(clearFx, 340) };
        for (const tile of tiles) {
          tile.p = Math.min(1, tile.p + WRONG_DROP);
          tile.el.classList.remove('is-hit');
          void tile.el.offsetWidth;
          tile.el.classList.add('is-hit');
        }
        if (tones && !close) say('Right notes. Keep them within 5 frets', { kind: 'bad' });
        else if (tones) say(`Right notes. ${t.chord.nameOf(t.bass)} goes on the ${STRING_LETTERS[strings[0]]} string`, { kind: 'bad', ms: 1600 });
        sync();
      }

      function onTap({ s, f, midi, pc }) {
        if (state !== 'play') return;
        clearFx();
        const t = active;
        if (!t) {
          audio.pluck(midi, { gain: 0.5, dur: 1 });
          return;
        }
        if (placed.get(s) === f) {
          placed.delete(s);
          fb.unmark(s, f);
          audio.sfx('tap');
          return;
        }
        if (placed.has(s)) fb.unmark(s, placed.get(s));
        placed.set(s, f);
        fb.mark(s, f, { label: t.chord.nameOf(pc), kind: 'accent' });
        if (placed.size < 3) {
          audio.pluck(midi, { gain: 0.7, dur: 1.5 });
          return;
        }
        // All three strings have a dot: check the shape at once.
        const frets = strings.map((st) => placed.get(st));
        const pcs = strings.map((st, i) => pcAt(st, frets[i]));
        const tones = new Set(pcs).size === 3 && pcs.every((x) => t.chord.pcs.includes(x));
        const close = Math.max(...frets) - Math.min(...frets) <= SPAN;
        const bassOk = t.bass == null || pcs[0] === t.bass;
        if (tones && close && bassOk) clear(t, frets, pcs);
        else miss(t, { tones, close, midi });
      }

      /** The shape to show for a landed chord: nearest to where the player was, else lowest. */
      function answerFor(t) {
        const mid = (sh) => (sh.lo + sh.hi) / 2;
        const ref = placed.size ? [...placed.values()].reduce((n, f) => n + f, 0) / placed.size : lastShape ? mid(lastShape) : null;
        return [...t.shapes].sort((a, b) => (ref == null ? 0 : Math.abs(mid(a) - ref) - Math.abs(mid(b) - ref)) || a.hi - b.hi || a.lo - b.lo)[0];
      }

      function land(t) {
        state = 'reveal';
        fb.setEnabled(false);
        const ans = answerFor(t);
        clearFx();
        clearPlaced();
        t.p = 1;
        t.y = floorY - t.h;
        t.el.style.transform = `translate3d(${t.x}px,${t.y}px,0)`;
        t.el.classList.remove('is-danger');
        t.el.classList.add('is-active', 'is-landed');
        retire(t);
        lives--;
        livesUI.set(lives);
        scr.hud.bump('lives');
        landed[t.name] = (landed[t.name] || 0) + 1;
        if (!missed.some((m) => m.root === t.root && m.type === t.type && m.bassIdx === t.bassIdx)) missed.push({ root: t.root, type: t.type, bassIdx: t.bassIdx });
        posRun = [];
        renderPos();
        audio.sfx('drop');
        fb.el.classList.remove('td-thud');
        void fb.el.offsetWidth;
        fb.el.classList.add('td-thud');
        // One way to play it, with its degrees, and how it sounds.
        showShape(t, ans.frets, 'ink', REVEAL_MS);
        run.timeout(() => audio.strum(strings.map((s, j) => midiAt(s, ans.frets[j])), { gain: 0.4, dur: 1.2 }), 260);
        say(h('span', null, 'Missed ', ui.noteEl(t.name, 'td-keep'), '. Here is one shape'), { kind: 'bad', ms: REVEAL_MS });
        sync();
        run.timeout(() => {
          t.el.classList.add('is-gone');
          run.timeout(() => t.el.remove(), 200);
          if (lives <= 0) {
            finish();
            return;
          }
          state = 'play';
          fb.setEnabled(true);
          nextSpawn = Math.max(nextSpawn, clock + 0.4);
          sync();
        }, REVEAL_MS);
      }

      function finish() {
        state = 'over';
        fb.setEnabled(false);
        clearFx();
        sync();
        const rec = store.recordRun(ID, score, { mode: set.id });
        // Today's tally: which chords landed, and the best score per string set.
        const saved = store.get(ID, 'day', null);
        const day = saved && saved.key === todayKey() ? saved : { key: todayKey(), landed: {}, best: {} };
        for (const name in landed) day.landed[name] = (day.landed[name] || 0) + landed[name];
        day.best[set.id] = Math.max(day.best[set.id] ?? 0, score);
        store.set(ID, 'day', day);
        const hardest = Object.keys(day.landed).sort((a, b) => day.landed[b] - day.landed[a] || (landed[b] || 0) - (landed[a] || 0))[0];
        const isBest = rec.isBest && rec.plays > 1 && score > 0;
        audio.sfx(isBest ? 'win' : 'lose');
        run.dispose();
        const board = resultsBoard({ gameId: ID, kind: 'day', you: Math.max(...Object.values(day.best)), cpu: ui.houseScores(dailySeed(ID), { count: 7, min: 300, max: 5200, round: 5 }) });
        const res = ui.results(scr, {
          title: 'Out of picks',
          big: score,
          unit: 'points',
          badge: isBest ? 'New best' : null,
          rows: [
            ['Chords cleared', cleared],
            ['Level reached', level],
            ['Hardest today', hardest ? ui.noteEl(hardest, 'td-nowrap') : '-'],
            ['Position bonuses', posBonuses],
          ],
          board,
          boardTitle: "Today's board",
          actions: [
            { label: 'Again', kind: 'primary', onClick: start },
            { label: 'Options', onClick: showIntro },
          ],
        });
        life.add(() => res.close());
      }

      // ---- go ----
      renderLevel();
      sync();
      await ui.countdown(scr, run);
      state = 'play';
      fb.setEnabled(true);
      say(LEVEL_SAYS[level], { ms: 1600 });
      sync();
      run.loop((dt) => {
        if (state !== 'play') return;
        clock += dt;
        if (tiles.length < maxTiles() && clock >= nextSpawn) spawn();
        for (const t of tiles) t.p += dt / t.dur;
        setActive();
        if (active) {
          // Count the last three seconds out loud.
          const sec = Math.ceil((1 - active.p) * active.dur);
          if (sec < active.sec && sec >= 1 && sec <= 3) audio.sfx('tick');
          active.sec = sec;
        }
        draw(dt);
        const down = tiles.find((t) => t.p >= 1);
        if (down) land(down);
      });
    }

    showIntro();
    return () => {
      run?.dispose();
      life.dispose();
    };
  },
};

export default game;
