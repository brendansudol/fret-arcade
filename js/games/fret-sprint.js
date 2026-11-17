// Fret Sprint: sixty seconds, one note at a time. The score is notes found
// per minute, the guitar equivalent of a typing-speed test.
//
// This file is also the reference for how a game is put together:
//   intro screen -> countdown -> play -> results -> again / options.

import { rng, dailySeed, dayNumber, todayKey, lifecycle, TEST } from '../core/util.js';
import { pcAt, midiAt, pcName, positionsOfPc, isNatural, NATURAL_PCS, STRING_NAMES } from '../core/theory.js';
import { audio } from '../core/audio.js';
import { mic } from '../core/mic.js';
import { store } from '../core/store.js';
import { createFretboard } from '../core/fretboard.js';
import * as ui from '../core/ui.js';
import { resultsBoard } from '../core/boards.js';

const ID = 'fret-sprint';
const RUN_SECONDS = TEST.fast ? 5 : 60; // ?fast shortens the run for automated checks
const { h } = ui;

const CSS = `
.fs-play { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; padding: 0 16px 4px; }
.fs-bar { width: 100%; }
.fs-prompt { flex: 1; width: 100%; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 18px; }
.fs-display { width: 410px; height: 102px; display: flex; align-items: center; gap: 20px; padding: 0 26px; }
.fs-note { font-size: 88px; line-height: 1; min-width: 128px; text-align: center; }
.fs-note.is-new { animation: pop 0.16s ease-out; }
.fs-where { display: flex; flex-direction: column; gap: 5px; font-family: var(--font-label); font-weight: 600; }
.fs-where small { font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--lcd-dim); }
.fs-where b { font-size: 27px; line-height: 1; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.fs-side { display: flex; flex-direction: column; gap: 3px; }
.fs-side.is-right { align-items: flex-end; }
.fs-side b { font: 700 36px/1 var(--font-label); font-variant-numeric: tabular-nums; }
.fs-mic { font: 600 11px/1 var(--font-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); margin-top: 6px; }
`;

