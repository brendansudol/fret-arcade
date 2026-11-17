// Interval Path: walk the neck one interval at a time. The display gives a
// move ("up a major 3rd"), the player taps any spot with exactly that pitch,
// and the trail of moves draws itself across the neck like a snake.
//
// The sequence of moves depends only on the seeded rng and on pitch, never on
// which spot the player chose, so a Daily run is the same path for everyone.

import { rng, dailySeed, dayNumber, todayKey, lifecycle, mod, TEST } from '../core/util.js';
import { positionsOfMidi, pcName, rootName, intervalOf, mod12 } from '../core/theory.js';
import { audio } from '../core/audio.js';
import { store } from '../core/store.js';
import { createFretboard } from '../core/fretboard.js';
import * as ui from '../core/ui.js';
import { resultsBoard } from '../core/boards.js';

const ID = 'interval-path';
const { h } = ui;

const LOW = 40; // open low E
const HIGH = 76; // high E string, fret 12
const MID = 58;
const PER_LEVEL = 8; // correct moves per level
const TRAIL = 3; // links kept on the neck behind the current note
const MAX_MULT = 5;
const CHAIN_STEP = 4; // chain length per multiplier step
const MAX_LIVES = TEST.fast ? 1 : 3; // ?fast: one life and a 2 s clock for automated checks
const REVEAL_MS = TEST.fast ? 600 : 1150;
const GRACE_MS = 140; // taps this soon after a new move are a second finger landing, not an answer
const moveTime = (level) => (TEST.fast ? 2 : 3.5 + 3.5 * Math.pow(0.82, level - 1)); // 7 s, easing toward 3.5 s
const multOf = (chain) => Math.min(MAX_MULT, 1 + Math.floor(chain / CHAIN_STEP));

// What each level adds, in semitones.
const TIERS = [
  { add: [1, 2, 3, 4], label: 'steps and 3rds' },
  { add: [5, 7], label: '4ths and 5ths' },
  { add: [12, 6], label: 'octave and tritone' },
  { add: [8, 9, 10, 11], label: '6ths and 7ths' },
];
const tierSet = (n) => TIERS.slice(0, n).flatMap((t) => t.add);
const PRACTICE_TIER = { steps: 1, fifths: 2, all: 4 };

// Names for a wrong tap that landed more than an octave away.
const COMPOUND = { 13: 'm9', 14: 'M9', 15: 'm10', 16: 'M10', 17: 'P11', 18: 'A11', 19: 'P12', 20: 'm13', 21: 'M13', 22: 'm14', 23: 'M14', 24: 'P15' };
const playedShort = (d) => {
  const a = Math.abs(d);
  return a <= 12 ? intervalOf(a).short : COMPOUND[a] || 'far';
};
const article = (iv) => (iv.semis === 12 ? 'an' : 'a');

// Spell the next note the way the interval asks for (a major 3rd above E is
// G sharp, not A flat). Falls back to a plain name when that gets awkward.
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const LETTER_STEPS = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 7: 4, 8: 5, 9: 5, 10: 6, 11: 6, 12: 7 };
function spellNext(fromName, toMidi, dir, semis) {
  const steps = LETTER_STEPS[semis];
  if (steps != null) {
    const i = mod(LETTERS.indexOf(fromName[0]) + dir * steps, 7);
    let diff = mod12(toMidi - LETTER_PC[i]);
    if (diff > 6) diff -= 12;
    const L = LETTERS[i];
    if (diff === 0) return L;
    if (diff === 1 && L !== 'E' && L !== 'B') return `${L}♯`;
    if (diff === -1 && L !== 'C' && L !== 'F') return `${L}♭`;
  }
  return pcName(toMidi, dir > 0 ? 'sharp' : 'flat');
}

// A chunky stepped arrow that sits next to the dot-matrix type.
const ARROW_SVG =
  '<svg viewBox="-1 -1 56 62" width="54" height="60" aria-hidden="true"><path d="M24 0h6v6h6v6h6v6h6v6h6v6H36v30H18V30H0v-6h6v-6h6v-6h6v-6h6z"/></svg>';

