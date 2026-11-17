// Live Duel: both sides get the same prompt at the same instant, and the
// first correct answer takes the round. First to five rounds wins the match.
//
// Three ways to play:
//   ranked       you against a CPU opponent from a fixed ladder; your rating
//                moves by Elo after every match
//   one phone    both people on one phone, one at each short end
//   online       two people, each on their own device, through the shared
//                page's live room (live-duel-online.js). Needs the copy of the
//                page published on claude.ai; elsewhere it is offered but
//                cannot connect.
//
// Round types: "find" (the display names a note and a string, tap it on the
// neck) and "name" (a dot shows on the neck, press its name on one of four
// buttons). Ranked alternates the two; two-player rounds are always "name".
//
// Scripted checks: every random draw goes through `hooks.rand`, and
// `hooks.cpu` can script the CPU's answer for a round (see `hooks` below).

import { lifecycle, clamp, mod, TEST } from '../core/util.js';
import { pcAt, midiAt, pcName, positionsOfPc, isNatural, NATURAL_PCS, STRING_NAMES } from '../core/theory.js';
import { audio } from '../core/audio.js';
import { store } from '../core/store.js';
import { createFretboard } from '../core/fretboard.js';
import * as ui from '../core/ui.js';
import { net } from '../core/net.js';
import { playOnline, judge } from './live-duel-online.js';

const ID = 'live-duel';
const { h } = ui;
const WIN_AT = TEST.fast ? 2 : 5; // ?fast: first to 2 and short pauses, for automated checks
const START_RATING = 1000;
const ELO_K = 32;
const T = TEST.fast
  ? { lead: 120, hold: 260, pauseMin: 100, pauseMax: 180, limit: 5000, hurry: 120 }
  : { lead: 900, hold: 1200, pauseMin: 600, pauseMax: 1400, limit: 12000, hurry: 700 };

// The ladder: CPU opponents with fixed ratings. They are practice partners
// and are tagged CPU wherever they appear. Names stay at nine letters or
// fewer so the fight card never crowds.
const LADDER = [
  ['Pick Tin', 700],
  ['Capo', 745],
  ['Strap Pin', 790],
  ['Tuner', 835],
  ['Slide', 880],
  ['Fuzz Box', 925],
  ['Wah Pedal', 965],
  ['Tape Echo', 1005],
  ['Tremolo', 1045],
  ['Chorus', 1085],
  ['Phaser', 1125],
  ['Flanger', 1170],
  ['Humbucker', 1215],
  ['Combo Amp', 1260],
  ['Overdrive', 1305],
  ['Whammy', 1350],
  ['Octaver', 1400],
  ['Booster', 1450],
  ['Looper', 1500],
  ['Tube Amp', 1550],
  ['Talk Box', 1600],
  ['Sustainer', 1660],
  ['Stack', 1720],
  ['Feedback', 1790],
  ['Hot Tubes', 1860],
  ['Dive Bomb', 1940],
  ['Big Stack', 2020],
  ['Amp Wall', 2100],
].map(([name, rating]) => ({ name, rating }));

// ---- hooks for scripted checks ------------------------------------------------
/**
 * hooks.rand      source of every random number in this game (default Math.random)
 * hooks.cpu       ({ rating, type, round }) => ({ ms, ok }) scripts the CPU for a round:
 *                 ms 0 = answers at once, Infinity = never answers. null = normal play.
 * hooks.firstType 'find' | 'name' fixes the first ranked round type; null = random
 * hooks.peek()    snapshot of the match on screen (prompt, answers, score), or null
 * hooks.model     the CPU and rating maths and the online fairness rule, for checking them directly
 */
export const hooks = {
  rand: Math.random,
  cpu: null,
  firstType: null,
  peek: () => null,
  model: { cpuMeanSec, cpuAccuracy, cpuPlan, expected, eloNext, distractors, judge },
};

