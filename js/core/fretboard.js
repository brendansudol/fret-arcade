// The on-screen fretboard every game shares. It is drawn as it looks in tab
// and chord charts: nut on the left, high E string on top, low E at the
// bottom. The column left of the nut holds the open strings.
//
//   const fb = createFretboard(parentEl, {
//     strings: [0,1,2,3,4,5],   // which strings to draw (0 = low E ... 5 = high E)
//     frets: 12,                // highest fret
//     width: 812, rowH: 31,     // size in px; height follows from the rows
//     pluck: true,              // play the note when a cell is tapped
//     onTap({ s, f, midi, pc }) {}
//   })
//
//   fb.mark(s, f, { label, kind, shape, pulse, small })   put a dot on a cell
//        kind:  'accent' (game colour) | 'good' | 'bad' | 'warn' | 'ink' | 'ghost' | 'off'
//        shape: 'dot' | 'square' | 'ring'
//   fb.unmark(s, f)   fb.clearMarks()
//   fb.flash(s, f, kind, { label, ms })      short-lived dot, leaves marks alone
//   fb.link(a, b, { label, kind })           line between two cells -> { remove() }
//   fb.clearLinks()
//   fb.shade(s, f, { kind: 'off' })          dim a cell (also { fill, opacity } for heat maps)
//   fb.unshade(s, f)  fb.clearShades()
//   fb.focusStrings([3,4,5])                 dim and lock the other strings; null to reset
//   fb.labelAll((s, f) => 'C' | null)        faint note names in every cell; fb.clearLabels()
//   fb.setEnabled(false)                     ignore taps
//   fb.clear()                               marks + links + shades + labels
//   fb.xy(s, f) -> { x, y }                  centre of a cell in fretboard px
//   fb.el  fb.width  fb.height  fb.destroy()

import { midiAt, pcAt, STRING_LETTERS } from './theory.js';
import { audio } from './audio.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, parent = null) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

const INLAYS = [3, 5, 7, 9];