const SVG_NS = 'http://www.w3.org/2000/svg';

const CSS = `
.ip-play { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; padding: 0 16px 4px; }
.ip-bar { width: 100%; }
.ip-bar.is-off { visibility: hidden; }
.ip-prompt { flex: 1; width: 100%; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }

.ip-display { width: 432px; height: 102px; display: flex; align-items: center; gap: 14px; padding: 0 18px 0 22px; }
.ip-arrow { flex: none; width: 54px; height: 60px; }
.ip-arrow svg { display: block; fill: currentColor; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; }
.ip-arrow.is-down svg { transform: rotate(180deg); }
.ip-display.is-ready { justify-content: center; }
.ip-display.is-ready .ip-arrow, .ip-display.is-ready .ip-short { display: none; }
.ip-display.is-ready .ip-where { flex: none; align-items: center; }
.ip-short { flex: none; font-size: 76px; line-height: 1; min-width: 104px; text-align: center; white-space: nowrap; }
.ip-arrow.is-new, .ip-short.is-new { animation: ip-pop 0.16s ease-out; }
.ip-where { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; font-family: var(--font-label); font-weight: 600; white-space: nowrap; }
.ip-where small { font-size: 12px; line-height: 1; min-height: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--lcd-dim); }
.ip-where small em { font-style: normal; color: var(--lcd-ink); }
.ip-where small i { font-style: normal; text-transform: none; letter-spacing: 0.08em; }
.ip-where b { font-size: 27px; line-height: 1; letter-spacing: 0.06em; text-transform: uppercase; }
.ip-where small.is-miss { color: var(--bad); animation: fade 0.15s ease-out; }
.ip-where .note { text-transform: none; color: var(--lcd-ink); }

.ip-side { display: flex; flex-direction: column; gap: 5px; }
.ip-side.is-right { align-items: flex-end; }
.ip-chain { display: flex; align-items: center; gap: 9px; }
.ip-chain b { font: 700 36px/1 var(--font-label); font-variant-numeric: tabular-nums; }
.ip-mult { font: 700 17px/1 var(--font-label); letter-spacing: 0.04em; padding: 4px 7px 5px; border-radius: 8px; border: 2px solid var(--edge); background: var(--surface); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.ip-mult.is-hot { background: var(--game); color: var(--on-game); }
.ip-mult.is-bump { animation: bump 0.25s ease-out; }
.ip-pips { display: flex; gap: 4px; }
.ip-pips i { width: 15px; height: 6px; border-radius: 3px; border: 1.5px solid var(--edge); background: var(--surface); }
.ip-pips i.is-on { background: var(--game); }
.ip-lives .pick svg { width: 23px; height: 26px; }
.ip-lives.is-hit { animation: bump 0.25s ease-out; }
.ip-next { font: 600 11px/1 var(--font-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); margin-top: 3px; white-space: nowrap; }

/* the trail: links draw themselves, age, then pull in toward the path */
.ip-play .fb-link { transition: opacity 0.25s; }
.ip-play .fb-link line { stroke-dasharray: var(--ip-len); stroke-width: 5; transition: stroke-width 0.25s; animation: ip-draw 0.2s ease-out both; }
.ip-play .fb-link.ip-age-1 line { stroke-width: 4; }
.ip-play .fb-link.ip-age-2 line { stroke-width: 3; }
.ip-play .fb-link rect, .ip-play .fb-link text { animation: fade 0.12s ease-out 0.13s both; }
.ip-play .fb-link.ip-age-1 { opacity: 0.6; }
.ip-play .fb-link.ip-age-2 { opacity: 0.36; }
.ip-play .fb-link.is-out line { animation: ip-retract 0.22s ease-in forwards; }
.ip-play .fb-link.is-out rect, .ip-play .fb-link.is-out text { animation: ip-gone 0.1s ease-out forwards; }
.ip-play .fb-mk.ip-node { transition: opacity 0.25s; }
.ip-play .fb-mk.ip-node .fb-mk-in { animation: ip-settle 0.18s ease-out; }
.ip-play .fb-mk.ip-node.ip-age-1 { opacity: 0.62; }
.ip-play .fb-mk.ip-node.ip-age-2 { opacity: 0.36; }
.ip-play .fb-mk.ip-node.is-out .fb-mk-in { animation: ip-shrink 0.22s ease-in forwards; }
.ip-play .fb-mk.ip-head .fb-mk-in { animation: mk-pop 0.16s ease-out, mk-pulse 0.9s ease-in-out 0.16s infinite; }
.ip-play .fb-mk circle.ip-halo { fill: none; stroke: var(--k); stroke-width: 2; transform-box: fill-box; transform-origin: center; animation: ip-halo 1.5s ease-out infinite; }
.ip-play .fb-mk.is-flash .fb-mk-in { animation: ip-flash ${REVEAL_MS}ms ease-out forwards; }
.ip-pts { position: absolute; z-index: 2; transform: translate(-50%, -50%); padding: 2px 6px 3px; border-radius: 8px; border: 1.5px solid var(--board-edge); background: var(--board-ink); color: var(--on-game); font: 700 13px/1 var(--font-label); letter-spacing: 0.03em; white-space: nowrap; pointer-events: none; animation: ip-float 0.55s ease-out forwards; }
.toast.ip-toast { top: 5px; z-index: 40; }
.ip-watch { display: flex; align-items: baseline; gap: 9px; }
.ip-watch span { font: 600 11px/1 var(--font-label); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); }
.ip-watch b { font: 700 17px/1 var(--font-label); letter-spacing: 0.05em; text-transform: uppercase; }
.ip-seg-tight .seg-btn { padding: 0 9px; letter-spacing: 0.05em; }

@keyframes ip-pop { from { transform: scale(1.28); opacity: 0.25; } }
@keyframes ip-draw { from { stroke-dashoffset: var(--ip-len); } to { stroke-dashoffset: 0; } }
@keyframes ip-retract { from { stroke-dashoffset: 0; } to { stroke-dashoffset: calc(var(--ip-len) * -1); } }
@keyframes ip-gone { to { opacity: 0; } }
@keyframes ip-settle { from { transform: scale(1.6); } }
@keyframes ip-shrink { to { transform: scale(0); opacity: 0; } }
@keyframes ip-halo { from { transform: scale(1); opacity: 0.75; } 70%, to { transform: scale(1.9); opacity: 0; } }
@keyframes ip-flash { 0% { transform: scale(0.6); } 12% { transform: scale(1.2); } 22% { transform: scale(1); } 84% { transform: scale(1); opacity: 1; } 100% { transform: scale(1); opacity: 0; } }
@keyframes ip-float { 0% { opacity: 0; transform: translate(-50%, calc(-50% + 6px)); } 25% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, calc(-50% - 14px)); } }
/* with motion reduced the chip would jump straight to its faded-out end, so just show it */
@media (prefers-reduced-motion: reduce) {
  .ip-pts { animation: none !important; }
}
`;

