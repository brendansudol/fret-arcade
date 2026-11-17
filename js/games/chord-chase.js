// Chord-Tone Chase: a backing track loops through a chord progression and on
// beat 1 of every bar you have to be playing a note of the new chord, ideally
// its 3rd or 7th (the guide tones). Everything between the bar lines is free
// playing. The moment you land, the game tells you what that note was in the
// chord; that instant "that was the 3rd" is the lesson.
//
// Timing: the backing track is scheduled on audio.clock. Bar b (0-based)
// starts at clock beat (b + 1) * 4, after one bar of count-in clicks. A tap is
// stamped with audio.now() minus the output latency (the player taps to what
// they hear) and judged by the pure function judgeTap() below. All visuals
// are derived from clock.beatAt() in an animation loop.

import { rng, dailySeed, dayNumber, todayKey, lifecycle, clamp, TEST } from '../core/util.js';
import { chord, rootName, pcAt, mod12 } from '../core/theory.js';
import { audio } from '../core/audio.js';
import { store } from '../core/store.js';
import { createFretboard } from '../core/fretboard.js';
import * as ui from '../core/ui.js';
import { resultsBoard } from '../core/boards.js';

const ID = 'chord-chase';
const { h } = ui;

// ---- rules -------------------------------------------------------------------
const WINDOW = 0.2; // seconds either side of beat 1 in which a tap is judged
const PERFECT = 0.09; // inside this it scores in full
const GOOD_MULT = 0.7;
const SMOOTH_BONUS = 40;
// A touch screen reports a tap a few hundredths of a second after the finger
// lands. Allow for part of that so an on-the-beat tap is not called late.
const TOUCH_LAG = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 0.03 : 0;
const GUIDE_DEGREES = new Set(['3', '♭3', '7', '♭7']);
const WORDS = { guide: 'Guide tone', chord: 'Chord tone', outside: 'Outside', missed: 'Missed' };
const FLASH = { guide: 'good', chord: 'warn', outside: 'bad' };

/**
 * Judge one tap against one bar line. Pure: no clock, no state.
 *   tapTime, barTime  AudioContext seconds (tapTime already latency-corrected)
 *   pc                pitch class that was played
 *   ch                chord() of the bar that starts at barTime
 * -> { inWindow: false, dt } when the tap is free playing, otherwise
 *    { inWindow, dt, timing: 'perfect' | 'good', mult, kind: 'guide' | 'chord' | 'outside',
 *      degree, label, word, base, points }
 */
function judgeTap(tapTime, barTime, pc, ch) {
  const dt = tapTime - barTime; // negative = early
  if (Math.abs(dt) > WINDOW) return { inWindow: false, dt };
  const timing = Math.abs(dt) <= PERFECT ? 'perfect' : 'good';
  const mult = timing === 'perfect' ? 1 : GOOD_MULT;
  const degree = ch.degreeOf(pc);
  const kind = degree == null ? 'outside' : GUIDE_DEGREES.has(degree) ? 'guide' : 'chord';
  const base = kind === 'guide' ? 100 : kind === 'chord' ? 60 : 0;
  return { inWindow: true, dt, timing, mult, kind, degree, label: degree ?? ch.nameOf(pc), word: WORDS[kind], base, points: Math.round(base * mult) };
}

/** Voice leading: two chord tones on neighbouring bars, no more than a whole step apart. */
function isSmooth(prev, cur) {
  return !!prev && prev.bar === cur.bar - 1 && prev.kind !== 'outside' && cur.kind !== 'outside' && Math.abs(cur.midi - prev.midi) <= 2;
}

