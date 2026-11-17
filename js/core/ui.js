// Shared interface pieces so every game looks and behaves alike.
// The stage is always 844 x 390 px (phone landscape); main.js scales it to
// fit the real screen, so lay things out in plain px.
//
//   h(tag, props, ...children)          tiny DOM builder
//   noteEl('C♯')                        note name with a properly set accidental
//   button(label, { kind, onClick })    kind: 'primary' | 'ghost' | 'quiet'
//   segmented({ label, options, value, onChange })
//   gameScreen(root, game, { onBack, stats })  -> { el, body, hud }
//   intro(scr, {...})                   start screen
//   results(scr, {...})                 end-of-run overlay
//   countdown(scr, life)                3-2-1 before a timed run
//   toast(scr, text, { kind, ms })      brief message under the HUD
//   lives(max)                          row of guitar picks -> { el, set(n) }
//   bar()                               thin progress/timer bar -> { el, set(0..1) }
//   board(rows)                         small leaderboard table
//   houseScores(seed, {...})            repeatable CPU scores to rank against
//   copyText(text)                      clipboard with a safe fallback

import { audio } from './audio.js';
import { rng } from './util.js';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k.startsWith('--')) el.style.setProperty(k, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (kid) => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * HTML string for a note or chord name with ♯/♭ wrapped for styling.
 * Inside an element with class "dot" (the big dot-matrix type) the
 * accidental shows as # or b, the way a tuner display writes it.
 */
export function noteHTML(name) {
  return escapeHtml(name).replace(/[♯♭]/g, (m) => `<span class="acc"><span class="acc-sym">${m}</span><span class="acc-txt" aria-hidden="true">${m === '♯' ? '#' : 'b'}</span></span>`);
}
/** Element for a note or chord name, e.g. noteEl('B♭m7'). */
export function noteEl(name, cls = '') {
  return h('span', { class: `note ${cls}`.trim(), html: noteHTML(name) });
}

export function button(label, { kind = 'ghost', onClick, small = false, disabled = false, cls = '', sound = 'tap' } = {}) {
  const b = h('button', { class: `btn btn-${kind}${small ? ' btn-small' : ''} ${cls}`.trim(), type: 'button' }, label);
  b.disabled = disabled;
  b.addEventListener('click', (ev) => {
    audio.unlock();
    if (sound) audio.sfx(sound);
    onClick?.(ev);
  });
  return b;
}

/** A row of mutually exclusive options. Returns the element; read `.value`. */
export function segmented({ label = '', options, value, onChange }) {
  const wrap = h('div', { class: 'seg' });
  if (label) wrap.append(h('span', { class: 'seg-label' }, label));
  const row = h('div', { class: 'seg-row', role: 'group', 'aria-label': label || 'Options' });
  wrap.append(row);
  wrap.value = value;
  const btns = options.map((opt) => {
    const b = h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': String(opt.value === value) }, opt.label);
    b.addEventListener('click', () => {
      audio.unlock();
      audio.sfx('tick');
      wrap.value = opt.value;
      btns.forEach((x, i) => x.setAttribute('aria-pressed', String(options[i].value === opt.value)));
      onChange?.(opt.value);
    });
    row.append(b);
    return b;
  });
  return wrap;
}

/**
 * Standard game frame: a HUD strip on top (44 px) and a body (844 x 346).
 * stats: [{ key, label, value }] shown at the right of the HUD.
 * Returns { el, body, hud: { set(key, value), setStats(stats), mid } }.
 */
export function gameScreen(root, game, { onBack, stats = [] } = {}) {
  root.replaceChildren();
  const statBox = h('div', { class: 'hud-stats' });
  const mid = h('div', { class: 'hud-mid' });
  const els = {};
  const setStats = (list) => {
    statBox.replaceChildren();
    for (const k in els) delete els[k];
    for (const st of list) {
      const v = h('span', { class: 'stat-value' }, st.value ?? '');
      els[st.key] = v;
      statBox.append(h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, st.label), v));
    }
  };
  setStats(stats);
  const body = h('div', { class: 'screen-body' });
  const el = h(
    'div',
    { class: 'screen', '--game': game.color || 'var(--fiesta)' },
    h(
      'header',
      { class: 'hud' },
      h('button', { class: 'hud-back', type: 'button', 'aria-label': 'Back to all games', onclick: () => { audio.sfx('tap'); onBack?.(); } }, h('span', { 'aria-hidden': 'true' }, '‹')),
      h('div', { class: 'hud-title' }, game.title),
      mid,
      statBox,
    ),
    body,
  );
  root.append(el);
  return {
    el,
    body,
    hud: {
      mid,
      setStats,
      set(key, value) {
        const v = els[key];
        if (!v) return;
        if (value instanceof Node) v.replaceChildren(value);
        else if (v.textContent !== String(value)) v.textContent = value;
      },
      bump(key) {
        const v = els[key];
        if (!v) return;
        v.classList.remove('is-bump');
        void v.offsetWidth;
        v.classList.add('is-bump');
      },
    },
  };
}