const rnd = () => hooks.rand();
const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rnd() * arr.length))];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rnd() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function weighted(items, weights) {
  let x = rnd() * weights.reduce((n, w) => n + w, 0);
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ---- the CPU ------------------------------------------------------------------
// Mean answer time falls with rating: 4.5 s at 800, 2.6 s at 1200, 1.5 s at
// 1600, 0.9 s at 2000 (straight lines between those points on a log scale).
const PACE = [
  [800, 4.5],
  [1200, 2.6],
  [1600, 1.5],
  [2000, 0.9],
];
function cpuMeanSec(rating) {
  const r = clamp(rating, 400, 2600);
  let i = 0;
  while (i < PACE.length - 2 && r > PACE[i + 1][0]) i++;
  const [r0, t0] = PACE[i];
  const [r1, t1] = PACE[i + 1];
  return Math.exp(Math.log(t0) + ((r - r0) / (r1 - r0)) * (Math.log(t1) - Math.log(t0)));
}
/** Chance the CPU's answer is right: 80% at 800 rising to 97% at 2000. */
function cpuAccuracy(rating) {
  return clamp(0.8 + (0.17 * (rating - 800)) / 1200, 0.8, 0.97);
}
/** One round's answer: a log-normal time (long tail on the slow side) and a hit or miss. */
function cpuPlan(rating) {
  const SIGMA = 0.38;
  const z = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  const sec = cpuMeanSec(rating) * Math.exp(SIGMA * z - (SIGMA * SIGMA) / 2);
  return { ms: clamp(sec, 0.4, 9) * 1000, ok: rnd() < cpuAccuracy(rating) };
}

// ---- rating -------------------------------------------------------------------
function expected(you, opp) {
  return 1 / (1 + Math.pow(10, (opp - you) / 400));
}
function eloNext(you, opp, won) {
  return Math.round(you + ELO_K * ((won ? 1 : 0) - expected(you, opp)));
}
function getLadder() {
  return { rating: START_RATING, wins: 0, losses: 0, last: null, peak: START_RATING, ...store.get(ID, 'ladder', {}) };
}
/** A CPU within about 120 points of the player, never the one just played. */
function findOpponent(rating, lastName) {
  const pool = LADDER.filter((o) => Math.abs(o.rating - rating) <= 120 && o.name !== lastName);
  if (pool.length) return { ...pick(pool) };
  // Off either end of the ladder: a stand-in at about the player's level.
  const names = LADDER.filter((o) => o.name !== lastName);
  return { name: pick(names).name, rating: Math.max(100, Math.round(rating + (rnd() * 2 - 1) * 120)) };
}
/** The six CPU ladder entries nearest a rating, to fill out a board of real players. */
function cpuRows(rating) {
  return LADDER.map((o) => ({ name: o.name, score: o.rating, cpu: true }))
    .sort((a, b) => Math.abs(a.score - rating) - Math.abs(b.score - rating))
    .slice(0, 6);
}
/** Six rows of the ladder around the player, for the results board. */
function ladderRows(rating) {
  const all = [...LADDER.map((o) => ({ name: o.name, score: o.rating, cpu: true })), { name: 'You', score: rating, you: true }];
  all.sort((a, b) => b.score - a.score || (a.you ? -1 : 1));
  all.forEach((r, i) => (r.rank = i + 1));
  const at = all.findIndex((r) => r.you);
  const from = clamp(at - 2, 0, all.length - 6);
  return all.slice(from, from + 6);
}

// ---- prompts ------------------------------------------------------------------
/**
 * Three wrong choices that a player could really fall for: the frets either
 * side, and the same fret one string over. Every choice is a different pitch,
 * so the right note's other spelling can never show up as a wrong answer.
 */
function distractors(pc, naturals) {
  const cand = naturals
    ? [1, -1, 2, -2, 3, -3].map((d) => NATURAL_PCS[mod(NATURAL_PCS.indexOf(pc) + d, 7)])
    : [1, -1, 2, -2, 5, -5, 3, -3].map((d) => mod(pc + d, 12));
  const w = naturals ? [4, 4, 3, 3, 1, 1] : [4, 4, 3, 3, 2, 2, 1, 1];
  const out = [];
  while (out.length < 3) {
    const i = cand.indexOf(weighted(cand, w));
    out.push(cand[i]);
    cand.splice(i, 1);
    w.splice(i, 1);
  }
  return out;
}

const CSS = `
.ld-play { position: absolute; inset: 0; }
.ld-play.is-ranked { display: flex; flex-direction: column; align-items: center; padding: 0 16px 4px; }
.ld-play.is-duo { display: grid; grid-template-columns: 108px 584px 108px; column-gap: 10px; padding: 2px 12px 6px; }

/* the fight card */
.ld-card { width: 100%; flex: 0 0 44px; height: 44px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; column-gap: 12px; }
.ld-side { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ld-side.is-b { flex-direction: row-reverse; }
.ld-plate { flex: none; height: 34px; display: inline-flex; align-items: center; gap: 8px; padding: 0 11px; border: 2px solid var(--edge); border-radius: 9px; box-shadow: 0 3px 0 var(--shadow); font: 700 17px/1 var(--font-label); letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
.ld-side.is-a .ld-plate { background: var(--game); color: var(--on-game); }
.ld-side.is-b .ld-plate { background: var(--ink); color: var(--bg); box-shadow: 0 3px 0 var(--ink-3); }
.ld-plate .tag { margin-left: 0; color: inherit; border-color: currentColor; opacity: 0.8; }
.ld-rating { font-variant-numeric: tabular-nums; letter-spacing: 0.04em; padding-left: 8px; border-left: 2px solid color-mix(in srgb, currentColor 35%, transparent); }
.ld-plate.is-bump { animation: bump 0.25s ease-out; }
.ld-pips { flex: none; display: inline-flex; gap: 5px; }
.ld-side.is-b .ld-pips { flex-direction: row-reverse; }
.ld-pip { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--edge); }
.ld-side.is-a .ld-pip.is-on { background: var(--game); }
.ld-side.is-b .ld-pip.is-on { background: var(--ink); }
.ld-pip.is-new { animation: ld-pip 0.24s ease-out; }
.ld-pip.is-next { animation: ld-next 0.8s ease-in-out infinite; }
.ld-vs { font: 700 14px/1 var(--font-label); letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-3); }
.ld-status { display: inline-flex; align-items: center; gap: 6px; font: 700 11px/1 var(--font-label); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); white-space: nowrap; }
.ld-status.is-bad { color: var(--bad); }
.ld-status.is-good { color: var(--good); }
.ld-think { display: inline-flex; gap: 3px; }
.ld-think i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: ld-think 0.9s ease-in-out infinite; }
.ld-think i:nth-child(2) { animation-delay: 0.15s; }
.ld-think i:nth-child(3) { animation-delay: 0.3s; }

/* the prompt */
.ld-mid { flex: 1; min-height: 0; width: 100%; display: grid; grid-template-columns: 1fr 372px 1fr; align-items: center; column-gap: 10px; }
.ld-display { position: relative; width: 372px; height: 80px; display: flex; align-items: center; justify-content: center; gap: 16px; padding: 0 16px; }
.ld-display::after { content: ""; position: absolute; inset: 0; border-radius: 8px; background: var(--lcd-ink); opacity: 0; pointer-events: none; }
.ld-display.is-hit { z-index: 2; animation: ld-hit 0.2s ease-out; }
.ld-display.is-hit::after { animation: ld-flash 0.22s ease-out; }
.ld-display.is-hit .ld-glyph, .ld-display.is-told .ld-glyph { animation: pop 0.16s ease-out; }
.ld-glyph { font-size: 60px; line-height: 1; min-width: 96px; text-align: center; white-space: nowrap; }
.ld-glyph[hidden] { display: none; }
.ld-display.is-ready .ld-glyph { font-size: 44px; color: var(--lcd-dim); }
.ld-display.is-none .ld-glyph { color: var(--lcd-dim); }
.ld-where { display: flex; flex-direction: column; gap: 6px; font-family: var(--font-label); font-weight: 600; }
.ld-where small { font-size: 12px; line-height: 1; letter-spacing: 0.16em; text-transform: uppercase; color: var(--lcd-dim); white-space: nowrap; }
.ld-where b { font-size: 25px; line-height: 1; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.ld-display.is-won .ld-where b, .ld-display.is-won .ld-glyph { color: var(--good); }
.ld-display.is-none .ld-where b { color: var(--lcd-dim); }
.ld-where b .tag { color: var(--lcd-dim); border-color: var(--lcd-dim); margin-left: 8px; position: relative; top: -3px; }
.ld-display.is-out .ld-where small { color: var(--bad); }

/* answer buttons */
.ld-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-bottom: 4px; visibility: hidden; }
.ld-play.is-name .ld-opts { visibility: visible; }
.ld-opt { --fill: var(--surface); --fg: var(--ink); position: relative; height: 72px; padding: 0; border: 2px solid var(--edge); border-radius: 12px; background: var(--fill); box-shadow: 0 4px 0 var(--shadow); display: grid; place-items: center; cursor: pointer; touch-action: none; transition: transform 0.05s, box-shadow 0.05s, opacity 0.12s; }
.ld-opt:active, .ld-opt.is-cpu { transform: translateY(3px); box-shadow: 0 1px 0 var(--shadow); }
.ld-opt-rot { display: block; }
.ld-opt-in { display: block; font: 700 38px/1 var(--font-label); letter-spacing: 0.02em; color: var(--fg); }
.ld-opt.is-blank { opacity: 0.45; cursor: default; }
.ld-opt.is-blank:active { transform: none; box-shadow: 0 4px 0 var(--shadow); }
.ld-opt.is-pop .ld-opt-in { animation: pop 0.16s ease-out; }
.ld-opt.is-dim { opacity: 0.38; }
.ld-opt.is-right { --fill: var(--good); --fg: var(--on-game); }
.ld-opt.is-right .ld-opt-in { animation: bump 0.25s ease-out; }
.ld-opt.is-wrong { --fill: var(--bad); --fg: var(--on-game); animation: ld-shake 0.22s ease-out; }
.ld-opt.is-answer::after { content: ""; position: absolute; inset: 4px; border-radius: 7px; border: 3px solid var(--good); pointer-events: none; }
.ld-chip { position: absolute; top: 5px; right: 5px; font: 700 9px/1 var(--font-label); letter-spacing: 0.12em; text-transform: uppercase; padding: 3px 4px; border-radius: 5px; background: var(--ink); color: var(--bg); animation: pop 0.16s ease-out; }

/* two players: a column of four at each short end, labels turned to face each seat */
.ld-col { display: flex; flex-direction: column; gap: 6px; }
.ld-col .ld-opt { flex: 1; height: auto; }
.ld-col.is-a .ld-opt { --fill: var(--game); --fg: var(--on-game); }
.ld-col.is-b .ld-opt { --fill: var(--ink); --fg: var(--bg); box-shadow: 0 4px 0 var(--ink-3); }
.ld-col.is-b .ld-opt:active { box-shadow: 0 1px 0 var(--ink-3); }
.ld-col .ld-opt.is-right { --fill: var(--good); --fg: var(--on-game); }
.ld-col .ld-opt.is-wrong { --fill: var(--bad); --fg: var(--on-game); }
.ld-col.is-a .ld-opt-rot { transform: rotate(90deg); }
.ld-col.is-b .ld-opt-rot { transform: rotate(-90deg); }
.ld-centre { display: flex; flex-direction: column; align-items: center; min-width: 0; }
.ld-centre .ld-card { width: 560px; }
.ld-centre .ld-display { margin: auto 0; height: 76px; }

/* online: waiting for a player */
.ld-lobby { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 0 24px 10px; }
.ld-lobby .ld-display { height: 92px; }
.ld-finding { display: inline-flex; align-items: baseline; gap: 8px; color: var(--lcd-ink); }
.ld-finding .ld-think i { width: 6px; height: 6px; }
.ld-here { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; min-height: 30px; max-width: 700px; }
.ld-who { display: inline-flex; align-items: baseline; gap: 7px; padding: 6px 10px; border: 2px solid var(--edge); border-radius: 9px; background: var(--surface); font: 700 15px/1 var(--font-label); letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.ld-who small { font: 600 10px/1 var(--font-label); letter-spacing: 0.12em; color: var(--ink-3); }
.ld-lobby-hint { max-width: 520px; text-align: center; font-size: 13.5px; line-height: 1.35; color: var(--ink-2); }

/* results */
.ld-res-vs { color: var(--ink-3); margin-left: 8px; }
.ld-elo { display: inline-flex; flex-direction: column; gap: 5px; }
.ld-elo-line { display: inline-flex; align-items: baseline; gap: 8px; font: 700 27px/1 var(--font-label); letter-spacing: 0.04em; font-variant-numeric: tabular-nums; color: var(--lcd-ink); }
.ld-elo-line span { color: var(--lcd-dim); }
.ld-elo-line i { font-style: normal; color: var(--lcd-dim); }
.ld-elo-line b.is-done { animation: bump 0.25s ease-out; }
.ld-elo-line em { font-style: normal; font-size: 17px; opacity: 0; }
.ld-elo-line em.is-in { opacity: 1; animation: pop 0.16s ease-out; }
.ld-elo-line em.is-up { color: var(--good); }
.ld-elo-line em.is-down { color: var(--bad); }

@keyframes ld-hit { from { transform: scale(1.07); } }
@keyframes ld-flash { from { opacity: 0.5; } to { opacity: 0; } }
@keyframes ld-pip { from { transform: scale(1.9); } 60% { transform: scale(0.85); } }
@keyframes ld-next { 50% { transform: scale(1.35); } }
@keyframes ld-think { 0%, 60%, 100% { transform: translateY(0); opacity: 0.35; } 30% { transform: translateY(-4px); opacity: 1; } }
@keyframes ld-shake { 25% { transform: translateX(-5px); } 50% { transform: translateX(5px); } 75% { transform: translateX(-3px); } }
`;

const game = {
  id: ID,
  title: 'Live Duel',
  kind: 'First to the note',
  color: 'var(--shell)',
  knobs: [-100, 15],
  hooks,
  boards: { best: { title: 'Peak rating', unit: 'ranked and online' } },
  /** This browser's score for the shared board: the highest rating reached. */
  scores() {
    const l = store.get(ID, 'ladder', null);
    return { day: null, best: l ? Math.max(l.peak || 0, l.rating || 0) || null : null };
  },
  /** The player's rating, once they have finished a ranked match. */
  readout() {
    const l = store.get(ID, 'ladder', null);
    return l ? String(l.rating) : null;
  },

  mount(root, app) {
    ui.injectCSS(ID, CSS);
    const life = lifecycle();
    let run = null; // lifecycle of the current match
    const scr = ui.gameScreen(root, game, { onBack: app.exit });
    const cfg = { mode: 'ranked', notes: 'all', ...store.get(ID, 'cfg', {}) };
    const saveCfg = () => store.set(ID, 'cfg', cfg);
    const clearOverlays = () => scr.el.querySelectorAll('.overlay').forEach((o) => o.remove());

    // Online: what the start screen says about the room, kept current while it shows.
    let onIntro = false;
    function onlineLine() {
      const st = net.status();
      if (!st.room) return 'Not available here';
      if (!st.connected) return 'Connecting';
      const waiting = net.room.others().filter((p) => p.presence && p.presence.duel && p.presence.duel.st === 'open').length;
      if (waiting) return `${waiting} waiting for a match`;
      return st.here ? `${st.here} other${st.here === 1 ? '' : 's'} here now` : 'Nobody else here yet';
    }
    life.add(
      net.onChange(() => {
        const el = onIntro && cfg.mode === 'online' ? scr.body.querySelector('.intro-best-value') : null;
        if (el) el.textContent = onlineLine();
      }),
    );

    function showIntro() {
      run?.dispose();
      hooks.peek = () => null;
      clearOverlays();
      scr.hud.setStats([]);
      onIntro = true;
      const ranked = cfg.mode === 'ranked';
      const online = cfg.mode === 'online';
      const lad = getLadder();
      ui.intro(scr, {
        title: 'Live Duel',
        tagline: ranked
          ? 'Same prompt, same instant. First to the note takes the round.'
          : online
            ? 'Two players, each on their own phone. First to the note takes the round.'
            : 'Two players, one phone. Lay it flat and sit at the two short ends.',
        steps: ranked
          ? ['You and a CPU opponent get the same prompt at the same moment.', 'Find it: tap the note on the neck. Name it: press the name of the dot.', `A wrong answer locks you out of the round. First to ${WIN_AT} wins.`]
          : online
            ? ['You both open this page, signed in, and choose Online.', 'The same prompt shows on both screens. Fastest right answer takes the point.', `A wrong answer locks you out of the round. First to ${WIN_AT} wins.`]
            : ['A dot lights up on the neck in the middle.', 'Press its name on the four buttons at your end. They face you.', `A wrong press locks you out of the round. First to ${WIN_AT} wins.`],
        options: [
          ui.segmented({
            label: 'Mode',
            options: [
              { value: 'ranked', label: 'Ranked' },
              { value: 'duo', label: 'One phone' },
              { value: 'online', label: 'Online' },
            ],
            value: cfg.mode,
            onChange: (v) => {
              cfg.mode = v;
              saveCfg();
              showIntro();
            },
          }),
          ui.segmented({
            label: 'Notes',
            options: [
              { value: 'natural', label: 'Naturals' },
              { value: 'all', label: 'All 12' },
            ],
            value: cfg.notes,
            onChange: (v) => {
              cfg.notes = v;
              saveCfg();
            },
          }),
        ],
        best: ranked ? { label: 'Your rating', value: lad.wins + lad.losses ? `${lad.rating} · ${lad.wins} W ${lad.losses} L` : String(lad.rating) } : online ? { label: `Rating ${lad.rating}`, value: onlineLine() } : null,
        startLabel: online ? 'Find a match' : 'Start',
        onStart: start,
      });
    }

    function start() {
      run?.dispose();
      run = lifecycle();
      clearOverlays();

      if (cfg.mode === 'online') {
        if (!net.room.on) {
          ui.toast(scr, 'Online needs the claude.ai copy of this page, signed in', { ms: 3200 });
          return;
        }
        onIntro = false;
        playOnline({ ID, scr, cfg, run, hooks, WIN_AT, T, again: start, showIntro, getLadder, eloNext, distractors, rnd, pick, shuffle, cpuRows });
        return;
      }
      onIntro = false;

      const ranked = cfg.mode === 'ranked';
      const naturals = cfg.notes === 'natural';
      const lad = getLadder();
      const opp = ranked ? findOpponent(lad.rating, lad.last) : null;

      // ---- the two sides ----
      const side = (key, name, more) => ({ key, name, score: 0, locked: false, wins: [], wrong: 0, btns: [], order: [], cell: null, ...more });
      const A = side(ranked ? 'you' : 'p1', ranked ? 'You' : 'Player 1', { human: true, rating: ranked ? lad.rating : null });
      const B = side(ranked ? 'cpu' : 'p2', ranked ? opp.name : 'Player 2', { human: !ranked, rating: ranked ? opp.rating : null });
      const seats = ranked ? [A] : [A, B]; // the sides that have answer buttons

      // ---- build the play screen ----
      function sideEl(s, cls) {
        s.pips = h('span', { class: 'ld-pips' }, Array.from({ length: WIN_AT }, () => h('i', { class: 'ld-pip' })));
        s.status = h('span', { class: 'ld-status' });
        s.plate = h('span', { class: 'ld-plate' }, h('span', null, s.name), s.human ? null : h('span', { class: 'tag' }, 'CPU'), s.rating == null ? null : h('span', { class: 'ld-rating' }, String(s.rating)));
        return h('div', { class: `ld-side ${cls}` }, s.plate, s.pips, s.status);
      }
      const card = h('div', { class: 'ld-card' }, sideEl(A, 'is-a'), h('span', { class: 'ld-vs' }, 'vs'), sideEl(B, 'is-b'));

      const glyph = h('span', { class: 'ld-glyph dot' });
      const small = h('small');
      const big = h('b');
      const display = h('div', { class: 'display ld-display' }, glyph, h('span', { class: 'ld-where' }, small, big));
      function show(state, g, s, b, cpu = false) {
        display.className = `display ld-display is-${state}`;
        glyph.hidden = g == null;
        glyph.replaceChildren(g == null ? '' : ui.noteEl(g));
        small.textContent = s;
        big.replaceChildren(b, cpu ? h('span', { class: 'tag' }, 'CPU') : '');
      }
      const replay = (el, cls) => {
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
      };

      // Buttons answer on pointerdown, each with its own listener, so two
      // thumbs landing almost together are both taken, in the order they land.
      function optBtn(s, i) {
        const inner = h('span', { class: 'ld-opt-in' });
        const btn = h('button', { class: 'ld-opt is-blank', type: 'button', 'aria-label': 'Answer' }, h('span', { class: 'ld-opt-rot' }, inner));
        run.on(btn, 'pointerdown', (ev) => {
          if (ev.button > 0) return;
          ev.preventDefault();
          press(s, i);
        });
        s.btns[i] = { btn, inner };
        return btn;
      }

      const play = h('div', { class: `ld-play ${ranked ? 'is-ranked' : 'is-duo is-name'}` });
      let fb;
      if (ranked) {
        play.append(card, h('div', { class: 'ld-mid' }, h('div', { class: 'ld-opts' }, optBtn(A, 0), optBtn(A, 1)), display, h('div', { class: 'ld-opts' }, optBtn(A, 2), optBtn(A, 3))));
        fb = createFretboard(play, { onTap: tapNeck });
        // Generous taps: in a "find it" round only one string is live, so a
        // thumb that lands one row off still counts as a tap on that string.
        let snapping = false;
        run.on(
          fb.el,
          'pointerdown',
          (ev) => {
            const t = ev.target;
            if (snapping || phase !== 'live' || type !== 'find' || A.locked || !t.dataset || t.dataset.s == null) return;
            if (Math.abs(+t.dataset.s - cur.s) !== 1) return;
            const hit = fb.el.querySelector(`.fb-hit[data-s="${cur.s}"][data-f="${t.dataset.f}"]`);
            if (!hit) return;
            ev.stopPropagation();
            ev.preventDefault();
            snapping = true;
            hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: ev.pointerId, pointerType: ev.pointerType, clientX: ev.clientX, clientY: ev.clientY }));
            snapping = false;
          },
          true,
        );
      } else {
        const centre = h('div', { class: 'ld-centre' }, card, display);
        fb = createFretboard(centre, { width: 560, pluck: false });
        play.append(h('div', { class: 'ld-col is-a' }, [0, 1, 2, 3].map((i) => optBtn(A, i))), centre, h('div', { class: 'ld-col is-b' }, [0, 1, 2, 3].map((i) => optBtn(B, i))));
      }
      fb.setEnabled(false);
      scr.hud.setStats([{ key: 'round', label: 'Round', value: 1 }]);
      scr.body.replaceChildren(play);

      // ---- match state ----
      let phase = 'lead'; // lead -> (ready -> live -> reveal)... -> over
      let roundNo = 0;
      let type = ranked ? hooks.firstType || (rnd() < 0.5 ? 'find' : 'name') : 'name';
      let cur = null; // the prompt on screen
      let lastPc = -1;
      let promptAt = 0;
      let plan = null; // the CPU's answer for this round
      let cpuTimer = 0;
      let cpuPending = false;
      let limitTimer = 0;
      let result = null;
      const log = [];

      hooks.peek = () => ({
        mode: cfg.mode,
        phase,
        round: roundNo,
        winAt: WIN_AT,
        score: [A.score, B.score],
        locked: [A.locked, B.locked],
        rating: A.rating,
        opponent: opp && { ...opp },
        prompt: cur && { ...cur },
        log: log.slice(),
        result,
      });

      function setStatus(s, text = '', kind = '') {
        s.status.className = `ld-status${kind ? ` is-${kind}` : ''}`;
        s.status.replaceChildren(text, kind === 'think' ? h('span', { class: 'ld-think' }, h('i'), h('i'), h('i')) : '');
      }

      function pickCell(minFret, maxFret) {
        const cells = [];
        for (let s = 0; s < 6; s++) {
          for (let f = minFret; f <= maxFret; f++) {
            const pc = pcAt(s, f);
            if ((!naturals || isNatural(pc)) && pc !== lastPc) cells.push({ s, f });
          }
        }
        // Ranked leans toward the spots this player finds hardest.
        return ranked ? weighted(cells, cells.map((c) => store.weakness(c.s, c.f))) : pick(cells);
      }
      function makePrompt() {
        const pref = rnd() < 0.5 ? 'flat' : 'sharp';
        if (type === 'find') {
          const c = pickCell(0, 11);
          const pc = pcAt(c.s, c.f);
          return { type, s: c.s, pc, pref, name: pcName(pc, pref), targets: positionsOfPc(pc, { strings: [c.s] }) };
        }
        const c = pickCell(1, 12);
        const pc = pcAt(c.s, c.f);
        const opts = [pc, ...distractors(pc, naturals)].map((p) => ({ pc: p, name: pcName(p, pref), ok: p === pc }));
        const orderA = shuffle(opts);
        let orderB = shuffle(opts);
        if (orderB.every((o, i) => o === orderA[i])) orderB = [...orderA.slice(1), orderA[0]];
        return { type, s: c.s, f: c.f, pc, pref, name: pcName(pc, pref), orderA, orderB };
      }

      // ---- a round ----
      function nextRound() {
        roundNo++;
        if (ranked && roundNo > 1) type = type === 'find' ? 'name' : 'find';
        phase = 'ready';
        cur = makePrompt();
        lastPc = cur.pc;
        A.locked = B.locked = false;
        A.cell = B.cell = null;
        scr.hud.set('round', roundNo);
        fb.clearMarks();
        fb.focusStrings(null);
        fb.setEnabled(false);
        play.classList.toggle('is-name', type === 'name');
        for (const s of [A, B]) {
          const matchPoint = s.score === WIN_AT - 1;
          setStatus(s, matchPoint && s === A && ranked ? 'Match point' : '');
          s.pips.children[s.score].classList.toggle('is-next', matchPoint);
          for (const o of s.btns) {
            o.btn.className = 'ld-opt is-blank';
            o.btn.querySelector('.ld-chip')?.remove();
            o.inner.replaceChildren();
          }
        }
        show('ready', 'READY', 'next up', type === 'find' ? 'Find it' : 'Name it');
        audio.sfx('count');
        run.timeout(goLive, T.pauseMin + rnd() * (T.pauseMax - T.pauseMin));
      }

      function goLive() {
        phase = 'live';
        if (type === 'find') {
          show('live', cur.name, 'find it on the', `${STRING_NAMES[cur.s]} string`);
          fb.focusStrings([cur.s]);
          fb.setEnabled(true);
        } else {
          show('live', '?', 'name it', 'Which note?');
          fb.mark(cur.s, cur.f, { kind: ranked ? 'accent' : 'warn', pulse: true });
          seats.forEach((s, n) => {
            s.order = n === 0 ? cur.orderA : cur.orderB;
            s.btns.forEach((o, i) => {
              o.btn.className = 'ld-opt is-pop';
              o.btn.setAttribute('aria-label', s.order[i].name);
              o.inner.replaceChildren(ui.noteEl(s.order[i].name));
            });
          });
          audio.pluck(midiAt(cur.s, cur.f), { gain: 0.5, dur: 1.4 });
        }
        // the hit: the display pops and flashes, with a sharp tick
        replay(display, 'is-hit');
        audio.click(audio.now(), true);
        audio.hat(audio.now(), 0.1);
        promptAt = performance.now();
        if (ranked) {
          plan = (hooks.cpu || (({ rating }) => cpuPlan(rating)))({ rating: B.rating, type, round: roundNo });
          setStatus(B, 'Thinking', 'think');
          cpuPending = Number.isFinite(plan.ms);
          if (cpuPending) cpuTimer = run.timeout(cpuAnswer, Math.max(0, plan.ms));
        }
        limitTimer = run.timeout(() => resolve(null, 0, 'time'), T.limit);
      }

      function tapNeck({ s, f, pc }) {
        if (phase !== 'live' || type !== 'find' || A.locked) return;
        const ms = performance.now() - promptAt;
        if (pc === cur.pc && s === cur.s) {
          store.recordNote(s, f, true, ms);
          A.cell = { s, f };
          resolve(A, ms);
        } else {
          const t = cur.targets[0];
          store.recordNote(t.s, t.f, false, ms);
          fb.mark(s, f, { kind: 'bad', label: pcName(pc, cur.pref) });
          lock(A);
        }
      }

      function press(s, i) {
        if (phase !== 'live' || type !== 'name' || s.locked || !s.order[i]) return;
        const ms = performance.now() - promptAt;
        const ok = s.order[i].ok;
        if (ranked) store.recordNote(cur.s, cur.f, ok, ms);
        if (ok) {
          resolve(s, ms);
        } else {
          s.btns[i].btn.classList.add('is-wrong');
          lock(s);
        }
      }

      function cpuAnswer() {
        cpuPending = false;
        if (phase !== 'live') return;
        const ms = performance.now() - promptAt;
        if (type === 'find') {
          // its tap lands on the neck: on the note, or a fret or two off
          let cell = pick(cur.targets);
          if (!plan.ok) {
            const near = [-2, -1, 1, 2].map((d) => cur.targets[0].f + d).filter((f) => f >= 0 && f <= 12 && !cur.targets.some((t) => t.f === f));
            cell = { s: cur.s, f: pick(near) };
          }
          B.cell = cell;
          audio.pluck(midiAt(cell.s, cell.f), { gain: 0.4, dur: 1.2 });
          fb.mark(cell.s, cell.f, { kind: plan.ok ? 'ink' : 'off', label: 'CPU' });
          fb.flash(cell.s, cell.f, 'ink', { label: 'CPU' });
        } else {
          // its press shows on the button it chose
          const wrong = A.order.map((o, i) => i).filter((i) => !A.order[i].ok);
          const o = A.btns[plan.ok ? A.order.findIndex((x) => x.ok) : pick(wrong)];
          o.btn.classList.add('is-cpu');
          o.btn.append(h('span', { class: 'ld-chip' }, 'CPU'));
        }
        if (plan.ok) {
          resolve(B, ms);
        } else {
          audio.sfx('tock');
          lock(B);
        }
      }

      /** A wrong answer: that side is out of this round. */
      function lock(s) {
        s.locked = true;
        s.wrong++;
        setStatus(s, !s.human ? 'Wrong' : ranked ? 'Locked out' : 'Locked', 'bad');
        for (const o of s.btns) if (!o.btn.classList.contains('is-wrong')) o.btn.classList.add('is-dim');
        if (s.human) audio.sfx('bad');
        if (ranked && s === A) {
          fb.setEnabled(false);
          display.classList.add('is-out');
          small.textContent = 'locked out';
        }
        const other = s === A ? B : A;
        const otherLive = !other.locked && (other.human || cpuPending);
        if (!otherLive) {
          resolve(null, 0, other.locked ? 'both' : 'none');
        } else if (ranked && s === A && plan.ms - (performance.now() - promptAt) > T.hurry) {
          // Nobody left to race, so the CPU does not keep the player waiting.
          clearTimeout(cpuTimer);
          cpuTimer = run.timeout(cpuAnswer, T.hurry);
        }
      }

      /** End of the round: score it, show the right answer, hold, move on. */
      function resolve(winner, ms = 0, why = '') {
        if (phase !== 'live') return;
        phase = 'reveal';
        clearTimeout(cpuTimer);
        clearTimeout(limitTimer);
        cpuPending = false;
        fb.setEnabled(false);
        const humanWin = !!winner && winner.human;
        if (ranked && !B.locked) setStatus(B);
        if (winner) {
          winner.score++;
          winner.wins.push(ms);
          winner.pips.children[winner.score - 1].classList.remove('is-next');
          winner.pips.children[winner.score - 1].classList.add('is-on', 'is-new');
          replay(winner.plate, 'is-bump');
          setStatus(winner, 'Point', humanWin ? 'good' : '');
        }

        if (type === 'find') {
          const hit = winner ? winner.cell : null;
          for (const t of cur.targets) {
            const tapped = hit && t.f === hit.f;
            if (winner === B && tapped) continue; // keeps its CPU mark for a beat, then shows the name
            fb.mark(t.s, t.f, { kind: !winner ? 'warn' : !tapped ? 'ghost' : 'good', label: cur.name });
          }
          if (winner === A) fb.flash(hit.s, hit.f, 'good', { label: cur.name });
          if (winner === B) run.timeout(() => phase === 'reveal' && fb.mark(hit.s, hit.f, { kind: 'ink', label: cur.name }), Math.min(450, T.hold * 0.45));
        } else {
          fb.mark(cur.s, cur.f, { kind: humanWin ? 'good' : winner ? 'ink' : 'warn', label: cur.name });
          for (const s of seats) {
            s.btns.forEach((o, i) => {
              o.btn.classList.remove('is-pop');
              if (s.order[i].ok) {
                o.btn.classList.remove('is-dim');
                o.btn.classList.add(s === winner ? 'is-right' : 'is-answer');
              } else if (!o.btn.classList.contains('is-wrong')) {
                o.btn.classList.add('is-dim');
              }
            });
          }
        }

        if (winner) show(humanWin ? 'won' : 'lost', cur.name, `point · ${(ms / 1000).toFixed(2)} s`, winner.name, !winner.human);
        else show('none', cur.name, 'no point', why === 'time' ? 'Time' : why === 'both' ? 'Both wrong' : 'Nobody');
        replay(display, humanWin ? 'is-hit' : 'is-told'); // the full flash is kept for a point a player takes

        if (humanWin) audio.sfx('good');
        else if (winner) cpuBlip();
        else audio.sfx('tock');

        log.push({ round: roundNo, type, winner: winner ? winner.key : null, ms: Math.round(ms), why });
        run.timeout(() => (winner && winner.score >= WIN_AT ? finish(winner) : nextRound()), T.hold);
      }

      /** Neutral two-pip blip for a round the CPU takes: not a reward, not a buzzer. */
      function cpuBlip() {
        const t = audio.now();
        audio.tone(67, { when: t, dur: 0.08, gain: 0.1 });
        audio.tone(67, { when: t + 0.11, dur: 0.12, gain: 0.1 });
      }

      // ---- end of the match ----
      function finish(winner) {
        phase = 'over';
        const avg = (s) => (s.wins.length ? `${(s.wins.reduce((n, v) => n + v, 0) / s.wins.length / 1000).toFixed(2)} s` : '-');
        const score = `${A.score}-${B.score}`;

        if (!ranked) {
          audio.sfx('win');
          store.touchToday(ID);
          result = { winner: winner.key, score };
          const res = ui.results(scr, {
            title: `${winner.name} wins`,
            big: score,
            unit: `first to ${WIN_AT}`,
            rows: [
              ['Player 1 avg win', avg(A)],
              ['Player 2 avg win', avg(B)],
              ['Player 1 wrong', A.wrong],
              ['Player 2 wrong', B.wrong],
            ],
            actions: [
              { label: 'Rematch', kind: 'primary', onClick: start },
              { label: 'Options', onClick: showIntro },
            ],
          });
          life.add(() => res.close());
          return;
        }

        const won = winner === A;
        const before = lad.rating;
        const after = eloNext(before, opp.rating, won);
        const next = { rating: after, wins: lad.wins + (won ? 1 : 0), losses: lad.losses + (won ? 0 : 1), last: opp.name, peak: Math.max(lad.peak, after) };
        store.set(ID, 'ladder', next);
        store.recordRun(ID, after, { mode: 'ranked' });
        result = { won, score, before, after, opponent: opp.rating, expected: expected(before, opp.rating), wins: next.wins, losses: next.losses };
        audio.sfx(won ? 'win' : 'lose');

        // "1000 -> 1018": the new number counts up (or down) from the old one
        const toEl = h('b', null, String(before));
        const deltaEl = h('em', { class: after >= before ? 'is-up' : 'is-down' }, `${after >= before ? '+' : '-'}${Math.abs(after - before)}`);
        const elo = h('span', { class: 'ld-elo' }, 'Rating', h('span', { class: 'ld-elo-line' }, h('span', null, String(before)), h('i', null, '→'), toEl, deltaEl));
        const t0 = performance.now() + 350;
        const stop = run.loop((dt, now) => {
          const k = clamp((now - t0) / 700, 0, 1);
          toEl.textContent = String(Math.round(before + (after - before) * (1 - Math.pow(1 - k, 3))));
          if (k < 1) return;
          stop();
          toEl.classList.add('is-done');
          deltaEl.classList.add('is-in');
        });

        const res = ui.results(scr, {
          title: h('span', null, won ? 'You win' : 'You lose', h('span', { class: 'ld-res-vs' }, `vs ${opp.name}`), h('span', { class: 'tag' }, 'CPU')),
          big: score,
          unit: elo,
          badge: won && after > lad.peak && lad.wins + lad.losses > 0 ? 'New peak' : null,
          rows: [
            ['Avg winning time', avg(A)],
            ['Record', `${next.wins} W · ${next.losses} L`],
            ['Fastest win', A.wins.length ? `${(Math.min(...A.wins) / 1000).toFixed(2)} s` : '-'],
            ['Wrong answers', A.wrong],
          ],
          board: ladderRows(after),
          boardTitle: 'Ladder',
          actions: [
            { label: 'Again', kind: 'primary', onClick: start },
            { label: 'Options', onClick: showIntro },
          ],
        });
        const unitEl = res.el.querySelector('.results-unit');
        if (unitEl) unitEl.style.alignSelf = 'center';
        life.add(() => res.close());
      }

      // ---- go ----
      show('lead', 'VS', ranked ? 'ranked match' : 'two players', `First to ${WIN_AT}`);
      run.timeout(nextRound, T.lead);
    }

    showIntro();
    return () => {
      run?.dispose();
      life.dispose();
      hooks.peek = () => null;
    };
  },
};

export default game;
