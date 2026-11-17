// App shell: scales the fixed 844x390 stage to the screen, shows the hub
// (a pedalboard, one pedal per game), and mounts whichever game is chosen.
// Also the two shell screens: Progress (this player) and Scores (everyone).

import { store } from './core/store.js';
import { audio } from './core/audio.js';
import { mic } from './core/mic.js';
import { h, button, gameScreen, board } from './core/ui.js';
import { net } from './core/net.js';
import { peopleRows } from './core/boards.js';
import { createFretboard } from './core/fretboard.js';
import { pcName, pcAt } from './core/theory.js';
import { GAMES } from './games/index.js';

const STAGE_W = 844;
const STAGE_H = 390;
const fitEl = document.getElementById('fit');
const stage = document.getElementById('stage');

function fit() {
  const W = fitEl.clientWidth;
  const H = fitEl.clientHeight;
  if (!W || !H) return;
  // An upright phone gets the stage turned on its side, so the player
  // rotates the phone and the layout stays landscape either way.
  const turn = W < H && W < 560;
  const aw = turn ? H : W;
  const ah = turn ? W : H;
  const s = Math.min(aw / STAGE_W, ah / STAGE_H, 1.75);
  const w = STAGE_W * s;
  const hh = STAGE_H * s;
  if (turn) {
    stage.style.transform = `translate(${(W - hh) / 2 + hh}px, ${(H - w) / 2}px) rotate(90deg) scale(${s})`;
  } else {
    stage.style.transform = `translate(${(W - w) / 2}px, ${(H - hh) / 2}px) scale(${s})`;
  }
  stage.classList.toggle('is-framed', !turn && W - w > 60 && H - hh > 60);
}
new ResizeObserver(fit).observe(fitEl);
window.addEventListener('resize', fit);
fit();

window.addEventListener('pointerdown', () => audio.unlock(), { capture: true });

// ---- other players ---------------------------------------------------------------
// Each game reports its own scores (see core/boards.js); together they make
// the one card this player shares with the others.
net.start({
  card() {
    const day = {};
    const best = {};
    for (const g of GAMES) {
      const s = g.scores ? g.scores() : null;
      if (!s) continue;
      if (s.day != null) day[g.id] = s.day;
      if (s.best != null) best[g.id] = s.best;
    }
    return { day, best };
  },
  lower: (gameId, kind) => !!GAMES.find((g) => g.id === gameId)?.boards?.[kind]?.lower,
});

// ---- routing -------------------------------------------------------------------
let dispose = null;

function go(name) {
  if ((location.hash || '#').slice(1) === name) route();
  else location.hash = name;
}

function route() {
  if (dispose) {
    try {
      dispose();
    } catch (e) {
      console.error(e);
    }
    dispose = null;
  }
  mic.stop();
  const name = (location.hash || '').slice(1);
  const game = GAMES.find((g) => g.id === name);
  stage.replaceChildren();
  if (game) {
    dispose = game.mount(stage, { exit: () => go('') }) || null;
  } else if (name === 'progress') {
    showProgress();
  } else if (name === 'scores') {
    showScores();
  } else {
    showHub();
  }
}
window.addEventListener('hashchange', route);