/**
 * Start screen. Replaces scr.body.
 *   intro(scr, {
 *     title: 'Fret Sprint', tagline: 'one line pitch',
 *     steps: ['how to play, line 1', 'line 2', 'line 3'],
 *     options: [segmented(...), ...],        // optional controls
 *     best: { label: 'Best', value: '42' },  // optional
 *     startLabel: 'Start', onStart() {},
 *     secondary: button(...)                 // optional extra button
 *   })
 */
export function intro(scr, { title, tagline, steps = [], options = [], best = null, startLabel = 'Start', onStart, secondary = null }) {
  const left = h(
    'div',
    { class: 'intro-left' },
    h('h1', { class: 'intro-title' }, title),
    h('p', { class: 'intro-tagline' }, tagline),
    h('ol', { class: 'intro-steps' }, steps.map((s) => h('li', null, s))),
    best && best.value != null ? h('div', { class: 'intro-best' }, h('span', { class: 'stat-label' }, best.label), h('span', { class: 'intro-best-value' }, String(best.value))) : null,
  );
  const right = h(
    'div',
    { class: 'intro-right' },
    options.length ? h('div', { class: 'intro-options' }, options) : null,
    h('div', { class: 'intro-go' }, secondary, button(startLabel, { kind: 'primary', cls: 'btn-big', onClick: onStart, sound: 'stomp' })),
  );
  scr.body.replaceChildren(h('div', { class: 'intro' }, left, right));
}

/**
 * End-of-run overlay on top of the screen.
 *   results(scr, {
 *     title: 'Time!', big: '42', unit: 'notes per minute',
 *     badge: 'New best',                       // optional
 *     rows: [['Accuracy', '92%'], ...],        // optional detail lines
 *     board: [{ name, score, you, cpu }],      // optional ranking: rows, or an element from boards.js
 *     boardTitle: 'Today',
 *     actions: [{ label, kind, onClick }],
 *   }) -> { el, close() }
 */
export function results(scr, { title, big, unit = '', badge = null, rows = [], board: boardRows = null, boardTitle = 'Ranking', actions = [], extra = null }) {
  const card = h(
    'div',
    { class: 'results-card' },
    h(
      'div',
      { class: 'results-main' },
      h('div', { class: 'results-title' }, title, badge ? h('span', { class: 'badge' }, badge) : null),
      h('div', { class: 'display results-display' }, h('span', { class: 'results-big dot' }, big instanceof Node ? big : String(big)), unit ? h('span', { class: 'results-unit' }, unit) : null),
      rows.length ? h('dl', { class: 'results-rows' }, rows.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v instanceof Node ? v : String(v))))) : null,
      extra,
      h('div', { class: 'results-actions' }, actions.map((a) => button(a.label, { kind: a.kind || 'ghost', onClick: a.onClick }))),
    ),
    boardRows ? h('div', { class: 'results-side' }, h('div', { class: 'side-title' }, boardTitle), boardRows instanceof Node ? boardRows : board(boardRows)) : null,
  );
  const el = h('div', { class: 'overlay' }, card);
  scr.el.append(el);
  return { el, close: () => el.remove() };
}

/** Generic modal overlay with your own content. Returns { el, close() }. */
export function overlay(scr, content, { cls = '' } = {}) {
  const el = h('div', { class: `overlay ${cls}`.trim() }, content);
  scr.el.append(el);
  return { el, close: () => el.remove() };
}

/** 3-2-1 countdown over the screen. Resolves when play should begin. */
export function countdown(scr, life, from = 3) {
  return new Promise((resolve) => {
    const num = h('div', { class: 'count-num' }, String(from));
    const el = h('div', { class: 'overlay overlay-clear' }, num);
    scr.el.append(el);
    life.add(() => el.remove());
    let n = from;
    audio.sfx('count');
    const step = () => {
      n -= 1;
      if (n <= 0) {
        audio.sfx('go');
        el.remove();
        resolve();
        return;
      }
      num.textContent = String(n);
      num.classList.remove('is-pop');
      void num.offsetWidth;
      num.classList.add('is-pop');
      audio.sfx('count');
      life.timeout(step, 650);
    };
    life.timeout(step, 650);
  });
}