const game = {
  id: ID,
  title: 'Fret Sprint',
  kind: '60-second note hunt',
  color: 'var(--fiesta)',
  knobs: [-40, 30],
  boards: { day: { title: 'Today', unit: 'notes a minute' }, best: { title: 'All time', unit: 'notes a minute' } },
  /** This browser's scores for the shared boards (see core/boards.js). */
  scores() {
    const t = store.get(ID, 'today', {});
    return { day: t.key === todayKey() ? t.score : null, best: store.topBest(ID) };
  },
  /** Short text for the pedal's display on the hub. */
  readout() {
    const b = store.topBest(ID);
    return b == null ? null : `${b} NPM`;
  },

  mount(root, app) {
    ui.injectCSS(ID, CSS);
    const life = lifecycle();
    let run = null; // lifecycle of the current run
    const scr = ui.gameScreen(root, game, { onBack: app.exit });
    const cfg = { run: 'daily', notes: 'all', find: 'string', input: 'tap', ...store.get(ID, 'cfg', {}) };
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
        options.push(
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
          ui.segmented({
            label: 'Find it',
            options: [
              { value: 'string', label: 'On one string' },
              { value: 'any', label: 'Anywhere' },
            ],
            value: cfg.find,
            onChange: (v) => {
              cfg.find = v;
              saveCfg();
            },
          }),
        );
      }
      if (mic.supported) {
        options.push(
          ui.segmented({
            label: 'Play with',
            options: [
              { value: 'tap', label: 'Taps' },
              { value: 'guitar', label: 'Real guitar' },
            ],
            value: cfg.input,
            onChange: (v) => {
              cfg.input = v;
              saveCfg();
            },
          }),
        );
      }
      const best = store.best(ID, daily ? 'daily' : 'practice');
      ui.intro(scr, {
        title: 'Fret Sprint',
        tagline: daily ? 'Sixty seconds. Everyone gets the same notes today.' : 'Sixty seconds, weighted toward the spots you find hardest.',
        steps: ['A note lights up on the display, with the string to play it on.', 'Tap it on the neck. Every hit scores one.', 'A miss shows you where it was and costs a moment.'],
        options,
        best: best == null ? null : { label: daily ? 'Best daily' : 'Best practice', value: `${best} NPM` },
        onStart: start,
      });
    }

    async function start() {
      run?.dispose();
      run = lifecycle();
      scr.el.querySelectorAll('.overlay').forEach((o) => o.remove());

      const daily = cfg.run === 'daily';
      const onString = daily || cfg.find === 'string';
      const allNotes = daily || cfg.notes === 'all';
      const r = rng(daily ? dailySeed(ID) : undefined);

      let useMic = cfg.input === 'guitar';
      if (useMic && !(await mic.start())) {
        useMic = false;
        ui.toast(scr, 'No microphone here. Using taps.', { ms: 1800 });
      }
      if (run.dead) return;

      // ---- build the play screen ----
      scr.hud.setStats([
        { key: 'time', label: 'Time', value: RUN_SECONDS },
        { key: 'score', label: 'Notes', value: 0 },
      ]);
      const timeBar = ui.bar();
      const noteBox = h('span', { class: 'fs-note dot' }, '');
      const whereSmall = h('small', null, onString ? 'find it on the' : 'find it');
      const whereBig = h('b', null, '');
      const streakEl = h('b', null, '0');
      const accEl = h('b', null, '-');
      const play = h(
        'div',
        { class: 'fs-play' },
        h('div', { class: 'fs-bar' }, timeBar.el),
        h(
          'div',
          { class: 'fs-prompt' },
          h('div', { class: 'fs-side' }, h('span', { class: 'stat-label' }, 'Streak'), streakEl),
          h('div', { class: 'display fs-display' }, noteBox, h('span', { class: 'fs-where' }, whereSmall, whereBig)),
          h('div', { class: 'fs-side is-right' }, h('span', { class: 'stat-label' }, 'Accuracy'), accEl, useMic ? h('span', { class: 'fs-mic' }, 'Listening for your guitar') : null),
        ),
      );
      scr.body.replaceChildren(play);
      const fb = createFretboard(play, { onTap: (cell) => answer(cell, false) });
      fb.setEnabled(false);

      // ---- run state ----
      let live = false;
      let cur = null;
      let promptAt = 0;
      let lockUntil = 0;
      let score = 0;
      let attempts = 0;
      let streak = 0;
      let bestStreak = 0;
      const marks = []; // true/false per answer, for the share line
      const perString = Array.from({ length: 6 }, () => ({ n: 0, ms: 0 }));

      function nextPrompt() {
        let s;
        let pc;
        do {
          if (daily) {
            s = r.int(6);
            pc = r.int(12);
          } else if (onString) {
            const cells = [];
            const weights = [];
            for (let ss = 0; ss < 6; ss++) {
              for (let f = 0; f < 12; f++) {
                if (allNotes || isNatural(pcAt(ss, f))) {
                  cells.push({ s: ss, f });
                  weights.push(store.weakness(ss, f));
                }
              }
            }
            const c = r.weighted(cells, weights);
            s = c.s;
            pc = pcAt(c.s, c.f);
          } else {
            s = null;
            pc = allNotes ? r.int(12) : r.pick(NATURAL_PCS);
          }
        } while (cur && pc === cur.pc);
        const name = isNatural(pc) ? pcName(pc) : pcName(pc, r() < 0.5 ? 'sharp' : 'flat');
        cur = { s, pc, name, targets: positionsOfPc(pc, s == null ? {} : { strings: [s] }) };
        noteBox.replaceChildren(ui.noteEl(name));
        noteBox.classList.remove('is-new');
        void noteBox.offsetWidth;
        noteBox.classList.add('is-new');
        whereBig.textContent = s == null ? 'anywhere' : `${STRING_NAMES[s]} string`;
        fb.focusStrings(s == null ? null : [s]);
        promptAt = performance.now();
      }

      function answer({ s, f, midi, pc }, viaMic) {
        const now = performance.now();
        if (!live || now < lockUntil) return;
        const ok = viaMic
          ? cur.s == null
            ? pc === cur.pc
            : cur.targets.some((t) => midiAt(t.s, t.f) === midi)
          : pc === cur.pc && (cur.s == null || s === cur.s);
        if (viaMic && !ok) return; // stray sounds never count against you
        attempts++;
        marks.push(ok);
        if (ok) {
          const cell = viaMic ? cur.targets[0] : { s, f };
          const ms = now - promptAt;
          score++;
          streak++;
          bestStreak = Math.max(bestStreak, streak);
          perString[cell.s].n++;
          perString[cell.s].ms += ms;
          store.recordNote(cell.s, cell.f, true, ms);
          fb.flash(cell.s, cell.f, 'good', { label: cur.name });
          audio.sfx(streak > 0 && streak % 5 === 0 ? 'great' : 'good');
          scr.hud.set('score', score);
          scr.hud.bump('score');
          nextPrompt();
        } else {
          streak = 0;
          const t = cur.targets[0];
          if (cur.s != null) store.recordNote(t.s, t.f, false);
          fb.flash(s, f, 'bad', { label: pcName(pc, cur.name.includes('♭') ? 'flat' : 'sharp'), ms: 650 });
          cur.targets.forEach((c) => fb.flash(c.s, c.f, 'accent', { label: cur.name, ms: 650 }));
          audio.sfx('bad');
          lockUntil = now + 650;
          run.timeout(() => live && nextPrompt(), 650);
        }
        streakEl.textContent = String(streak);
        accEl.textContent = `${Math.round((score / attempts) * 100)}%`;
      }

      function finish() {
        live = false;
        fb.setEnabled(false);
        fb.focusStrings(null);
        run.dispose();
        mic.stop();
        audio.sfx('win');
        const mode = daily ? 'daily' : 'practice';
        const rec = store.recordRun(ID, score, { mode });
        if (daily) {
          const today = store.get(ID, 'today', {});
          const prev = today.key === todayKey() ? today.score : -1;
          if (score > prev) store.set(ID, 'today', { key: todayKey(), score });
        }
        const acc = attempts ? Math.round((score / attempts) * 100) : 0;
        const avg = score ? perString.reduce((n, p) => n + p.ms, 0) / score / 1000 : 0;
        const slow = perString
          .map((p, i) => ({ i, avg: p.n ? p.ms / p.n : 0 }))
          .filter((p) => p.avg)
          .sort((a, b) => b.avg - a.avg)[0];
        const rows = [
          ['Accuracy', `${acc}%`],
          ['Best streak', bestStreak],
          ['Per note', score ? `${avg.toFixed(1)} s` : '-'],
          ['Slowest string', slow ? STRING_NAMES[slow.i] : '-'],
        ];
        let boardRows = null;
        if (daily) {
          const todayBest = store.get(ID, 'today', {}).score ?? score;
          boardRows = resultsBoard({ gameId: ID, kind: 'day', you: todayBest, cpu: ui.houseScores(dailySeed(ID), { count: 7, min: 12, max: 50 }) });
        }
        const shareLine = `Fret Sprint${daily ? ` #${dayNumber()}` : ''}: ${score} notes/min, ${acc}% accurate\n${marks.slice(0, 40).map((m) => (m ? '🟩' : '🟥')).join('')}`;
        const res = ui.results(scr, {
          title: daily ? `Daily #${dayNumber()}` : 'Practice run',
          big: score,
          unit: 'notes per minute',
          badge: rec.isBest && rec.plays > 1 && score > 0 ? 'New best' : null,
          rows,
          board: boardRows,
          boardTitle: "Today's board",
          actions: [
            { label: 'Again', kind: 'primary', onClick: start },
            {
              label: 'Copy result',
              onClick: async () => {
                const ok = await ui.copyText(shareLine);
                ui.toast(scr, ok ? 'Copied' : 'Copy not available here', { kind: ok ? 'good' : 'info' });
              },
            },
            { label: 'Options', onClick: showIntro },
          ],
        });
        life.add(() => res.close());
      }

      // ---- go ----
      nextPrompt();
      noteBox.textContent = '';
      whereBig.textContent = 'get ready';
      fb.focusStrings(null);
      const first = cur;
      cur = null;
      await ui.countdown(scr, run);
      cur = first;
      noteBox.replaceChildren(ui.noteEl(cur.name));
      whereBig.textContent = cur.s == null ? 'anywhere' : `${STRING_NAMES[cur.s]} string`;
      fb.focusStrings(cur.s == null ? null : [cur.s]);
      fb.setEnabled(true);
      live = true;
      const t0 = performance.now();
      promptAt = t0;
      if (useMic) run.add(mic.onNote((n) => answer({ s: null, f: null, midi: n.midi, pc: n.pc }, true)));
      run.loop(() => {
        const left = RUN_SECONDS - (performance.now() - t0) / 1000;
        timeBar.set(left / RUN_SECONDS);
        scr.hud.set('time', Math.max(0, Math.ceil(left)));
        if (left <= 0) finish();
      });
    }

    showIntro();
    return () => {
      run?.dispose();
      life.dispose();
      mic.stop();
    };
  },
};

export default game;