// ---- hub -----------------------------------------------------------------------
function showHub() {
  const streak = store.streak();
  const soundBtn = button(store.settings.sound ? 'Sound on' : 'Sound off', {
    small: true,
    onClick: () => {
      store.setSetting('sound', !store.settings.sound);
      soundBtn.textContent = store.settings.sound ? 'Sound on' : 'Sound off';
      if (store.settings.sound) audio.sfx('good');
    },
  });
  const pedals = GAMES.map((g) => {
    const best = g.readout?.() ?? null;
    const lines = g.pedal || g.title.split(' ');
    return h(
      'button',
      {
        class: `pedal${store.playedToday(g.id) ? ' is-played' : ''}`,
        type: 'button',
        '--finish': g.color,
        'aria-label': `${g.title}: ${g.kind}`,
        onclick: () => {
          audio.unlock();
          audio.sfx('stomp');
          go(g.id);
        },
      },
      h('span', { class: 'pedal-led' }),
      h('span', { class: 'pedal-knobs' }, h('i', { class: 'knob', '--a': `${g.knobs?.[0] ?? -30}deg` }), h('i', { class: 'knob', '--a': `${g.knobs?.[1] ?? 40}deg` })),
      h('span', { class: `pedal-name${lines.some((l) => l.length > 8) ? ' is-long' : ''}` }, lines.map((l) => h('span', null, l))),
      h('span', { class: 'pedal-kind' }, g.kind),
      h('span', { class: 'pedal-best' }, best ?? '- - -'),
      h('span', { class: 'pedal-switch' }),
    );
  });
  // Who else has the page open, and whether one of them wants a Live Duel.
  const FOOT = 'Seven small games for learning the neck. Stomp a pedal to play.';
  const hereChip = h('span', { class: 'chip chip-here', hidden: true });
  const footNote = h('span', null, FOOT);
  const joinDuel = () => {
    audio.sfx('stomp');
    store.set('live-duel', 'cfg', { ...store.get('live-duel', 'cfg', {}), mode: 'online' });
    go('live-duel');
  };
  let footSig = '';
  const refresh = () => {
    const st = net.status();
    hereChip.hidden = !(st.room && st.here > 0);
    hereChip.replaceChildren(h('i', { class: 'here-dot' }), h('b', null, String(st.here)), 'here now');
    const waiting = net.room.others().find((p) => p.presence && p.presence.duel && p.presence.duel.st === 'open');
    const sig = waiting ? net.room.nameOf(waiting) : '';
    if (sig === footSig) return;
    footSig = sig;
    footNote.replaceChildren(waiting ? h('button', { class: 'foot-link', type: 'button', onclick: joinDuel }, `${sig} is waiting for a Live Duel. Tap to play.`) : FOOT);
  };
  refresh();
  dispose = net.onChange(refresh);

  stage.append(
    h(
      'div',
      { class: 'hub' },
      h(
        'div',
        { class: 'hub-top' },
        h('h1', { class: 'wordmark' }, 'Fret Arcade'),
        hereChip,
        h('span', { class: 'chip' }, h('b', null, String(streak)), 'day streak'),
        button('Scores', { small: true, onClick: () => go('scores') }),
        button('Progress', { small: true, onClick: () => go('progress') }),
        soundBtn,
      ),
      h('div', { class: 'pedalboard' }, pedals),
      h('div', { class: 'hub-foot' }, footNote, h('span', { class: 'legend' }, h('i'), 'Played today')),
    ),
  );
}

// ---- scores ----------------------------------------------------------------------
// Real players only: everyone who has posted a score, and whoever is here now.
let scoresGame = null;

function scoresStatus() {
  const st = net.status();
  if (!st.on) return 'These are your own scores. Shared boards need the claude.ai copy of this page, signed in.';
  const parts = [];
  if (st.boards === 'loading') parts.push('Loading the shared board');
  else if (st.boards === 'late') parts.push('The shared board cannot be reached yet');
  else if (st.boards === 'off') parts.push('Live scores only');
  else parts.push(`${st.players} player${st.players === 1 ? '' : 's'} on the board`);
  if (st.room) parts.push(st.here ? `${st.here} here now` : 'nobody else here now');
  if (st.canPost === false) parts.push(st.room ? 'view-only: others see your scores while you are here' : 'view-only: your scores stay on this device');
  return parts.join(' · ');
}