/** Brief message under the HUD. kind: 'good' | 'bad' | 'info'. */
export function toast(scr, text, { kind = 'info', ms = 1100 } = {}) {
  scr.el.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div', { class: `toast toast-${kind}` }, text);
  scr.el.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

const PICK = '<svg viewBox="0 0 20 22" width="16" height="18" aria-hidden="true"><path d="M10 21C5 15 1.5 10.5 1.5 6.6 1.5 3 5 1 10 1s8.5 2 8.5 5.6C18.500 10.500 15 15 10 21Z"/></svg>';

/** Lives shown as guitar picks. */
export function lives(max, n = max) {
  const el = h('span', { class: 'lives', role: 'img' });
  const set = (v) => {
    el.setAttribute('aria-label', `${v} of ${max} lives`);
    el.innerHTML = Array.from({ length: max }, (_, i) => `<span class="pick${i < v ? '' : ' is-lost'}">${PICK}</span>`).join('');
  };
  set(n);
  return { el, set };
}

/** Thin bar for timers and progress. set(0..1). */
export function bar({ cls = '' } = {}) {
  const fill = h('div', { class: 'bar-fill' });
  const el = h('div', { class: `bar ${cls}`.trim() }, fill);
  return {
    el,
    set(v) {
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, v))})`;
      el.classList.toggle('is-low', v < 0.25);
    },
  };
}

/** Leaderboard table. rows: [{ name, score, you, cpu, here }] already sorted. `here` adds a dot for a player who has the page open now. */
export function board(rows) {
  return h(
    'ol',
    { class: 'board' },
    rows.map((r, i) =>
      h(
        'li',
        { class: r.you ? 'is-you' : '' },
        h('span', { class: 'board-rank' }, String(r.rank ?? i + 1)),
        h('span', { class: 'board-name' }, r.name, r.cpu ? h('span', { class: 'tag' }, 'CPU') : null, r.here ? h('i', { class: 'here-dot', role: 'img', 'aria-label': 'here now' }) : null),
        h('span', { class: 'board-score' }, String(r.score)),
      ),
    ),
  );
}

const HOUSE = ['Tweed', 'Fuzz', 'Wah', 'Capo', 'Trem', 'Slide', 'Reverb', 'Humbucker', 'Whammy', 'Plectrum'];

/**
 * Repeatable CPU scores so a run has something to rank against. These are
 * practice opponents, always tagged CPU in the table, not real players.
 *   houseScores('fret-sprint:2026-11-16', { count: 6, min: 12, max: 48 })
 * Returns [{ name, score, cpu: true }] sorted best first.
 */
export function houseScores(seed, { count = 6, min = 10, max = 50, lowerIsBetter = false, round = 1 } = {}) {
  const r = rng(`house:${seed}`);
  const names = r.shuffle(HOUSE).slice(0, count);
  const rows = names.map((name) => {
    const t = Math.pow(r(), 1.4); // more scores near the bottom of the range
    const score = Math.round((min + (max - min) * t) / round) * round;
    return { name, score, cpu: true };
  });
  rows.sort((a, b) => (lowerIsBetter ? a.score - b.score : b.score - a.score));
  return rows;
}

/** Merge the player into a board and return the top rows plus the player's rank. */
export function rankWith(rows, you, { lowerIsBetter = false, keep = 6 } = {}) {
  const all = [...rows, { ...you, you: true }];
  all.sort((a, b) => (lowerIsBetter ? a.score - b.score : b.score - a.score) || (a.you ? -1 : 1));
  all.forEach((r, i) => (r.rank = i + 1));
  const rank = all.findIndex((r) => r.you) + 1;
  let shown = all.slice(0, keep);
  if (rank > keep) shown = [...all.slice(0, keep - 1), all[rank - 1]];
  return { rows: shown, rank, total: all.length };
}

/** Copy text to the clipboard. Resolves true if it worked. Call from a click handler. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/** Add a game's own styles once. Prefix your class names (e.g. ".fs-") to avoid clashes. */
export function injectCSS(id, cssText) {
  if (document.getElementById(`css-${id}`)) return;
  const st = document.createElement('style');
  st.id = `css-${id}`;
  st.textContent = cssText;
  document.head.append(st);
}
