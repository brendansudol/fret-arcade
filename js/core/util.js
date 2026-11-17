// Small shared helpers: math, seeded randomness, dates, and a lifecycle scope
// that makes it easy for a game to clean up every timer and listener on exit.

/**
 * Test switches read from the page URL. `?fast` asks games to shorten long
 * timers (a 60 s run becomes a few seconds) so automated checks can reach
 * the end screens quickly. Never set in normal play.
 */
export const TEST = { fast: typeof location !== 'undefined' && /[?&]fast\b/.test(location.search) };

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const mod = (n, m) => ((n % m) + m) % m;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * rng(seed?) -> r
 *   r()            float in [0,1)
 *   r.int(n)       integer in [0,n)
 *   r.range(a,b)   integer in [a,b] inclusive
 *   r.pick(arr)    random element
 *   r.shuffle(arr) new shuffled copy
 *   r.weighted(items, weights) weighted pick
 * Pass a string (e.g. "fret-sprint:2026-11-16") for a repeatable daily sequence,
 * or nothing for Math.random.
 */
export function rng(seed) {
  const base =
    seed == null ? Math.random : mulberry32(typeof seed === 'string' ? hashStr(seed) : seed);
  const r = () => base();
  r.int = (n) => Math.floor(base() * n);
  r.range = (a, b) => a + Math.floor(base() * (b - a + 1));
  r.pick = (arr) => arr[Math.floor(base() * arr.length)];
  r.shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(base() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  r.weighted = (items, weights) => {
    const total = weights.reduce((s, w) => s + w, 0);
    let x = base() * total;
    for (let i = 0; i < items.length; i++) {
      x -= weights[i];
      if (x <= 0) return items[i];
    }
    return items[items.length - 1];
  };
  return r;
}

/** Local date as YYYY-MM-DD. */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Day counter for numbering daily puzzles (#1 = 1 Nov 2026). */
export function dayNumber(d = new Date()) {
  const start = new Date(2026, 10, 1);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((today - start) / 86400000) + 1;
}

/** Seed string shared by everyone playing a given game today. */
export const dailySeed = (gameId) => `${gameId}:${todayKey()}`;

/**
 * lifecycle() -> life
 * Register timers, animation frames and listeners through it, then call
 * life.dispose() once (a game's mount() should return it) to cancel them all.
 */
export function lifecycle() {
  const cleanups = new Set();
  let dead = false;
  const life = {
    get dead() {
      return dead;
    },
    add(fn) {
      if (dead) fn();
      else cleanups.add(fn);
      return () => cleanups.delete(fn);
    },
    timeout(fn, ms) {
      const id = setTimeout(() => {
        if (!dead) fn();
      }, ms);
      cleanups.add(() => clearTimeout(id));
      return id;
    },
    interval(fn, ms) {
      const id = setInterval(() => {
        if (!dead) fn();
      }, ms);
      cleanups.add(() => clearInterval(id));
      return id;
    },
    /** Calls fn(dtSeconds, nowMs) every frame until disposed or stop() is called. */
    loop(fn) {
      let id = 0;
      let last = performance.now();
      let on = true;
      const step = (t) => {
        if (dead || !on) return;
        const dt = Math.min(0.1, (t - last) / 1000);
        last = t;
        fn(dt, t);
        id = requestAnimationFrame(step);
      };
      id = requestAnimationFrame(step);
      const stop = () => {
        on = false;
        cancelAnimationFrame(id);
      };
      cleanups.add(stop);
      return stop;
    },
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      cleanups.add(() => target.removeEventListener(type, fn, opts));
    },
    /** sleep that never resolves after dispose, so awaiting code just stops. */
    wait(ms) {
      return new Promise((res) => life.timeout(res, ms));
    },
    dispose() {
      if (dead) return;
      dead = true;
      for (const fn of cleanups) {
        try {
          fn();
        } catch (e) {
          console.error(e);
        }
      }
      cleanups.clear();
    },
  };
  return life;
}