const game = {
  id: ID,
  title: 'Interval Path',
  kind: 'Walk the neck by interval',
  color: 'var(--surf)',
  knobs: [-70, 40],
  boards: { day: { title: 'Today', unit: 'points' }, best: { title: 'All time', unit: 'points' } },
  /** This browser's scores for the shared boards (see core/boards.js). */
  scores() {
    const t = store.get(ID, 'today', {});
    return { day: t.key === todayKey() ? t.score : null, best: store.topBest(ID) };
  },
  /** Short text for the pedal's display on the hub. */
  readout() {
    const b = store.topBest(ID);
    return b == null ? null : b < 1000 ? `${b} PTS` : String(b);
  },

  mount(root, app) {
    ui.injectCSS(ID, CSS);
    const life = lifecycle();
    let run = null; // lifecycle of the current run
    const scr = ui.gameScreen(root, game, { onBack: app.exit });
    const cfg = { run: 'daily', set: 'steps', timer: 'on', names: 'off', ...store.get(ID, 'cfg', {}) };
    const saveCfg = () => store.set(ID, 'cfg', cfg);

    function showIntro() {
      run?.dispose();
      scr.el.querySelectorAll('.overlay').forEach((o) => o.remove());
      scr.hud.setStats([]);
      const daily = cfg.run === 'daily';
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
        const sets = ui.segmented({
          label: 'Intervals',
          options: [
            { value: 'steps', label: 'Steps, 3rds' },
            { value: 'fifths', label: '+ 4ths, 5ths' },
            { value: 'all', label: 'Everything' },
          ],
          value: cfg.set,
          onChange: (v) => {
            cfg.set = v;
            saveCfg();
          },
        });
        sets.classList.add('ip-seg-tight');
        options.push(
          sets,
          ui.segmented({
            label: 'Timer',
            options: [
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ],
            value: cfg.timer,
            onChange: (v) => {
              cfg.timer = v;
              saveCfg();
            },
          }),
        );
      }
      options.push(
        ui.segmented({
          label: 'Note names',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ],
          value: cfg.names,
          onChange: (v) => {
            cfg.names = v;
            saveCfg();
          },
        }),
      );
      const best = store.best(ID, daily ? 'daily' : 'practice');
      ui.intro(scr, {
        title: 'Interval Path',
        tagline: daily ? 'Walk the neck one interval at a time. Everyone gets the same path today.' : 'Walk the neck at your own pace. Intervals you miss come up more often.',
        steps: ['A note is marked on the neck. The display gives a move from it, like up a major 3rd.', 'Tap the note exactly that far away. Up means higher in pitch, and any spot with that pitch counts.', 'A miss costs a pick and shows you every right spot.'],
        options,
        best: best == null ? null : { label: daily ? 'Best daily' : 'Best practice', value: `${best} pts` },
        onStart: start,
      });
    }

    async function start() {
      run?.dispose();
      run = lifecycle();
      scr.el.querySelectorAll('.overlay').forEach((o) => o.remove());

      const daily = cfg.run === 'daily';
      const timed = daily || cfg.timer === 'on';
      const names = cfg.names === 'on';
      const r = rng(daily ? dailySeed(ID) : undefined);
      const habits = daily ? {} : store.get(ID, 'iv', {}); // semis -> [asked, missed], practice only

      // ---- build the play screen ----
      scr.hud.setStats([
        { key: 'level', label: 'Level', value: 1 },
        { key: 'score', label: 'Score', value: 0 },
      ]);
      const timeBar = ui.bar();
      const arrowEl = h('span', { class: 'ip-arrow', html: ARROW_SVG });
      const shortEl = h('span', { class: 'ip-short dot' }, '');
      const capEl = h('small', null, 'your start is marked');
      const nameEl = h('b', null, 'get ready');
      const footEl = h('small', null, '');
      const chainEl = h('b', null, '0');
      const multEl = h('span', { class: 'ip-mult' }, '×1');
      const pipEls = Array.from({ length: CHAIN_STEP }, () => h('i'));
      const livesUI = ui.lives(MAX_LIVES);
      livesUI.el.classList.add('ip-lives');
      const nextEl = h('span', { class: 'ip-next' }, '');
      let displayEl;
      const play = h(
        'div',
        { class: 'ip-play' },
        h('div', { class: `ip-bar${timed ? '' : ' is-off'}` }, timeBar.el),
        h(
          'div',
          { class: 'ip-prompt' },
          h('div', { class: 'ip-side' }, h('span', { class: 'stat-label' }, 'Chain'), h('div', { class: 'ip-chain' }, chainEl, multEl), h('div', { class: 'ip-pips' }, pipEls)),
          (displayEl = h('div', { class: 'display ip-display is-ready' }, arrowEl, shortEl, h('span', { class: 'ip-where' }, capEl, nameEl, footEl))),
          h('div', { class: 'ip-side is-right' }, h('span', { class: 'stat-label' }, 'Lives'), livesUI.el, nextEl),
        ),
      );
      scr.body.replaceChildren(play);
      const fb = createFretboard(play, { onTap: answer });
      fb.setEnabled(false);

      // ---- run state ----
      let state = 'ready'; // 'ready' | 'live' | 'reveal' | 'over'
      let level = 1;
      let score = 0;
      let chain = 0;
      let bestChain = 0;
      let correct = 0;
      let moves = 0;
      let lives = MAX_LIVES;
      let cur = null; // { s, f, midi, name }: the current note
      let move = null; // { semis, dir, to }: the move being asked for
      let last = null; // previous two moves, for variety rules
      let last2 = null;
      let elapsed = 0;
      let limit = moveTime(level);
      let lowTick = false;
      let openAt = 0;
      const marks = []; // true/false per move, for the share line
      const asked = {}; // semis -> times asked this run
      const missed = {}; // semis -> times missed this run
      const missOrder = [];
      const trail = []; // newest first: { link, node: { s, f, el } }

      const tier = () => (daily ? Math.min(level, TIERS.length) : PRACTICE_TIER[cfg.set] || 1);

      /** Next move. Uses only the rng and pitch, never the spot the player is on. */
      function pickMove() {
        const fresh = daily && level > 1 && level <= TIERS.length ? TIERS[level - 1].add : [];
        const all = [];
        for (const semis of tierSet(tier())) {
          for (const dir of [1, -1]) {
            const to = cur.midi + dir * semis;
            if (to < LOW || to > HIGH || !positionsOfMidi(to).length) continue;
            all.push({ semis, dir, to });
          }
        }
        const undo = (c) => last && c.semis === last.semis && c.dir === -last.dir;
        const third = (c) => last && last2 && last.semis === c.semis && last2.semis === c.semis;
        let pool = all.filter((c) => !undo(c) && !third(c));
        if (!pool.length) pool = all.filter((c) => !undo(c));
        if (!pool.length) pool = all;
        const edge = Math.abs(cur.midi - MID) / (HIGH - MID);
        const weights = pool.map((c) => {
          let w = 1;
          if (Math.abs(c.to - MID) > Math.abs(cur.midi - MID)) w *= 1 - 0.5 * edge; // lean back toward the middle of the range
          if (last && c.semis === last.semis) w *= 0.5;
          if (fresh.includes(c.semis)) w *= 1.6; // show off what the level just added
          const hab = habits[c.semis];
          if (hab && hab[0] >= 4) w *= 1 + 1.5 * (hab[1] / hab[0]); // practice leans on weak intervals
          return w;
        });
        return r.weighted(pool, weights);
      }

      function setData() {
        Object.assign(play.dataset, {
          state,
          midi: cur.midi,
          s: cur.s,
          f: cur.f,
          dir: move ? (move.dir > 0 ? 'up' : 'down') : '',
          semis: move ? move.semis : '',
          short: move ? intervalOf(move.semis).short : '',
          target: move ? move.to : '',
          level,
          lives,
          chain,
          mult: multOf(chain),
          score,
          moves,
          correct,
          trail: trail.length,
        });
      }

      function updateStats() {
        scr.hud.set('score', score);
        scr.hud.set('level', level);
        chainEl.textContent = String(chain);
        const m = multOf(chain);
        multEl.textContent = `×${m}`;
        multEl.classList.toggle('is-hot', m > 1);
        const lit = m >= MAX_MULT ? CHAIN_STEP : chain % CHAIN_STEP;
        pipEls.forEach((p, i) => p.classList.toggle('is-on', i < lit));
        livesUI.set(lives);
        const left = PER_LEVEL - (correct % PER_LEVEL);
        nextEl.textContent = `Level ${level + 1} in ${left} ${left === 1 ? 'move' : 'moves'}`;
      }

      const restart = (el, cls) => {
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
      };

      function showFoot() {
        footEl.classList.remove('is-miss');
        if (names) footEl.replaceChildren('from ', ui.noteEl(cur.name));
        else footEl.replaceChildren();
      }

      function showMove() {
        const iv = intervalOf(move.semis);
        displayEl.classList.remove('is-ready');
        arrowEl.classList.toggle('is-down', move.dir < 0);
        shortEl.textContent = iv.short;
        capEl.replaceChildren(h('em', null, move.dir > 0 ? 'up' : 'down'), ` ${article(iv)}`);
        nameEl.textContent = iv.name;
        showFoot();
        restart(arrowEl, 'is-new');
        restart(shortEl, 'is-new');
      }

      // ---- the trail ----
      function setHead() {
        const g = fb.mark(cur.s, cur.f, { kind: 'accent', pulse: true, label: names ? cur.name : '' });
        g.classList.add('ip-head');
        const halo = document.createElementNS(SVG_NS, 'circle');
        halo.setAttribute('class', 'ip-halo');
        halo.setAttribute('r', '13');
        g.insertBefore(halo, g.firstChild);
      }

      /** Make a link draw itself, and move its label clear of the dots on a short hop. */
      function dressLink(link, a, b) {
        const p1 = fb.xy(a.s, a.f);
        const p2 = fb.xy(b.s, b.f);
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        link.el.style.setProperty('--ip-len', `${len.toFixed(1)}px`);
        const rect = link.el.querySelector('rect');
        const text = link.el.querySelector('text');
        if (rect && text && len < 46) {
          const w = Number(rect.getAttribute('width'));
          const mx = (p1.x + p2.x) / 2;
          const side = mx + w + 12 > fb.width ? -1 : 1;
          const cx = mx + side * (w / 2 + 11);
          rect.setAttribute('x', cx - w / 2);
          text.setAttribute('x', cx);
        }
      }

      function dropSegment(seg) {
        seg.link.el.classList.add('is-out');
        seg.node.el.classList.add('is-out');
        run.timeout(() => {
          seg.link.remove();
          // a newer mark may have taken this cell; only clear our own dot
          if (seg.node.el.isConnected) fb.unmark(seg.node.s, seg.node.f);
        }, 230);
      }

      /** Move the current note to `next`, leaving a link and a small dot behind. */
      function stepTo(next, earned) {
        const prev = cur;
        const nodeEl = fb.mark(prev.s, prev.f, { kind: 'accent', small: !names, label: names ? prev.name : '' });
        nodeEl.classList.add('ip-node');
        if (names) {
          // a named dot needs more room than the small mark gives, but should still sit below the current note
          nodeEl.querySelector('circle')?.setAttribute('r', '10.5');
          const t = nodeEl.querySelector('text');
          if (t) t.style.fontSize = '11px';
        }
        const link = fb.link(prev, next, { label: intervalOf(move.semis).short, kind: earned ? 'accent' : 'ink' });
        dressLink(link, prev, next);
        trail.unshift({ link, node: { s: prev.s, f: prev.f, el: nodeEl } });
        cur = { s: next.s, f: next.f, midi: move.to, name: spellNext(prev.name, move.to, move.dir, move.semis) };
        setHead();
        while (trail.length > TRAIL) dropSegment(trail.pop());
        trail.forEach((seg, i) => {
          for (const el of [seg.link.el, seg.node.el]) {
            el.classList.remove('ip-age-0', 'ip-age-1', 'ip-age-2');
            el.classList.add(`ip-age-${i}`);
          }
        });
        last2 = last;
        last = move;
      }

      function floatPoints(cell, text) {
        const { x, y } = fb.xy(cell.s, cell.f);
        // above the dot; on the top string it sits beside the dot instead, clear of the display
        const top = y < 30;
        const dx = top ? (x + 60 > fb.width ? -34 : 34) : 0;
        const el = h('span', { class: 'ip-pts', style: { left: `${x + dx}px`, top: `${top ? y - 4 : y - 25}px` } }, text);
        fb.el.append(el);
        run.timeout(() => el.remove(), 600);
      }

      // ---- play ----
      function prompt() {
        move = pickMove();
        asked[move.semis] = (asked[move.semis] || 0) + 1;
        showMove();
        elapsed = 0;
        limit = moveTime(level);
        lowTick = false;
        openAt = performance.now() + GRACE_MS;
        timeBar.set(1);
        state = 'live';
        fb.setEnabled(true);
        setData();
      }

      function answer({ s, f, midi }) {
        if (state !== 'live' || performance.now() < openAt) return;
        if (s === cur.s && f === cur.f) return; // tapping the current note just plays it again
        if (midi === move.to) hit({ s, f });
        else miss({ s, f, midi });
      }

      function hit(cell) {
        const mult = multOf(chain);
        const bonus = timed ? Math.round(5 * Math.max(0, 1 - elapsed / limit)) : 0;
        const points = 10 * mult + bonus;
        moves++;
        correct++;
        marks.push(true);
        score += points;
        chain++;
        bestChain = Math.max(bestChain, chain);
        stepTo(cell, true);
        floatPoints(cell, `+${points}`);
        const multUp = multOf(chain) > mult;
        if (correct % PER_LEVEL === 0) {
          level++;
          audio.sfx('level');
          const added = daily && level <= TIERS.length ? `${TIERS[level - 1].label} added` : timed ? 'faster clock' : `${correct} moves walked`;
          ui.toast(scr, `Level ${level}: ${added}`, { kind: 'good', ms: 1800 }).classList.add('ip-toast');
          scr.hud.bump('level');
        } else {
          audio.sfx(multUp ? 'great' : 'good');
        }
        updateStats();
        scr.hud.bump('score');
        if (multUp) restart(multEl, 'is-bump');
        prompt();
      }

      /** A wrong tap (tap = the cell) or a time out (tap = null). */
      function miss(tap) {
        state = 'reveal';
        fb.setEnabled(false);
        moves++;
        marks.push(false);
        missed[move.semis] = (missed[move.semis] || 0) + 1;
        missOrder.push(move.semis);
        lives--;
        chain = 0;
        audio.sfx('bad');
        const iv = intervalOf(move.semis);
        const targets = positionsOfMidi(move.to);
        targets.forEach((t) => fb.flash(t.s, t.f, 'ink', { label: iv.short, ms: REVEAL_MS }));
        if (tap) {
          const d = tap.midi - cur.midi;
          const a = Math.abs(d);
          const label = playedShort(d);
          fb.flash(tap.s, tap.f, 'bad', { label, ms: REVEAL_MS });
          // the short name keeps its case: m2 and M2 are different intervals
          if (a === 0) footEl.replaceChildren('that was the same note');
          else if (a > 24) footEl.replaceChildren('that was over 2 octaves');
          else footEl.replaceChildren(`that was ${d > 0 ? 'up' : 'down'} a `, h('i', null, label));
        } else {
          footEl.replaceChildren('out of time');
          timeBar.set(0);
        }
        footEl.classList.add('is-miss');
        updateStats();
        restart(livesUI.el, 'is-hit');
        setData();
        run.timeout(() => {
          if (lives <= 0) {
            finish();
            return;
          }
          // carry on from the closest right answer, so the shape is on the neck
          const here = fb.xy(cur.s, cur.f);
          const dist = (t) => {
            const p = fb.xy(t.s, t.f);
            return Math.hypot(p.x - here.x, p.y - here.y);
          };
          const near = targets.reduce((best, t) => (dist(t) < dist(best) ? t : best));
          audio.pluck(move.to, { gain: 0.6 });
          stepTo(near, false);
          prompt();
        }, REVEAL_MS);
      }

      function finish() {
        state = 'over';
        setData();
        fb.setEnabled(false);
        run.dispose();
        const mode = daily ? 'daily' : 'practice';
        const rec = store.recordRun(ID, score, { mode });
        const newBest = rec.isBest && rec.plays > 1 && score > 0;
        audio.sfx(rec.isBest && score > 0 ? 'win' : 'lose');
        if (daily) {
          const today = store.get(ID, 'today', {});
          const prev = today.key === todayKey() ? today.score : -1;
          if (score > prev) store.set(ID, 'today', { key: todayKey(), score });
        } else {
          const all = store.get(ID, 'iv', {});
          for (const k in asked) {
            const was = all[k] || [0, 0];
            all[k] = [was[0] + asked[k], was[1] + (missed[k] || 0)];
          }
          store.set(ID, 'iv', all);
        }
        const worst = Object.keys(missed)
          .map(Number)
          .sort((a, b) => missed[b] - missed[a] || missOrder.lastIndexOf(b) - missOrder.lastIndexOf(a))[0];
        const rows = [
          ['Longest chain', bestChain],
          ['Level reached', level],
          ['Moves made', moves],
          ['On target', moves ? `${Math.round((correct / moves) * 100)}%` : '-'],
        ];
        let boardRows = null;
        if (daily) {
          const todayBest = store.get(ID, 'today', {}).score ?? score;
          boardRows = resultsBoard({ gameId: ID, kind: 'day', you: todayBest, cpu: ui.houseScores(dailySeed(ID), { count: 7, min: 60, max: 1000 }) });
        }
        const shareLine = `Interval Path${daily ? ` #${dayNumber()}` : ''}: ${score} pts, chain ${bestChain}, level ${level}\n${marks.slice(0, 40).map((m) => (m ? '🟩' : '🟥')).join('')}`;
        const res = ui.results(scr, {
          title: daily ? `Daily #${dayNumber()}` : 'Practice run',
          big: score,
          unit: 'points',
          badge: newBest ? 'New best' : null,
          rows,
          extra: worst == null ? null : h('div', { class: 'ip-watch' }, h('span', null, 'Watch out for'), h('b', null, intervalOf(worst).name)),
          board: boardRows,
          boardTitle: "Today's board",
          actions: [
            { label: 'Again', kind: 'primary', onClick: start },
            {
              label: 'Copy result',
              onClick: async () => {
                const ok = await ui.copyText(shareLine);
                // lifted above the results overlay, which would otherwise blur it
                ui.toast(scr, ok ? 'Copied' : 'Copy not available here', { kind: ok ? 'good' : 'info' }).classList.add('ip-toast');
              },
            },
            { label: 'Options', onClick: showIntro },
          ],
        });
        life.add(() => res.close());
      }

      // ---- go ----
      const startMidi = r.range(46, 68); // anywhere but the ends of the range, so each day opens on a different part of the neck
      const spots = positionsOfMidi(startMidi);
      const roomy = spots.filter((p) => p.f >= 2 && p.f <= 9);
      const at = r.pick(roomy.length ? roomy : spots);
      cur = { s: at.s, f: at.f, midi: startMidi, name: rootName(startMidi) };
      setHead();
      if (names) footEl.replaceChildren('from ', ui.noteEl(cur.name));
      updateStats();
      timeBar.set(1);
      setData();
      if (timed) await ui.countdown(scr, run);
      else await run.wait(350);
      prompt();
      run.loop((dt) => {
        if (state !== 'live' || !timed) return;
        elapsed += dt;
        const left = 1 - elapsed / limit;
        timeBar.set(left);
        if (left < 0.25 && !lowTick) {
          lowTick = true;
          audio.sfx('tick');
        }
        if (left <= 0) miss(null);
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