export function createFretboard(parent, opts = {}) {
  const o = {
    frets: 12,
    strings: [0, 1, 2, 3, 4, 5],
    width: 812,
    rowH: 31,
    openW: 46,
    stringLabels: true,
    fretNumbers: true,
    pluck: true,
    onTap: null,
    ...opts,
  };
  const rows = [...o.strings].sort((a, b) => b - a); // top row = highest string
  const top = 5;
  const boardH = rows.length * o.rowH;
  const bottom = o.fretNumbers ? 17 : 5;
  const W = o.width;
  const H = top + boardH + bottom;
  const fretW = (W - o.openW) / o.frets;
  const R = Math.min(13, o.rowH * 0.42);

  const X = (f) => (f === 0 ? o.openW / 2 - 1 : o.openW + (f - 0.5) * fretW);
  const Y = (s) => top + rows.indexOf(s) * o.rowH + o.rowH / 2;

  const wrap = document.createElement('div');
  wrap.className = 'fretboard';
  wrap.style.width = W + 'px';
  wrap.style.height = H + 'px';
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Guitar fretboard' }, wrap);

  // --- static artwork ---------------------------------------------------
  svg('rect', { class: 'fb-board', x: o.openW, y: top, width: W - o.openW, height: boardH, rx: 5 }, root);
  const midY = top + boardH / 2;
  for (const f of INLAYS) {
    if (f <= o.frets) svg('circle', { class: 'fb-inlay', cx: X(f), cy: midY, r: 5 }, root);
  }
  if (o.frets >= 12) {
    const off = rows.length >= 4 ? o.rowH : o.rowH * 0.55;
    svg('circle', { class: 'fb-inlay', cx: X(12), cy: midY - off, r: 5 }, root);
    svg('circle', { class: 'fb-inlay', cx: X(12), cy: midY + off, r: 5 }, root);
  }
  for (let f = 1; f < o.frets; f++) {
    const x = o.openW + f * fretW;
    svg('line', { class: 'fb-fret', x1: x, x2: x, y1: top + 1, y2: top + boardH - 1 }, root);
  }
  svg('rect', { class: 'fb-nut', x: o.openW - 2, y: top, width: 5, height: boardH, rx: 1.5 }, root);
  const stringEls = {};
  for (const s of rows) {
    stringEls[s] = svg(
      'line',
      { class: 'fb-string', x1: o.openW + 3, x2: W, y1: Y(s), y2: Y(s), 'stroke-width': (2.7 - s * 0.34).toFixed(2) },
      root,
    );
  }
  const openEls = {};
  if (o.stringLabels) {
    for (const s of rows) {
      const g = svg('g', { class: 'fb-open', transform: `translate(${X(0)},${Y(s)})` }, root);
      svg('circle', { r: Math.min(11, R) }, g);
      const t = svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
      t.textContent = STRING_LETTERS[s];
      openEls[s] = g;
    }
  }
  if (o.fretNumbers) {
    for (const f of [...INLAYS, 12]) {
      if (f > o.frets) continue;
      const t = svg('text', { class: 'fb-num', x: X(f), y: top + boardH + 12, 'text-anchor': 'middle' }, root);
      t.textContent = f;
    }
  }

  // --- dynamic layers -----------------------------------------------------
  const dimLayer = svg('g', {}, root);
  const shadeLayer = svg('g', {}, root);
  const labelLayer = svg('g', { class: 'fb-labels' }, root);
  const linkLayer = svg('g', {}, root);
  const markLayer = svg('g', {}, root);
  const hitLayer = svg('g', {}, root);
  const fxLayer = svg('g', { 'pointer-events': 'none' }, root);

  const cellRect = (s, f) => ({
    x: f === 0 ? 0 : o.openW + (f - 1) * fretW,
    y: top + rows.indexOf(s) * o.rowH,
    width: f === 0 ? o.openW : fretW,
    height: o.rowH,
  });

  for (const s of rows) {
    for (let f = 0; f <= o.frets; f++) {
      const r = svg('rect', { class: 'fb-hit', ...cellRect(s, f) }, hitLayer);
      r.dataset.s = s;
      r.dataset.f = f;
    }
  }

  let enabled = true;
  let locked = new Set();
  const marks = new Map();
  const shades = new Map();
  const links = new Set();
  const key = (s, f) => `${s}:${f}`;

  function ripple(s, f) {
    const c = svg('circle', { class: 'fb-ripple', cx: X(f), cy: Y(s), r: R }, fxLayer);
    c.addEventListener('animationend', () => c.remove());
    setTimeout(() => c.remove(), 600);
  }

  function onDown(ev) {
    const t = ev.target;
    if (!t.dataset || t.dataset.s == null) return;
    ev.preventDefault();
    if (!enabled) return;
    const s = +t.dataset.s;
    const f = +t.dataset.f;
    if (locked.has(s)) return;
    audio.unlock();
    ripple(s, f);
    if (o.pluck) audio.pluck(midiAt(s, f));
    o.onTap?.({ s, f, midi: midiAt(s, f), pc: pcAt(s, f) });
  }
  root.addEventListener('pointerdown', onDown);

  function makeMark(layer, s, f, { label = '', kind = 'accent', shape = 'dot', pulse = false, small = false } = {}) {
    const g = svg('g', { class: `fb-mk k-${kind} sh-${shape}${pulse ? ' is-pulse' : ''}${f === 0 ? ' is-open' : ''}`, transform: `translate(${X(f)},${Y(s)})` }, layer);
    const inner = svg('g', { class: 'fb-mk-in' }, g);
    const r = small ? R * 0.62 : R;
    if (shape === 'square') svg('rect', { x: -r, y: -r, width: r * 2, height: r * 2, rx: 4 }, inner);
    else svg('circle', { r }, inner);
    if (label !== '' && label != null) {
      const text = String(label);
      const t = svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, inner);
      // inline style so it wins over the stylesheet's default mark size
      t.style.fontSize = `${text.length > 2 ? 10 : small ? 9.5 : 12.5}px`;
      t.textContent = text;
    }
    return g;
  }

  const fb = {
    el: wrap,
    svg: root,
    width: W,
    height: H,
    strings: rows.slice().reverse(),
    frets: o.frets,
    xy: (s, f) => ({ x: X(f), y: Y(s) }),

    mark(s, f, m = {}) {
      fb.unmark(s, f);
      const g = makeMark(markLayer, s, f, m);
      marks.set(key(s, f), g);
      if (f === 0 && openEls[s]) openEls[s].style.visibility = 'hidden';
      return g;
    },
    unmark(s, f) {
      const g = marks.get(key(s, f));
      if (g) {
        g.remove();
        marks.delete(key(s, f));
      }
      if (f === 0 && openEls[s]) openEls[s].style.visibility = '';
    },
    clearMarks() {
      for (const k of [...marks.keys()]) {
        const [s, f] = k.split(':').map(Number);
        fb.unmark(s, f);
      }
    },
    hasMark: (s, f) => marks.has(key(s, f)),

    flash(s, f, kind = 'good', { label = '', ms = 520, shape = 'dot' } = {}) {
      const g = makeMark(fxLayer, s, f, { label, kind, shape });
      g.classList.add('is-flash');
      g.querySelector('.fb-mk-in').style.animationDuration = `${ms}ms`;
      setTimeout(() => g.remove(), ms);
    },

    link(a, b, { label = '', kind = 'accent' } = {}) {
      const g = svg('g', { class: `fb-link k-${kind}` }, linkLayer);
      const p1 = { x: X(a.f), y: Y(a.s) };
      const p2 = { x: X(b.f), y: Y(b.s) };
      svg('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, g);
      if (label) {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const w = 12 + String(label).length * 6.5;
        svg('rect', { x: mx - w / 2, y: my - 8, width: w, height: 16, rx: 8 }, g);
        const t = svg('text', { x: mx, y: my, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
        t.textContent = label;
      }
      const handle = {
        el: g,
        remove() {
          g.remove();
          links.delete(handle);
        },
      };
      links.add(handle);
      return handle;
    },
    clearLinks() {
      for (const l of [...links]) l.remove();
    },

    shade(s, f, { kind = 'off', fill = null, opacity = null } = {}) {
      fb.unshade(s, f);
      const c = cellRect(s, f);
      const r = svg('rect', { class: `fb-shade k-${kind}`, x: c.x + 1.5, y: c.y + 1.5, width: c.width - 3, height: c.height - 3, rx: 4 }, shadeLayer);
      if (fill) r.style.fill = fill;
      if (opacity != null) r.style.opacity = opacity;
      shades.set(key(s, f), r);
      return r;
    },
    unshade(s, f) {
      const r = shades.get(key(s, f));
      if (r) {
        r.remove();
        shades.delete(key(s, f));
      }
    },
    clearShades() {
      shades.forEach((r) => r.remove());
      shades.clear();
    },

    focusStrings(list, { lock = true } = {}) {
      dimLayer.replaceChildren();
      locked = new Set();
      for (const s of rows) {
        const on = !list || list.includes(s);
        stringEls[s].classList.toggle('is-dim', !on);
        stringEls[s].classList.toggle('is-focus', !!list && on);
        if (openEls[s]) openEls[s].classList.toggle('is-dim', !on);
        if (!on) {
          if (lock) locked.add(s);
          const c = cellRect(s, 1);
          svg('rect', { class: 'fb-dim', x: o.openW, y: c.y, width: W - o.openW, height: o.rowH }, dimLayer);
        }
      }
    },

    labelAll(fn) {
      labelLayer.replaceChildren();
      for (const s of rows) {
        for (let f = 0; f <= o.frets; f++) {
          const txt = fn(s, f);
          if (txt == null || txt === '') continue;
          const t = svg('text', { x: X(f), y: Y(s) - o.rowH * 0.22, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: f === 0 ? 'is-open' : '' }, labelLayer);
          t.textContent = txt;
        }
      }
    },
    clearLabels() {
      labelLayer.replaceChildren();
    },

    setEnabled(v) {
      enabled = !!v;
      wrap.classList.toggle('is-disabled', !enabled);
    },
    clear() {
      fb.clearMarks();
      fb.clearLinks();
      fb.clearShades();
      fb.clearLabels();
    },
    destroy() {
      root.removeEventListener('pointerdown', onDown);
      wrap.remove();
    },
  };

  if (parent) parent.appendChild(wrap);
  return fb;
}