function showScores() {
  let sel = GAMES.find((g) => g.id === scoresGame) || GAMES[0];
  const scr = gameScreen(stage, { title: 'Scores', color: sel.color }, { onBack: () => go('') });
  const cols = h('div', { class: 'scores-cols' });
  const foot = h('div', { class: 'scores-foot' });
  const railBtns = GAMES.map((g) =>
    h(
      'button',
      {
        class: 'scores-game',
        type: 'button',
        '--finish': g.color,
        onclick: () => {
          audio.sfx('tick');
          sel = g;
          scoresGame = g.id;
          render();
        },
      },
      h('i'),
      g.title,
    ),
  );
  scr.body.append(h('div', { class: 'scores' }, h('div', { class: 'scores-rail', role: 'group', 'aria-label': 'Game' }, railBtns), cols, foot));

  const column = (kind) => {
    const meta = sel.boards?.[kind];
    if (!meta) return null;
    const { rows, total } = peopleRows(sel.id, kind, { lower: meta.lower, fmt: meta.fmt, keep: 7 });
    return h(
      'section',
      { class: 'scores-col' },
      h('div', { class: 'side-title' }, meta.title, h('small', null, total > rows.length ? `${total} players · ${meta.unit}` : meta.unit)),
      rows.length ? board(rows) : h('p', { class: 'scores-empty' }, kind === 'day' ? 'Nobody has posted a score today. Play the daily round to be first.' : 'No scores yet. Play a round to be first.'),
    );
  };
  function render() {
    scr.el.style.setProperty('--game', sel.color);
    railBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(GAMES[i] === sel)));
    const shown = [column('day'), column('best')].filter(Boolean);
    if (shown.length === 1) {
      const why = sel.id === 'live-duel' ? 'Ratings move when you win or lose a ranked or online match. The board keeps each player\u2019s highest.' : 'This game has no daily round, so it has one board.';
      shown.push(h('section', { class: 'scores-col scores-note' }, h('p', null, why)));
    }
    cols.replaceChildren(...shown);
    foot.textContent = scoresStatus();
  }
  render();
  dispose = net.onChange(render);
}

// ---- progress ------------------------------------------------------------------
function heatColor(m) {
  if (m < 0.5) return `color-mix(in srgb, var(--warn) ${Math.round(m * 200)}%, var(--bad))`;
  return `color-mix(in srgb, var(--good) ${Math.round((m - 0.5) * 200)}%, var(--warn))`;
}

function showProgress() {
  const scr = gameScreen(stage, { title: 'Progress', color: 'var(--surf)' }, { onBack: () => go('') });
  let seen = 0;
  let solid = 0;
  for (let s = 0; s < 6; s++) {
    for (let f = 0; f <= 12; f++) {
      const m = store.heat(s, f).mastery;
      if (m != null) seen++;
      if (m != null && m >= 0.7) solid++;
    }
  }
  const plays = GAMES.reduce((n, g) => n + store.plays(g.id), 0);
  const tile = (value, label, small) => h('div', { class: 'tile' }, h('b', null, String(value)), h('span', { class: 'stat-label' }, label), h('small', null, small));

  let armed = false;
  const resetBtn = button('Reset progress', {
    kind: 'quiet',
    small: true,
    onClick: () => {
      if (!armed) {
        armed = true;
        resetBtn.textContent = 'Tap again to erase';
        return;
      }
      store.reset();
      route();
    },
  });

  const top = h(
    'div',
    { class: 'progress-top' },
    h('div', { class: 'progress-tiles' }, tile(store.streak(), 'Day streak', 'days in a row'), tile(`${solid}/78`, 'Spots solid', `${seen} tried so far`), tile(plays, 'Rounds', 'across all games')),
    h(
      'div',
      { class: 'bests' },
      GAMES.map((g) => h('div', null, h('span', null, g.title), h('b', null, g.readout?.() ?? '-'))),
    ),
  );
  const legend = h(
    'div',
    { class: 'heat-legend' },
    h('span', null, 'Shaky'),
    h('i'),
    h('span', null, 'Solid'),
    h('span', { style: { marginLeft: '14px', color: 'var(--ink-3)' } }, seen ? 'Each spot is scored on accuracy and speed across every game.' : 'Play a round and this neck fills in.'),
    h('span', { style: { marginLeft: 'auto' } }, resetBtn),
  );
  const wrap = h('div', { class: 'progress' }, top, legend);
  scr.body.append(wrap);
  const fb = createFretboard(wrap, { pluck: true });
  fb.labelAll((s, f) => (f === 0 ? null : pcName(pcAt(s, f))));
  for (let s = 0; s < 6; s++) {
    for (let f = 0; f <= 12; f++) {
      const m = store.heat(s, f).mastery;
      if (m != null) fb.shade(s, f, { kind: 'heat', fill: heatColor(m), opacity: 0.82 });
    }
  }
}

route();
