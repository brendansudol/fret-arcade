// Score boards that include real players.
//
//   resultsBoard({ gameId, kind, you, cpu })   for a results panel
//   peopleRows(gameId, kind, opts)             real players only, for the Scores screen
//
// A game says what its boards mean with two optional members on its module:
//   boards: { day: { title: 'Today', unit: 'points', lower: false, fmt }, best: {...} }
//   scores() -> { day: number | null, best: number | null }   from this browser's progress
// `day` is today's score in the game's daily mode, `best` the all-time best.
// `lower: true` means a lower score ranks higher; `fmt(score)` formats it.

import { net } from './net.js';
import { h, board } from './ui.js';

const order = (lower) => (a, b) => (lower ? a.score - b.score : b.score - a.score) || (a.you ? -1 : b.you ? 1 : 0);

/**
 * Board element for ui.results({ board }). Shows the real players who have a
 * score, topped up with the CPU rows given so it is never empty, and keeps
 * itself current while it is on screen.
 *   you    this player's score (already the one to rank, e.g. today's best)
 *   cpu    rows from ui.houseScores(...), tagged CPU
 */
export function resultsBoard({ gameId, kind = 'day', you, cpu = [], lower = false, keep = 6, fmt = String }) {
  const el = h('div', { class: 'live-board' });
  const render = () => {
    const all = [...net.rows(gameId, kind), ...cpu.map((r) => ({ ...r })), { name: 'You', score: you, you: true }];
    all.sort(order(lower));
    all.forEach((r, i) => (r.rank = i + 1));
    // People first: everyone real is shown before any CPU row gets a place.
    let shown = all.filter((r) => !r.cpu);
    if (shown.length > keep) {
      const me = shown.find((r) => r.you);
      shown = shown.slice(0, keep);
      if (!shown.includes(me)) shown[keep - 1] = me;
    }
    for (const r of all) if (r.cpu && shown.length < keep) shown.push(r);
    shown.sort((a, b) => a.rank - b.rank);
    el.replaceChildren(board(shown.map((r) => ({ ...r, score: fmt(r.score) }))));
  };
  render();
  const off = net.onChange(() => (el.isConnected ? render() : off()));
  return el;
}

/** Real players for one board, best first, this player included when they have a score. */
export function peopleRows(gameId, kind, { lower = false, fmt = String, keep = 8 } = {}) {
  const mine = net.myScore(gameId, kind);
  const all = net.rows(gameId, kind);
  if (mine != null) all.push({ name: 'You', score: mine, you: true });
  all.sort(order(lower));
  all.forEach((r, i) => (r.rank = i + 1));
  let shown = all.slice(0, keep);
  const me = all.find((r) => r.you);
  if (me && !shown.includes(me)) shown[keep - 1] = me;
  return { rows: shown.map((r) => ({ ...r, score: fmt(r.score) })), total: all.length, mine };
}
