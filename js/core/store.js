// Progress that lives in this browser: settings, per-game bests, the
// fretboard heat map and the practice streak. Every storage access is
// wrapped so the app still runs where storage is blocked.

import { todayKey, clamp } from './util.js';

// On the local copy, ?mock=name gives each pretend player their own progress (see tools/mock-claude.js).
const mockName = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('mock') : null;
const KEY = `fret-arcade:v1${mockName ? `:${mockName.toLowerCase().replace(/[^a-z0-9]/g, '')}` : ''}`;

const defaults = () => ({
  v: 1,
  settings: { sound: true, theme: 'auto' },
  games: {}, // id -> { plays, best: {mode: score}, runs: [{d, score, mode}], data: {} }
  heat: {}, // "s:f" -> [seen, correct, totalMs]
  days: {}, // "YYYY-MM-DD" -> [gameId, ...]
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const d = defaults();
      return { ...d, ...parsed, settings: { ...d.settings, ...(parsed.settings || {}) } };
    }
  } catch (e) {
    /* storage unavailable: run in memory */
  }
  return defaults();
}

let state = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    /* ignore */
  }
}

function gameRec(id) {
  if (!state.games[id]) state.games[id] = { plays: 0, best: {}, runs: [], data: {} };
  const g = state.games[id];
  g.best ||= {};
  g.runs ||= [];
  g.data ||= {};
  return g;
}

const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export const store = {
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ---- settings -------------------------------------------------------
  get settings() {
    return state.settings;
  },
  setSetting(key, value) {
    state.settings[key] = value;
    save();
    emit();
  },

  // ---- free-form per-game data (stats, ratings, daily results...) ------
  /** store.get('fretdle', 'stats', {played: 0}) */
  get(gameId, key, fallback = null) {
    const d = gameRec(gameId).data;
    return key in d ? d[key] : fallback;
  },
  set(gameId, key, value) {
    gameRec(gameId).data[key] = value;
    save();
  },

  // ---- runs and bests --------------------------------------------------
  /**
   * Record a finished run. Returns { best, isBest, plays, previousBest }.
   * mode separates leaderboards within a game (e.g. 'daily' vs 'practice').
   */
  recordRun(gameId, score, { mode = 'default', lowerIsBetter = false } = {}) {
    const g = gameRec(gameId);
    g.plays += 1;
    const prev = g.best[mode];
    const isBest = prev == null || (lowerIsBetter ? score < prev : score > prev);
    if (isBest) g.best[mode] = score;
    g.runs.push({ d: todayKey(), score, mode });
    if (g.runs.length > 60) g.runs.splice(0, g.runs.length - 60);
    const day = (state.days[todayKey()] ||= []);
    if (!day.includes(gameId)) day.push(gameId);
    save();
    emit();
    return { best: g.best[mode], isBest, plays: g.plays, previousBest: prev ?? null };
  },
  best(gameId, mode = 'default') {
    return gameRec(gameId).best[mode] ?? null;
  },
  /** Highest best across all modes of a game (for the hub readout). */
  topBest(gameId) {
    const vals = Object.values(gameRec(gameId).best);
    return vals.length ? Math.max(...vals) : null;
  },
  plays(gameId) {
    return gameRec(gameId).plays;
  },
  runs(gameId, mode) {
    return gameRec(gameId).runs.filter((r) => !mode || r.mode === mode);
  },
  playedToday(gameId) {
    return (state.days[todayKey()] || []).includes(gameId);
  },
  /** Mark activity today without recording a score. */
  touchToday(gameId) {
    const day = (state.days[todayKey()] ||= []);
    if (!day.includes(gameId)) day.push(gameId);
    save();
    emit();
  },
  /** Consecutive days with at least one finished game, counting back from today (or yesterday). */
  streak() {
    let n = 0;
    const d = new Date();
    if (!state.days[todayKey(d)]) d.setDate(d.getDate() - 1);
    while (state.days[todayKey(d)]) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  },

  // ---- fretboard heat map ----------------------------------------------
  /** Call whenever the player is asked to find or name the note at (s, f). */
  recordNote(s, f, ok, ms = 0) {
    const k = `${s}:${f}`;
    const h = (state.heat[k] ||= [0, 0, 0]);
    h[0] += 1;
    if (ok) {
      h[1] += 1;
      h[2] += clamp(ms, 0, 10000);
    }
    save();
  },
  /** { seen, correct, avgMs, mastery } where mastery is 0..1 or null if never seen. */
  heat(s, f) {
    const h = state.heat[`${s}:${f}`];
    if (!h || !h[0]) return { seen: 0, correct: 0, avgMs: 0, mastery: null };
    const [seen, correct, total] = h;
    const acc = correct / seen;
    const avgMs = correct ? total / correct : 0;
    const speed = correct ? clamp((4500 - avgMs) / (4500 - 1200), 0, 1) : 0;
    const confidence = Math.min(1, seen / 3);
    return { seen, correct, avgMs, mastery: acc * (0.45 + 0.55 * speed) * confidence };
  },
  /** Weight for picking practice targets: unseen and weak spots come up more. */
  weakness(s, f) {
    const m = store.heat(s, f).mastery;
    return m == null ? 1.6 : 0.5 + 2 * (1 - m);
  },

  reset() {
    state = defaults();
    save();
    emit();
  },
};