// ---- music -------------------------------------------------------------------
// bars: [semitones above the key, chord type]. keys: transpositions the daily
// may pick (ones where every chord gets its everyday spelling).
const I7 = [0, '7'];
const IV7 = [5, '7'];
const V7 = [7, '7'];
const PROGS = [
  { id: 'ii-v-i', short: 'ii-V-I', home: 0, minor: false, length: 16, keys: [0, 5, 10, 3, 7, 2, 9], bars: [[2, 'm7'], [7, '7'], [0, 'maj7'], [0, 'maj7']], end: [0, 'maj7'], blurb: 'the cadence at the heart of jazz' },
  { id: 'blues', short: 'Blues', home: 9, minor: false, length: 24, keys: [9, 4, 7, 0, 2, 5, 10], bars: [I7, I7, I7, I7, IV7, IV7, I7, I7, V7, IV7, I7, V7], end: I7, blurb: 'twelve bars, twice round' },
  { id: 'pop', short: 'Pop', home: 7, minor: false, length: 16, keys: [7, 0, 2, 9, 4, 5], bars: [[0, 'maj'], [7, 'maj'], [9, 'min'], [5, 'maj']], end: [0, 'maj'], blurb: 'four chords, a thousand songs' },
  { id: 'minor', short: 'Minor', home: 9, minor: true, length: 16, keys: [9, 2, 4, 7, 0, 11], bars: [[2, 'm7b5'], [7, '7'], [0, 'm7'], [0, 'm7']], end: [0, 'm7'], blurb: 'the same cadence, in the dark' },
];
const TEMPOS = { slow: 66, medium: 84, fast: 104 };
// Band levels, well under the kit's defaults so a plucked note (0.8) sits on top.
const MIX = { kick: 0.18, snare: 0.14, hat: 0.05, hatOff: 0.032, bass: 0.11, bassFifth: 0.095, keys: 0.04 };
const progById = (id) => PROGS.find((p) => p.id === id) || PROGS[0];
const progName = (p, key) => `${p.short} in ${rootName(key, p.minor ? 'min' : 'maj')}`;

function dailyPick() {
  const r = rng(dailySeed(ID));
  const p = r.pick(PROGS);
  return { p, key: r.pick(p.keys) };
}

/** chord() plus the notes the backing band plays for it. */
function bandChord([offset, type], key) {
  const ch = chord(key + offset, type);
  const bassRoot = 40 + mod12(ch.root - 4); // E2 .. D#3
  let bassFifth = bassRoot + mod12(ch.pcs[2] - ch.root);
  if (bassFifth > 52) bassFifth -= 12;
  // Close voicing from middle C up (phone speakers lose anything lower): a
  // pitch class always lands on the same key, so common tones hold still
  // from chord to chord.
  const voicing = ch.pcs.map((pc) => 60 + pc).sort((a, b) => a - b);
  return { ...ch, bassRoot, bassFifth, voicing };
}

function buildSong(p, key) {
  const n = TEST.fast ? 4 : p.length;
  return {
    name: progName(p, key),
    chords: Array.from({ length: n }, (_, i) => bandChord(p.bars[i % p.bars.length], key)),
    end: bandChord(p.end, key),
  };
}

const guideText = (ch) => `its 3rd is ${ch.notes[1]}${ch.notes.length > 3 ? `, its 7th is ${ch.notes[3]}` : ''}`;

if (TEST.fast && typeof window !== 'undefined') {
  // Scripted checks exercise the rules directly, then tap on run.barTime().
  window.__chordChase = { judgeTap, isSmooth, chord, dailyPick, progName, WINDOW, PERFECT, SMOOTH_BONUS, run: null };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const TRACK_W = 772;
const MARK_R = 13;
const RING_R = 26;

const CSS = `
.cc-play { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; padding: 0 16px 4px; }
.cc-top { flex: 1; width: 100%; display: flex; align-items: center; }
.cc-display { position: relative; width: 100%; height: 122px; display: grid; grid-template-columns: 252px 1fr 196px; grid-template-rows: 1fr 30px; column-gap: 14px; padding: 4px 18px 2px; }
.cc-display.is-hit { animation: cc-hit 0.24s ease-out; }
.cc-now { align-self: center; font-size: 64px; line-height: 1; white-space: nowrap; transform-origin: left center; }
.cc-now.is-long { font-size: 54px; }
.cc-now.is-new { animation: cc-land 0.18s ease-out; }
.cc-fb { align-self: center; display: flex; align-items: center; gap: 14px; min-width: 0; transform-origin: left center; transition: opacity 0.2s; }
.cc-fb.is-new { animation: cc-land 0.16s ease-out; }
.cc-fb.is-old { opacity: 0.32; }
.cc-deg { font-size: 52px; line-height: 1; min-width: 62px; text-align: center; white-space: nowrap; }
.cc-fb.is-hint .cc-deg { display: none; }
.cc-fb.is-guide .cc-deg { color: var(--good); }
.cc-fb.is-chord .cc-deg { color: var(--warn); }
.cc-fb.is-outside .cc-deg, .cc-fb.is-missed .cc-deg { color: var(--bad); }
.cc-fbt { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cc-word { font: 700 25px/1 var(--font-label); letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.cc-fb.is-hint .cc-word { font-size: 19px; color: var(--lcd-dim); }
.cc-sub { font: 600 12.5px/1 var(--font-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--lcd-dim); white-space: nowrap; }
.cc-sub b { font-weight: 700; color: var(--lcd-ink); }
.cc-sub .is-smooth { color: var(--good); }
.cc-next { align-self: center; justify-self: end; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.cc-next small { font: 600 11px/1 var(--font-label); letter-spacing: 0.16em; text-transform: uppercase; color: var(--lcd-dim); }
.cc-next b { font-size: 40px; line-height: 1; white-space: nowrap; }
.cc-track { grid-column: 1 / -1; position: relative; height: 30px; }
.cc-rail { position: absolute; left: 0; right: 0; top: 12px; height: 6px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--lcd-dim) 38%, transparent); }
.cc-fill { width: 100%; height: 100%; transform-origin: left center; transform: scaleX(0); background: var(--lcd-ink); opacity: 0.5; }
.cc-pip { position: absolute; top: 6px; width: 18px; height: 18px; border-radius: 50%; background: var(--lcd-bg); border: 2px solid var(--lcd-dim); }
.cc-pip.is-on { background: var(--lcd-ink); border-color: var(--lcd-ink); }
.cc-pip.is-one.is-on { background: var(--game); border-color: var(--game); }
.cc-end { position: absolute; right: 0; top: 1px; width: 6px; height: 28px; border-radius: 3px; background: var(--game); }
.cc-end.is-hit { animation: cc-end 0.24s ease-out; }
.cc-head { position: absolute; left: 0; top: 3px; width: 6px; height: 24px; border-radius: 3px; background: var(--lcd-ink); will-change: transform; }
.cc-head.is-near { background: var(--game); box-shadow: 0 0 10px var(--game); }
.cc-rings { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.cc-rings circle { fill: none; stroke: var(--game); stroke-width: 2.5; }
.cc-pop { position: absolute; z-index: 3; min-width: 38px; height: 30px; padding: 0 8px; display: grid; place-items: center; border-radius: 9px; border: 2px solid var(--board-edge); font: 700 19px/1 var(--font-label); color: var(--on-game); white-space: nowrap; pointer-events: none; transform: translate(-50%, -50%); animation: cc-pop 0.14s ease-out; }
.cc-pop.is-guide { background: var(--good); }
.cc-pop.is-chord { background: var(--warn); }
.cc-pop.is-outside { background: var(--bad); }
.cc-screen .hud-stats { gap: 22px; }
.cc-strip { display: flex; align-items: center; gap: 2px; }
.cc-cell { width: 9px; height: 13px; border-radius: 2.5px; border: 1.5px solid var(--ink-3); }
.cc-cell:nth-child(4n):not(:last-child) { margin-right: 5px; }
.cc-cell.is-now { border-color: var(--ink); background: var(--surface); }
.cc-cell.is-guide { background: var(--good); border-color: var(--edge); }
.cc-cell.is-chord { background: var(--warn); border-color: var(--edge); }
.cc-cell.is-outside { background: var(--bad); border-color: var(--edge); }
.cc-cell.is-missed { background: var(--ink-3); border-color: var(--ink-3); }
.cc-of { font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); margin-left: 4px; }
.cc-tip { font-size: 13px; line-height: 1.3; color: var(--ink-2); max-width: 330px; }
@keyframes cc-hit { from { box-shadow: inset 0 0 0 3px var(--game), inset 0 0 30px color-mix(in srgb, var(--game) 60%, transparent); } }
@keyframes cc-land { from { transform: scale(1.22); opacity: 0.25; } }
@keyframes cc-pop { from { transform: translate(-50%, -10%) scale(0.6); opacity: 0; } 70% { transform: translate(-50%, -50%) scale(1.12); opacity: 1; } }
@keyframes cc-end { from { transform: scale(2.4, 1.25); } }
`;

const game = {
  id: ID,
  title: 'Chord-Tone Chase',
  pedal: ['Chord-Tone', 'Chase'],
  kind: 'Land on the changes',
  color: 'var(--capri)',
  knobs: [-20, 75],
  boards: { day: { title: 'Today', unit: 'points' }, best: { title: 'All time', unit: 'points' } },
  /** This browser's scores for the shared boards (see core/boards.js). */
  scores() {
    const t = store.get(ID, 'today', {});
    return { day: t.key === todayKey() ? t.score : null, best: store.topBest(ID) };
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
    scr.el.classList.add('cc-screen');
    const cfg = { run: 'daily', prog: 'ii-v-i', tempo: 'medium', help: 'targets', ...store.get(ID, 'cfg', {}) };
    if (!TEMPOS[cfg.tempo]) cfg.tempo = 'medium';
    const saveCfg = () => store.set(ID, 'cfg', cfg);
    const currentPick = () => (cfg.run === 'daily' ? dailyPick() : { p: progById(cfg.prog), key: progById(cfg.prog).home });

    function clearScreen() {
      run?.dispose();
      run = null;
      scr.el.querySelectorAll('.overlay').forEach((o) => o.remove());
      scr.hud.mid.replaceChildren();
    }

    function showIntro() {
      clearScreen();
      scr.hud.setStats([]);
      const daily = cfg.run === 'daily';
      const { p, key } = currentPick();
      const name = progName(p, key);
      const names = [...new Set(p.bars.map((b) => chord(key + b[0], b[1]).name))].join(', ');
      const options = [
        ui.segmented({
          label: 'Run',
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
            label: 'Changes',
            options: PROGS.map((x) => ({ value: x.id, label: x.short })),
            value: p.id,
            onChange: (v) => {
              cfg.prog = v;
              saveCfg();
              showIntro();
            },
          }),
        );
      }
      options.push(
        ui.segmented({
          label: 'Tempo',
          options: [
            { value: 'slow', label: 'Slow' },
            { value: 'medium', label: 'Medium' },
            { value: 'fast', label: 'Fast' },
          ],
          value: cfg.tempo,
          onChange: (v) => {
            cfg.tempo = v;
            saveCfg();
          },
        }),
        ui.segmented({
          label: 'Help',
          options: [
            { value: 'targets', label: 'Show targets' },
            { value: 'roots', label: 'Roots only' },
            { value: 'none', label: 'None' },
          ],
          value: cfg.help,
          onChange: (v) => {
            cfg.help = v;
            saveCfg();
          },
        }),
      );
      const best = store.best(ID, daily ? 'daily' : p.id);
      ui.intro(scr, {
        title: 'Chord-Tone Chase',
        tagline: h('span', { html: ui.noteHTML(daily ? `Today: ${name} (${names}). Same changes for everyone.` : `${name}: ${names}, ${p.blurb}.`) }),
        steps: ['A band loops the chords. Play what you like in between.', 'On beat 1 of each bar, land on a note of the new chord.', '3rds and 7ths score most. Move a step or less for a Smooth bonus.'],
        options,
        best: best == null ? null : { label: daily ? 'Best daily' : `Best ${p.short}`, value: best },
        onStart: start,
      });
    }

    function start() {
      clearScreen();
      run = lifecycle();
      const daily = cfg.run === 'daily';
      const { p, key } = currentPick();
      const song = buildSong(p, key);
      const chords = song.chords;
      const N = chords.length;
      const bpm = TEST.fast ? 160 : TEMPOS[cfg.tempo];
      const help = cfg.help;

      // ---- build the play screen ----
      const nowEl = h('span', { class: 'cc-now dot' });
      const degEl = h('span', { class: 'cc-deg dot' });
      const wordEl = h('span', { class: 'cc-word' }, 'Land on beat 1');
      const subEl = h('span', { class: 'cc-sub' }, '3rds and 7ths score most');
      const fbEl = h('div', { class: 'cc-fb is-hint' }, degEl, h('div', { class: 'cc-fbt' }, wordEl, subEl));
      const nextCap = h('small', null, 'first chord');
      const nextEl = h('b', { class: 'dot' }, ui.noteEl(chords[0].name));
      const headX = (frac) => 9 + frac * (TRACK_W - 12);
      const pips = [0, 1, 2, 3].map((i) => h('i', { class: `cc-pip${i === 0 ? ' is-one' : ''}`, style: { left: `${headX(i / 4) - 9}px` } }));
      const fillEl = h('div', { class: 'cc-fill' });
      const endEl = h('i', { class: 'cc-end' });
      const headEl = h('i', { class: 'cc-head' });
      const display = h(
        'div',
        { class: 'display cc-display' },
        nowEl,
        fbEl,
        h('div', { class: 'cc-next' }, nextCap, nextEl),
        h('div', { class: 'cc-track' }, h('div', { class: 'cc-rail' }, fillEl), pips, endEl, headEl),
      );
      const play = h('div', { class: 'cc-play' }, h('div', { class: 'cc-top' }, display));
      scr.body.replaceChildren(play);
      const fb = createFretboard(play, { onTap });
      // Approach rings that close onto the target marks as the bar line arrives.
      const ringSvg = document.createElementNS(SVG_NS, 'svg');
      ringSvg.setAttribute('class', 'cc-rings');
      ringSvg.setAttribute('viewBox', `0 0 ${fb.width} ${fb.height}`);
      ringSvg.setAttribute('width', fb.width);
      ringSvg.setAttribute('height', fb.height);
      fb.el.append(ringSvg);

      const cells = chords.map(() => h('i', { class: 'cc-cell' }));
      scr.hud.mid.replaceChildren(h('div', { class: 'cc-strip', role: 'img', 'aria-label': 'Bars played' }, cells));
      const barValue = (n) => h('span', null, String(n), h('span', { class: 'cc-of' }, `of ${N}`));
      scr.hud.setStats([
        { key: 'bar', label: 'Bar', value: '' },
        { key: 'streak', label: 'Streak', value: 0 },
        { key: 'score', label: 'Score', value: 0 },
      ]);
      scr.hud.set('bar', barValue(1));

      // ---- run state ----
      const judged = new Array(N).fill(null); // per bar: { kind, pts, smooth, ... }
      const counts = { guide: 0, chord: 0, outside: 0, missed: 0 };
      const perChord = new Map(); // chord name -> { ch, bars, guide, chord, outside, missed }
      let score = 0;
      let streak = 0;
      let bestStreak = 0;
      let smooths = 0;
      let prev = null; // last judged note: { bar, midi, kind, s, f }
      let shownBar = -2; // bar the display is showing (-1 = count-in)
      let shownCount = 0;
      let shownBeat = -1;
      let markedFor = null; // bar whose targets are on the neck
      let rings = [];
      let fbBar = null; // bar the feedback text belongs to
      let checked = 0; // bars below this have been judged or marked missed
      let stalled = 0; // seconds the sound has been asleep
      let over = false;

      const restart = (el, cls) => {
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
      };
      const latency = () => {
        const c = audio.ctx;
        const l = c.outputLatency || c.baseLatency || 0;
        return Number.isFinite(l) ? clamp(l, 0, 0.35) : 0;
      };
      const heardNow = () => audio.now() - latency(); // the moment the player is hearing
      const barBeat = (b) => (b + 1) * 4;

      // ---- backing track ----
      const clock = audio.clock({
        bpm,
        onBeat(i, t) {
          if (t < audio.now() - 0.25) return; // woke up late: never play a burst of old beats
          const bar = Math.floor(i / 4) - 1;
          const b = i % 4;
          const spb = clock.spb;
          if (bar < 0) {
            audio.click(t, b === 0);
            return;
          }
          if (bar >= N) {
            if (bar === N && b === 0) {
              // The band lands on the home chord to finish.
              audio.kick(t, MIX.kick);
              audio.hat(t, MIX.hat, true);
              audio.bass(song.end.bassRoot, t, 1.3, MIX.bass);
              audio.keys(song.end.voicing, t, 1.5, MIX.keys);
              audio.strum(song.end.voicing, { when: t, gain: 0.22, dur: 2 });
            }
            return;
          }
          const ch = chords[bar];
          audio.hat(t, MIX.hat);
          audio.hat(t + spb / 2, MIX.hatOff);
          if (b === 0 || b === 2) audio.kick(t, MIX.kick);
          else {
            audio.snare(t, MIX.snare);
            audio.keys(ch.voicing, t, Math.min(0.5, spb * 0.8), MIX.keys);
          }
          if (b === 0) audio.bass(ch.bassRoot, t, spb * 1.5, MIX.bass);
          if (b === 2) audio.bass(ch.bassFifth, t, spb * 1.1, MIX.bassFifth);
        },
      });
      run.add(() => clock.stop());

      // ---- neck help ----
      function clearTargets() {
        fb.clearMarks();
        ringSvg.replaceChildren();
        rings = [];
        markedFor = null;
      }
      function showTargets(bar) {
        clearTargets();
        markedFor = bar;
        if (help === 'none') return;
        const ch = chords[bar];
        for (let s = 0; s < 6; s++) {
          for (let f = 0; f <= 12; f++) {
            const d = ch.degreeOf(pcAt(s, f));
            if (d === 'R') fb.mark(s, f, { label: 'R', kind: 'off', shape: 'square', small: true });
            else if (help === 'targets' && GUIDE_DEGREES.has(d)) {
              // Open strings sit beside the board, where a ghost outline would vanish.
              fb.mark(s, f, { label: d, kind: f === 0 ? 'off' : 'ghost' });
              const { x, y } = fb.xy(s, f);
              const c = document.createElementNS(SVG_NS, 'circle');
              c.setAttribute('cx', x);
              c.setAttribute('cy', y);
              c.setAttribute('r', RING_R);
              ringSvg.append(c);
              rings.push(c);
            }
          }
        }
      }

      /** After a slip, show where the guide tones were (with targets on they are already there). */
      function revealGuides(bar) {
        if (help === 'targets') return;
        const ch = chords[bar];
        for (let s = 0; s < 6; s++) {
          for (let f = 0; f <= 12; f++) {
            const d = ch.degreeOf(pcAt(s, f));
            if (GUIDE_DEGREES.has(d)) fb.flash(s, f, f === 0 ? 'off' : 'ghost', { label: d, ms: 700 });
          }
        }
      }

      // ---- feedback ----
      /** The same verdict as the cell flash, lifted clear of the finger that is covering it. */
      function popAbove(s, f, kind, label) {
        const { x, y } = fb.xy(s, f);
        const el = h('div', { class: `cc-pop is-${kind}`, style: { left: `${x}px`, top: `${y - 48}px` } }, ui.noteEl(label));
        fb.el.append(el);
        run.timeout(() => el.remove(), 850);
      }
      function showFeedback(bar, kind, big, sub) {
        fbBar = bar;
        fbEl.className = `cc-fb is-${kind}`;
        degEl.innerHTML = ui.noteHTML(big);
        wordEl.textContent = WORDS[kind];
        subEl.replaceChildren(...sub);
        restart(fbEl, 'is-new');
      }
      function tally(bar, kind) {
        const ch = chords[bar];
        if (!perChord.has(ch.name)) perChord.set(ch.name, { ch, bars: 0, guide: 0, chord: 0, outside: 0, missed: 0 });
        const rec = perChord.get(ch.name);
        rec.bars++;
        rec[kind]++;
        counts[kind]++;
        cells[bar].className = `cc-cell is-${kind}`;
        if (kind === 'guide' || kind === 'chord') {
          streak++;
          bestStreak = Math.max(bestStreak, streak);
        } else streak = 0;
        scr.hud.set('streak', streak);
        if (streak > 1) scr.hud.bump('streak');
      }

      function land(bar, j, { s, f, midi }) {
        const smooth = isSmooth(prev, { bar, midi, kind: j.kind });
        const pts = j.points + (smooth ? SMOOTH_BONUS : 0);
        judged[bar] = { ...j, smooth, pts, midi };
        score += pts;
        if (smooth) {
          smooths++;
          if (prev.s !== s || prev.f !== f) {
            const link = fb.link({ s: prev.s, f: prev.f }, { s, f }, { kind: 'good' });
            run.timeout(() => link.remove(), 700);
          }
        }
        prev = { bar, midi, kind: j.kind, s, f };
        tally(bar, j.kind);
        // A guide tone rings an octave above itself; a wrong note gets the buzzer.
        if (j.kind === 'guide') audio.pluck(midi + 12, { gain: 0.2, dur: 1.4 });
        else if (j.kind === 'outside') {
          audio.sfx('bad');
          revealGuides(bar);
        }
        fb.flash(s, f, FLASH[j.kind], { label: j.label, ms: 850 });
        popAbove(s, f, j.kind, j.label);
        const sub = [];
        if (j.kind === 'outside') sub.push(h('span', { html: ui.noteHTML(`Not in ${chords[bar].name}`) }));
        else {
          sub.push(h('b', null, `+${pts}`));
          if (j.timing !== 'perfect') sub.push(j.dt < 0 ? ' · Early' : ' · Late');
          if (smooth) sub.push(' · ', h('span', { class: 'is-smooth' }, 'Smooth'));
        }
        showFeedback(bar, j.kind, j.label, sub);
        scr.hud.set('score', score);
        if (pts) scr.hud.bump('score');
      }

      function miss(bar) {
        judged[bar] = { kind: 'missed', pts: 0 };
        tally(bar, 'missed');
        revealGuides(bar);
        showFeedback(bar, 'missed', 'X', ['No note on beat 1']);
      }

      function onTap({ s, f, midi, pc }) {
        if (over) return;
        const t = heardNow() - TOUCH_LAG;
        const beat = clock.beatAt(t);
        const line = Math.round(beat / 4); // nearest bar line, in clock bars
        const bar = line - 1;
        if (bar >= 0 && bar < N && !judged[bar]) {
          const j = judgeTap(t, clock.timeOf(line * 4), pc, chords[bar]);
          if (j.inWindow) {
            land(bar, j, { s, f, midi });
            return;
          }
        }
        // Anything else is free playing: it just sounds.
      }

      function setNow(text) {
        nowEl.innerHTML = ui.noteHTML(text);
        nowEl.classList.toggle('is-long', text.length > 5);
        restart(nowEl, 'is-new');
      }

      function enterBar(bar) {
        shownBar = bar;
        if (bar < 0) return; // count-in: the loop writes 1 2 3 4
        cells.forEach((c, i) => c.classList.toggle('is-now', i === bar));
        restart(display, 'is-hit');
        restart(endEl, 'is-hit');
        if (bar >= N) {
          setNow(song.end.name);
          nextCap.textContent = '';
          nextEl.textContent = '';
          return;
        }
        setNow(chords[bar].name);
        nextCap.textContent = bar + 1 < N ? 'next' : 'then';
        nextEl.replaceChildren(bar + 1 < N ? ui.noteEl(chords[bar + 1].name) : 'End');
        scr.hud.set('bar', barValue(bar + 1));
      }

      function finish() {
        if (over) return;
        over = true;
        run.dispose();
        const mode = daily ? 'daily' : p.id;
        const rec = store.recordRun(ID, score, { mode });
        if (daily) {
          const today = store.get(ID, 'today', {});
          const before = today.key === todayKey() ? today.score : -1;
          if (score > before) store.set(ID, 'today', { key: todayKey(), score });
        }
        // One line of advice, about the chord that went worst.
        const stats = [...perChord.values()];
        const slips = (r) => r.missed + r.outside;
        const worst = stats.slice().sort((a, b) => slips(b) - slips(a) || b.bars - b.guide - (a.bars - a.guide))[0];
        const harder = help !== 'none' ? 'Try it with less help on the neck.' : cfg.tempo !== 'fast' ? 'Try it faster.' : 'Try another set of changes.';
        let tip = `Every bar on a guide tone. ${harder}`;
        if (worst && slips(worst) > 0) tip = `Most misses on ${worst.ch.name}: ${guideText(worst.ch)}.`;
        else if (worst && worst.guide < worst.bars) tip = `You played safe on ${worst.ch.name}: ${guideText(worst.ch)}.`;
        const rows = [
          ['Guide tones', counts.guide],
          ['Chord tones', counts.chord],
          ['Outside', counts.outside],
          ['Missed', counts.missed],
          ['Best streak', bestStreak],
          ['Smooth moves', smooths],
        ];
        let boardRows = null;
        if (daily) {
          const top = 100 + (N - 1) * (100 + SMOOTH_BONUS);
          const todayBest = store.get(ID, 'today', {}).score ?? score;
          boardRows = resultsBoard({ gameId: ID, kind: 'day', you: todayBest, cpu: ui.houseScores(dailySeed(ID), { count: 7, min: Math.round(top * 0.22), max: Math.round(top * 0.88), round: 10 }) });
        }
        const squares = { guide: '🟩', chord: '🟨', outside: '🟥', missed: '⬛' };
        const shareLine = `Chord-Tone Chase${daily ? ` #${dayNumber()}` : ''} (${song.name}): ${score}\n${judged.map((j) => squares[j?.kind] || '⬛').join('')}`;
        const actions = [{ label: 'Again', kind: 'primary', onClick: start }];
        if (daily) {
          actions.push({
            label: 'Copy result',
            onClick: async () => {
              const ok = await ui.copyText(shareLine);
              ui.toast(scr, ok ? 'Copied' : 'Copy not available here', { kind: ok ? 'good' : 'info' });
            },
          });
        }
        actions.push({ label: 'Options', onClick: showIntro });
        const res = ui.results(scr, {
          title: ui.noteEl(daily ? `Daily #${dayNumber()}: ${song.name}` : song.name),
          big: score,
          unit: 'points',
          badge: rec.isBest && rec.previousBest != null && score > 0 ? 'New best' : null,
          rows,
          extra: h('p', { class: 'cc-tip', html: ui.noteHTML(tip) }),
          board: boardRows,
          boardTitle: "Today's board",
          actions,
        });
        life.add(() => res.close());
      }

      // ---- go ----
      clock.start(0.7);
      if (TEST.fast) {
        window.__chordChase.run = {
          clock,
          chords,
          N,
          latency,
          now: heardNow,
          barTime: (b) => clock.timeOf(barBeat(b)),
          state: () => ({ score, streak, bestStreak, smooths, counts: { ...counts }, judged: judged.map((j) => j && { kind: j.kind, pts: j.pts, timing: j.timing ?? null, smooth: !!j.smooth, label: j.label ?? null }), over, clockRunning: clock.running }),
        };
      }
      // A backgrounded tab freezes the clock; a run cannot survive that fairly.
      run.on(document, 'visibilitychange', () => {
        if (document.hidden && !over) showIntro();
      });

      run.loop((dt) => {
        if (over) return;
        // A phone can leave the sound asleep (after a call, say). Any tap wakes it.
        if (audio.ctx.state !== 'running') {
          if (stalled < 1.2 && (stalled += dt) >= 1.2) ui.toast(scr, 'Tap anywhere to wake the sound', { ms: 2600 });
          return;
        }
        stalled = 0;
        const t = heardNow();
        const beat = clock.beatAt(t);
        if (beat < 0) return; // the breath before the count-in
        const bar = Math.floor(beat / 4) - 1;
        const inBar = beat - barBeat(bar); // 0..4
        const bi = Math.min(3, Math.floor(inBar));

        if (bar !== shownBar) enterBar(bar);
        if (bar >= N) {
          // The last bar has rung out and the band has hit the final chord.
          if (clock.running) {
            clock.stop();
            fb.setEnabled(false);
            clearTargets();
            pips.forEach((pEl) => pEl.classList.remove('is-on'));
            headEl.style.transform = `translateX(${headX(0) - 3}px)`;
            headEl.classList.remove('is-near');
            fillEl.style.transform = 'scaleX(0)';
            run.timeout(finish, TEST.fast ? 400 : 1000);
          }
          return;
        }
        if (bar < 0 && shownCount !== bi + 1) {
          shownCount = bi + 1;
          setNow(String(shownCount));
        }

        // beat pips and the sweep toward the bar line
        if (bi !== shownBeat) {
          shownBeat = bi;
          pips.forEach((pEl, i) => pEl.classList.toggle('is-on', i === bi));
          headEl.classList.toggle('is-near', bi === 3);
        }
        const x = headX(inBar / 4);
        headEl.style.transform = `translateX(${x - 3}px)`;
        fillEl.style.transform = `scaleX(${x / TRACK_W})`;

        // targets for the bar that is coming, from two beats out
        const up = bar + 1;
        if (inBar >= 2 && up < N && markedFor !== up) showTargets(up);
        else if (inBar >= 1 && inBar < 2 && markedFor != null) clearTargets();
        if (rings.length) {
          const closing = markedFor === up ? clamp((inBar - 2) / 2, 0, 1) : 1;
          const r = RING_R - (RING_R - MARK_R) * closing;
          const op = markedFor === up ? 0.3 + 0.7 * closing : 0;
          for (const c of rings) {
            c.setAttribute('r', r.toFixed(1));
            c.style.opacity = op.toFixed(2);
          }
        }

        // bars whose window closed with no note (a touch still in flight gets its allowance)
        for (; checked <= Math.min(bar, N - 1); checked++) {
          if (judged[checked]) continue;
          if (t <= clock.timeOf(barBeat(checked)) + WINDOW + TOUCH_LAG) break;
          miss(checked);
        }
        // old feedback steps back before the next bar line
        if (fbBar != null && fbBar === bar && inBar >= 3) {
          fbEl.classList.add('is-old');
          fbBar = null;
        }
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
