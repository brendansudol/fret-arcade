// Live Duel on two devices. Both players have the shared page open, and the
// room (core/net.js) carries the match. Only presence is used, never events,
// so anyone the room admits can play whatever their sharing level.
//
// One side hosts. The host's presence IS the match: round number, phase,
// prompt and score. Each side adds its own answer for the round, timed on
// its own device from the moment the prompt showed there, and the host gives
// the point to the faster right answer. Presence is whole state, not a
// stream of moves, so a missed update is repaired by the next one.
//
//   presence.duel
//     { st: 'open', r }                          waiting for a match (r = rating)
//     { st: 'match', role: 'host', m, vs, r,     m = match id, vs = the other page's label
//       ph, n, t, p, sc, win, why, ms, a }       ph: invite | lead | ready | live | reveal | over
//     { st: 'match', role: 'guest', m, vs, r, a }
//   a = { n, ok, ms }: this side's answer to round n.
//   sc = [host, guest]; win = 0 | 1 | null is the same index.
//
// Finding a match: everyone waiting is 'open'. The page with the lowest label
// invites the next one; the invited page answers by taking the guest role.
// A page that is waiting on a lower label which never invites gives it a
// moment, then invites it instead, and if two invite each other the lower
// label hosts.

import { clamp, TEST } from '../core/util.js';
import { pcAt, midiAt, pcName, positionsOfPc, isNatural, STRING_NAMES } from '../core/theory.js';
import { audio } from '../core/audio.js';
import { store } from '../core/store.js';
import { net } from '../core/net.js';
import { createFretboard } from '../core/fretboard.js';
import { resultsBoard } from '../core/boards.js';
import * as ui from '../core/ui.js';

const { h } = ui;
const GRACE = TEST.fast ? 150 : 500; // how long the host holds its own point for a faster answer still on its way
const LEFT_MS = TEST.fast ? 1500 : 5000; // an opponent missing this long has left
const INVITE_MS = TEST.fast ? 1500 : 5000; // how long an invitation stands
const YIELD_MS = TEST.fast ? 500 : 3500; // how long to wait for a lower label to invite first
const STALL_MS = TEST.fast ? 9000 : 25000; // a host silent this long has stopped (a round never runs longer)

const duelOf = (p) => (p && p.presence && p.presence.duel && typeof p.presence.duel === 'object' ? p.presence.duel : {});
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const ratingOf = (v) => (Number.isFinite(v) ? clamp(Math.round(v), 100, 3000) : 1000);
const byPeer = (a, b) => (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0);
const newId = () => Math.random().toString(36).slice(2, 10) || 'match';

/**
 * Who takes the round: the fairness rule, on its own so it can be checked directly.
 *   mine, theirs   the host's and the guest's answer, { ok, ms }, or null while unanswered
 *   elapsed        ms since the prompt showed on the host's screen
 *   grace          how long the host holds its own point for an answer still on its way
 * Returns { win, why, ms } once the round is decided (win: 0 host, 1 guest, null nobody),
 * { wait } to look again after that many ms, or null when there is nothing to decide yet.
 */
export function judge(mine, theirs, elapsed, grace) {
  if (mine && mine.ok && theirs && theirs.ok) return theirs.ms < mine.ms ? { win: 1, why: '', ms: theirs.ms } : { win: 0, why: '', ms: mine.ms };
  if (theirs && theirs.ok) {
    // The guest is right. The host can still take it only by beating that time.
    if (mine || elapsed >= theirs.ms) return { win: 1, why: '', ms: theirs.ms };
    return { wait: theirs.ms - elapsed };
  }
  if (mine && mine.ok) {
    // The host is right. A faster answer from the guest may still be on its way.
    if (theirs || elapsed >= mine.ms + grace) return { win: 0, why: '', ms: mine.ms };
    return { wait: mine.ms + grace - elapsed };
  }
  if (mine && theirs) return { win: null, why: 'both', ms: 0 };
  return null;
}

/**
 * Run the online mode inside the game's screen until `run` is disposed.
 * ctx: { ID, scr, cfg, run, hooks, WIN_AT, T, again(), showIntro(), getLadder(),
 *        eloNext(), distractors(), rnd(), pick(), shuffle(), cpuRows(rating) }
 */
export function playOnline(ctx) {
  const { ID, scr, cfg, run, hooks, WIN_AT, T } = ctx;
  const room = net.room;
  const lad = ctx.getLadder();
  const myRating = lad.rating;

  let stage = 'lobby'; // lobby -> match -> over
  let role = null;
  let m = null; // match id
  let oppPeer = null;
  let oppRating = 1000;
  let result = null;

  // match state; sc and win are indexed [host, guest]
  let n = 0;
  let type = 'find';
  let ph = 'lead'; // the host's phase
  let localPh = 'none'; // what this screen is showing: none | ready | live | reveal
  let p = null; // the prompt
  let lastPc = -1;
  let sc = [0, 0];
  let win = null;
  let why = '';
  let winMs = 0;
  let myAns = null;
  let oppAns = null;
  let myCell = null;
  let liveAt = 0;
  let judgeTimer = 0;
  let limitTimer = 0;
  let lastSeen = performance.now();
  const stats = { wins: [], wrong: 0 };
  const mi = () => (role === 'guest' ? 1 : 0);

  hooks.peek = () => ({
    mode: 'online',
    stage,
    role,
    round: n,
    phase: localPh,
    winAt: WIN_AT,
    score: [sc[mi()], sc[1 - mi()]],
    prompt: p && { ...p },
    answered: !!myAns,
    answers: { mine: myAns && { ...myAns }, theirs: oppAns && { ...oppAns } },
    win: win == null ? null : win === mi() ? 'me' : 'them',
    opponent: oppPeer && { name: B ? B.name : '', rating: oppRating },
    result,
  });

  run.add(() => room.set({ duel: null }));
  run.add(room.onPeers(tick));
  run.interval(tick, 250);
  function tick() {
    if (stage === 'lobby') scan();
    else if (stage === 'match') follow();
  }

  // ---- finding a match ---------------------------------------------------------
  const skip = new Map(); // peer -> time until which not to invite them again
  let proposal = null; // { to, m, until }
  let yieldTo = null;
  let yieldSince = 0;
  let lobby = null;

  function scan() {
    renderLobby();
    const me = room.me();
    if (!me || !room.connected) return;
    const now = performance.now();
    const others = room.others();
    const invites = others
      .filter((x) => {
        const d = duelOf(x);
        return d.st === 'match' && d.role === 'host' && d.ph === 'invite' && d.vs === me && typeof d.m === 'string';
      })
      .sort(byPeer);

    if (proposal) {
      const target = others.find((x) => x.peer === proposal.to);
      const d = duelOf(target);
      if (target && d.st === 'match' && d.role === 'guest' && d.m === proposal.m) return begin('host', target, proposal.m);
      const cross = invites.find((x) => x.peer === proposal.to); // we invited each other
      if (cross && me > cross.peer) return begin('guest', cross, duelOf(cross).m);
      if (!target || (d.st !== 'open' && !cross) || now > proposal.until) {
        skip.set(proposal.to, now + INVITE_MS);
        proposal = null;
        room.set({ duel: { st: 'open', r: myRating } });
      }
      return;
    }
    if (invites.length) return begin('guest', invites[0], duelOf(invites[0]).m);

    const open = others.filter((x) => duelOf(x).st === 'open' && !(skip.get(x.peer) > now)).sort(byPeer);
    if (!open.length) {
      yieldTo = null;
      return;
    }
    const first = open[0];
    if (me > first.peer) {
      if (yieldTo !== first.peer) {
        yieldTo = first.peer;
        yieldSince = now;
      }
      if (now - yieldSince < YIELD_MS) return;
    }
    proposal = { to: first.peer, m: newId(), until: now + INVITE_MS };
    room.set({ duel: { st: 'match', role: 'host', m: proposal.m, vs: first.peer, ph: 'invite', r: myRating } });
    renderLobby();
  }

  function buildLobby() {
    const small = h('small');
    const big = h('b');
    const dots = h('span', { class: 'ld-think' }, h('i'), h('i'), h('i'));
    const display = h('div', { class: 'display ld-display is-lead' }, h('span', { class: 'ld-glyph dot' }, 'VS'), h('span', { class: 'ld-where' }, small, h('span', { class: 'ld-finding' }, big, dots)));
    const list = h('div', { class: 'ld-here' });
    const el = h(
      'div',
      { class: 'ld-lobby' },
      display,
      list,
      h('p', { class: 'ld-lobby-hint' }, 'The other player opens this same page, signed in, and chooses Online in Live Duel.'),
      ui.button('Cancel', { onClick: ctx.showIntro }),
    );
    scr.hud.setStats([]);
    scr.body.replaceChildren(el);
    return { small, big, list, sig: null };
  }
  function renderLobby() {
    const others = room.others();
    lobby.small.textContent = room.connected ? 'online' : 'connecting';
    lobby.big.textContent = proposal ? 'Player found' : 'Finding a player';
    const rows = others.slice(0, 5).map((x) => {
      const d = duelOf(x);
      return [room.nameOf(x), d.st === 'open' ? 'waiting' : d.st === 'match' ? 'in a match' : ''];
    });
    const sig = JSON.stringify([rows, others.length]);
    if (sig === lobby.sig) return;
    lobby.sig = sig;
    lobby.list.replaceChildren(
      h('span', { class: 'stat-label' }, others.length ? 'Here now' : 'Nobody else has the page open right now'),
      ...rows.map(([name, st]) => h('span', { class: 'ld-who' }, name, st ? h('small', null, st) : null)),
      ...(others.length > 5 ? [h('span', { class: 'ld-who' }, `+${others.length - 5}`)] : []),
    );
  }

  // ---- the match screen --------------------------------------------------------
  let A = null; // this player
  let B = null; // the opponent
  let fb = null;
  let play = null;
  let display = null;
  let glyph = null;
  let small = null;
  let big = null;
  const btns = [];

  const replay = (el, cls) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };
  function show(state, g, s, b) {
    display.className = `display ld-display is-${state}`;
    glyph.hidden = g == null;
    glyph.replaceChildren(g == null ? '' : ui.noteEl(g));
    small.textContent = s;
    big.textContent = b;
  }
  function setStatus(side, text = '', kind = '') {
    side.status.className = `ld-status${kind && kind !== 'think' ? ` is-${kind}` : ''}`;
    side.status.replaceChildren(text, kind === 'think' ? h('span', { class: 'ld-think' }, h('i'), h('i'), h('i')) : '');
  }
  function paintScore() {
    [A, B].forEach((side, k) => {
      const v = sc[k === 0 ? mi() : 1 - mi()];
      [...side.pips.children].forEach((pip, i) => {
        const fresh = i < v && !pip.classList.contains('is-on');
        pip.className = `ld-pip${i < v ? ' is-on' : ''}${fresh ? ' is-new' : ''}${i === v && v === WIN_AT - 1 && localPh !== 'reveal' ? ' is-next' : ''}`;
      });
    });
  }

  function buildMatch(opp) {
    const side = (name, rating) => {
      const s = { name, pips: h('span', { class: 'ld-pips' }, Array.from({ length: WIN_AT }, () => h('i', { class: 'ld-pip' }))), status: h('span', { class: 'ld-status' }), nameEl: h('span', null, name) };
      s.plate = h('span', { class: 'ld-plate' }, s.nameEl, h('span', { class: 'ld-rating' }, String(rating)));
      return s;
    };
    A = side('You', myRating);
    B = side(room.nameOf(opp), oppRating);
    const sideEl = (s, cls) => h('div', { class: `ld-side ${cls}` }, s.plate, s.pips, s.status);
    const card = h('div', { class: 'ld-card' }, sideEl(A, 'is-a'), h('span', { class: 'ld-vs' }, 'vs'), sideEl(B, 'is-b'));

    glyph = h('span', { class: 'ld-glyph dot' });
    small = h('small');
    big = h('b');
    display = h('div', { class: 'display ld-display' }, glyph, h('span', { class: 'ld-where' }, small, big));

    const optBtn = (i) => {
      const inner = h('span', { class: 'ld-opt-in' });
      const btn = h('button', { class: 'ld-opt is-blank', type: 'button', 'aria-label': 'Answer' }, h('span', { class: 'ld-opt-rot' }, inner));
      run.on(btn, 'pointerdown', (ev) => {
        if (ev.button > 0) return;
        ev.preventDefault();
        press(i);
      });
      btns[i] = { btn, inner };
      return btn;
    };
    play = h('div', { class: 'ld-play is-ranked' }, card, h('div', { class: 'ld-mid' }, h('div', { class: 'ld-opts' }, optBtn(0), optBtn(1)), display, h('div', { class: 'ld-opts' }, optBtn(2), optBtn(3))));
    fb = createFretboard(play, { onTap: tapNeck });
    // Generous taps, as in a ranked match: only one string is live in a
    // "find it" round, so a thumb one row off still counts on that string.
    let snapping = false;
    run.on(
      fb.el,
      'pointerdown',
      (ev) => {
        const t = ev.target;
        if (snapping || localPh !== 'live' || !p || p.t !== 'find' || myAns || !t.dataset || t.dataset.s == null) return;
        if (Math.abs(+t.dataset.s - p.s) !== 1) return;
        const hit = fb.el.querySelector(`.fb-hit[data-s="${p.s}"][data-f="${t.dataset.f}"]`);
        if (!hit) return;
        ev.stopPropagation();
        ev.preventDefault();
        snapping = true;
        hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: ev.pointerId, pointerType: ev.pointerType, clientX: ev.clientX, clientY: ev.clientY }));
        snapping = false;
      },
      true,
    );
    fb.setEnabled(false);
    scr.hud.setStats([{ key: 'round', label: 'Round', value: 1 }]);
    scr.body.replaceChildren(play);
    show('lead', 'VS', 'online match', `First to ${WIN_AT}`);
  }

  function begin(r, opp, id) {
    stage = 'match';
    role = r;
    m = id;
    oppPeer = opp.peer;
    oppRating = ratingOf(duelOf(opp).r);
    proposal = null;
    lastSeen = performance.now();
    publish();
    buildMatch(opp);
    audio.sfx('level');
    if (role === 'host') run.timeout(hostNext, T.lead + (TEST.fast ? 150 : 500));
  }

  function publish() {
    if (role === 'host') {
      room.set({ duel: { st: 'match', role: 'host', m, vs: oppPeer, r: myRating, ph, n, t: type, p: ph === 'live' || ph === 'reveal' ? p : null, sc, win, why, ms: winMs, a: myAns } });
    } else {
      room.set({ duel: { st: 'match', role: 'guest', m, vs: oppPeer, r: myRating, a: myAns } });
    }
  }

  // ---- what both screens show ----------------------------------------------------
  function showReady() {
    localPh = 'ready';
    myCell = null;
    scr.hud.set('round', n);
    fb.clearMarks();
    fb.focusStrings(null);
    fb.setEnabled(false);
    play.classList.toggle('is-name', type === 'name');
    paintScore();
    setStatus(A, sc[mi()] === WIN_AT - 1 ? 'Match point' : '');
    setStatus(B);
    for (const o of btns) {
      o.btn.className = 'ld-opt is-blank';
      o.inner.replaceChildren();
    }
    show('ready', 'READY', 'next up', type === 'find' ? 'Find it' : 'Name it');
    audio.sfx('count');
  }

  function showLive() {
    localPh = 'live';
    if (p.t === 'find') {
      show('live', pcName(p.pc, p.pref), 'find it on the', `${STRING_NAMES[p.s]} string`);
      fb.focusStrings([p.s]);
      fb.setEnabled(true);
    } else {
      show('live', '?', 'name it', 'Which note?');
      fb.mark(p.s, p.f, { kind: 'accent', pulse: true });
      btns.forEach((o, i) => {
        const name = pcName(p.o[i], p.pref);
        o.btn.className = 'ld-opt is-pop';
        o.btn.setAttribute('aria-label', name);
        o.inner.replaceChildren(ui.noteEl(name));
      });
      audio.pluck(midiAt(p.s, p.f), { gain: 0.5, dur: 1.4 });
    }
    replay(display, 'is-hit');
    audio.click(audio.now(), true);
    audio.hat(audio.now(), 0.1);
    liveAt = performance.now();
    setStatus(B, 'Thinking', 'think');
  }

  function showReveal() {
    localPh = 'reveal';
    fb.setEnabled(false);
    const iWon = win === mi();
    const theyWon = win === 1 - mi();
    const name = pcName(p.pc, p.pref);
    paintScore();
    const wrong = (ans) => !!ans && !ans.ok;
    setStatus(A, iWon ? 'Point' : wrong(myAns) ? 'Locked out' : '', iWon ? 'good' : wrong(myAns) ? 'bad' : '');
    setStatus(B, theyWon ? 'Point' : wrong(oppAns) ? 'Wrong' : '', !theyWon && wrong(oppAns) ? 'bad' : '');
    if (win != null) replay((iWon ? A : B).plate, 'is-bump');

    if (p.t === 'find') {
      for (const t of positionsOfPc(p.pc, { strings: [p.s] })) {
        const mine = !!myCell && t.f === myCell.f;
        fb.mark(t.s, t.f, { kind: win == null ? 'warn' : iWon ? (mine ? 'good' : 'ghost') : 'ink', label: name });
      }
      if (iWon && myCell) fb.flash(myCell.s, myCell.f, 'good', { label: name });
    } else {
      fb.mark(p.s, p.f, { kind: iWon ? 'good' : theyWon ? 'ink' : 'warn', label: name });
      btns.forEach((o, i) => {
        o.btn.classList.remove('is-pop');
        if (p.o[i] === p.pc) {
          o.btn.classList.remove('is-dim');
          o.btn.classList.add(iWon ? 'is-right' : 'is-answer');
        } else if (!o.btn.classList.contains('is-wrong')) {
          o.btn.classList.add('is-dim');
        }
      });
    }

    if (win != null) show(iWon ? 'won' : 'lost', name, `point · ${(winMs / 1000).toFixed(2)} s`, iWon ? 'You' : B.name);
    else show('none', name, 'no point', why === 'time' ? 'Time' : why === 'both' ? 'Both wrong' : 'Nobody');
    replay(display, iWon ? 'is-hit' : 'is-told');

    if (iWon) {
      stats.wins.push(winMs);
      audio.sfx('good');
    } else if (theyWon) {
      const t = audio.now(); // a neutral two-pip blip: not a reward, not a buzzer
      audio.tone(67, { when: t, dur: 0.08, gain: 0.1 });
      audio.tone(67, { when: t + 0.11, dur: 0.12, gain: 0.1 });
    } else {
      audio.sfx('tock');
    }
  }

  // ---- answering -----------------------------------------------------------------
  function answer(ok, ms) {
    myAns = { n, ok, ms: Math.round(ms) };
    fb.setEnabled(false);
    if (ok) {
      setStatus(A, 'Got it', 'good');
      audio.sfx('tick');
    } else {
      stats.wrong++;
      setStatus(A, 'Locked out', 'bad');
      display.classList.add('is-out');
      small.textContent = 'locked out';
      audio.sfx('bad');
    }
    publish();
    if (role === 'host') hostJudge();
  }

  function tapNeck({ s, f, pc }) {
    if (localPh !== 'live' || !p || p.t !== 'find' || myAns) return;
    const ms = performance.now() - liveAt;
    const ok = pc === p.pc && s === p.s;
    if (ok) {
      store.recordNote(s, f, true, ms);
      myCell = { s, f };
      fb.mark(s, f, { kind: 'good', label: pcName(p.pc, p.pref) });
    } else {
      const t = positionsOfPc(p.pc, { strings: [p.s] })[0];
      store.recordNote(t.s, t.f, false, ms);
      fb.mark(s, f, { kind: 'bad', label: pcName(pc, p.pref) });
    }
    answer(ok, ms);
  }

  function press(i) {
    if (localPh !== 'live' || !p || p.t !== 'name' || myAns) return;
    const ms = performance.now() - liveAt;
    const ok = p.o[i] === p.pc;
    store.recordNote(p.s, p.f, ok, ms);
    btns.forEach((o, j) => o.btn.classList.add(j !== i ? 'is-dim' : ok ? 'is-right' : 'is-wrong'));
    answer(ok, ms);
  }

  // ---- the host runs the rounds ----------------------------------------------------
  function makePrompt() {
    const naturals = cfg.notes === 'natural';
    const pref = ctx.rnd() < 0.5 ? 'flat' : 'sharp';
    const [lo, hi] = type === 'find' ? [0, 11] : [1, 12];
    const cells = [];
    for (let s = 0; s < 6; s++) {
      for (let f = lo; f <= hi; f++) {
        const pc = pcAt(s, f);
        if ((!naturals || isNatural(pc)) && pc !== lastPc) cells.push({ s, f });
      }
    }
    const c = ctx.pick(cells);
    const pc = pcAt(c.s, c.f);
    lastPc = pc;
    if (type === 'find') return { t: 'find', s: c.s, pc, pref };
    return { t: 'name', s: c.s, f: c.f, pc, pref, o: ctx.shuffle([pc, ...ctx.distractors(pc, naturals)]) };
  }

  function hostNext() {
    n++;
    type = n === 1 ? hooks.firstType || (ctx.rnd() < 0.5 ? 'find' : 'name') : type === 'find' ? 'name' : 'find';
    p = makePrompt();
    myAns = oppAns = null;
    win = null;
    why = '';
    winMs = 0;
    ph = 'ready';
    publish();
    showReady();
    run.timeout(hostLive, T.pauseMin + ctx.rnd() * (T.pauseMax - T.pauseMin));
  }

  function hostLive() {
    ph = 'live';
    publish();
    showLive();
    limitTimer = run.timeout(() => hostReveal(null, 'time', 0), T.limit + GRACE);
  }

  /** Decide the round as soon as it can be decided fairly (see judge above). */
  function hostJudge() {
    if (ph !== 'live') return;
    clearTimeout(judgeTimer);
    const verdict = judge(myAns, oppAns, performance.now() - liveAt, GRACE);
    if (!verdict) return;
    if ('wait' in verdict) judgeTimer = run.timeout(hostJudge, verdict.wait + 5);
    else hostReveal(verdict.win, verdict.why, verdict.ms);
  }

  function hostReveal(winner, reason, ms) {
    if (ph !== 'live') return;
    clearTimeout(judgeTimer);
    clearTimeout(limitTimer);
    ph = 'reveal';
    win = winner;
    why = reason;
    winMs = Math.round(ms);
    if (winner != null) sc = sc.map((v, i) => (i === winner ? v + 1 : v));
    publish();
    showReveal();
    run.timeout(() => {
      if (Math.max(sc[0], sc[1]) < WIN_AT) return hostNext();
      ph = 'over';
      publish();
      finish();
    }, T.hold);
  }

  // ---- the guest follows the host ----------------------------------------------------
  function cleanPrompt(x) {
    if (!x || typeof x !== 'object') return null;
    const s = int(x.s, 0, 5);
    const pc = int(x.pc, 0, 11);
    const pref = x.pref === 'flat' ? 'flat' : 'sharp';
    if (s == null || pc == null) return null;
    if (x.t === 'find') return { t: 'find', s, pc, pref };
    const f = int(x.f, 1, 12);
    const o = Array.isArray(x.o) && x.o.length === 4 && x.o.every((v) => int(v, 0, 11) != null) && new Set(x.o).size === 4 && x.o.includes(pc) ? x.o.slice() : null;
    if (x.t !== 'name' || f == null || !o || pcAt(s, f) !== pc) return null;
    return { t: 'name', s, f, pc, pref, o };
  }
  const cleanScore = (x) => (Array.isArray(x) && x.length === 2 ? x.map((v) => int(v, 0, WIN_AT) ?? 0) : sc);

  function guestApply(d) {
    const hn = int(d.n, 0, 999);
    if (hn == null || hn < n) return;
    if (hn > n) {
      n = hn;
      myAns = oppAns = null;
      p = null;
      localPh = 'none';
    }
    if (n === 0) return; // the host is still in its lead-in
    if (d.t === 'find' || d.t === 'name') type = d.t;
    if (d.ph === 'ready' && localPh === 'none') {
      showReady();
    } else if (d.ph === 'live' && (localPh === 'none' || localPh === 'ready')) {
      const q = cleanPrompt(d.p);
      if (!q) return;
      p = q;
      type = q.t;
      if (localPh === 'none') showReady(); // the "ready" update was missed
      showLive();
    } else if ((d.ph === 'reveal' || d.ph === 'over') && localPh !== 'reveal') {
      p = p || cleanPrompt(d.p);
      sc = cleanScore(d.sc);
      win = d.win === 0 || d.win === 1 ? d.win : null;
      why = typeof d.why === 'string' ? d.why : '';
      winMs = Number.isFinite(d.ms) ? clamp(Math.round(d.ms), 0, 60000) : 0;
      if (p && d.ph === 'reveal') {
        if (localPh === 'none') showReady();
        showReveal();
      }
    }
    if (d.ph === 'over') {
      sc = cleanScore(d.sc);
      finish();
    }
  }

  /** Every tick during a match: is the other side still there, and what has it said? */
  function follow() {
    const opp = room.others().find((x) => x.peer === oppPeer);
    const d = duelOf(opp);
    const there = !!opp && d.st === 'match' && d.m === m;
    const now = performance.now();
    if (there && room.connected) lastSeen = now;
    else if (now - lastSeen > LEFT_MS) return gone();
    if (!there) return;
    // The host changes its presence at every step of a round, so a long silence
    // means its page has stopped (in the background, or asleep).
    if (role === 'guest' && n > 0 && Date.now() - opp.updatedAt > STALL_MS) return gone();
    const name = room.nameOf(opp);
    if (name !== B.name) {
      B.name = name;
      B.nameEl.textContent = name;
    }
    const a = d.a;
    if (!oppAns && a && typeof a === 'object' && a.n === n && typeof a.ok === 'boolean' && Number.isFinite(a.ms)) {
      oppAns = { n, ok: a.ok, ms: clamp(Math.round(a.ms), 0, 60000) };
      if (localPh === 'live') setStatus(B, oppAns.ok ? 'Answered' : 'Wrong', oppAns.ok ? '' : 'bad');
      if (role === 'host') hostJudge();
    }
    if (role === 'guest') guestApply(d);
  }

  // ---- endings -------------------------------------------------------------------
  function gone() {
    if (stage !== 'match') return;
    if (n === 0) return ctx.again(); // it never got going: back to looking
    stage = 'over';
    clearTimeout(judgeTimer);
    clearTimeout(limitTimer);
    room.set({ duel: null });
    audio.sfx('tock');
    result = { left: true, score: `${sc[mi()]}-${sc[1 - mi()]}` };
    ui.results(scr, {
      title: room.connected ? `${B.name} left` : 'Connection lost',
      big: result.score,
      unit: 'match not counted',
      rows: [
        ['Rounds played', Math.max(0, n - (localPh === 'reveal' ? 0 : 1))],
        ['Rating', myRating],
      ],
      actions: [
        { label: 'Find a match', kind: 'primary', onClick: ctx.again },
        { label: 'Options', onClick: ctx.showIntro },
      ],
    });
  }

  function finish() {
    if (stage !== 'match') return;
    stage = 'over';
    clearTimeout(judgeTimer);
    clearTimeout(limitTimer);
    const me = mi();
    const won = sc[me] > sc[1 - me];
    const before = myRating;
    const after = ctx.eloNext(before, oppRating, won);
    const peak = Math.max(lad.peak, after);
    const rec = { w: 0, l: 0, ...store.get(ID, 'online', {}) };
    if (won) rec.w++;
    else rec.l++;
    store.set(ID, 'online', rec);
    store.set(ID, 'ladder', { rating: after, wins: lad.wins, losses: lad.losses, last: lad.last, peak });
    store.recordRun(ID, after, { mode: 'online' });
    audio.sfx(won ? 'win' : 'lose');
    const score = `${sc[me]}-${sc[1 - me]}`;
    result = { won, score, before, after, opponent: oppRating, wins: rec.w, losses: rec.l };

    const up = after >= before;
    const elo = h(
      'span',
      { class: 'ld-elo' },
      'Rating',
      h('span', { class: 'ld-elo-line' }, h('span', null, String(before)), h('i', null, '→'), h('b', { class: 'is-done' }, String(after)), h('em', { class: `is-in ${up ? 'is-up' : 'is-down'}` }, `${up ? '+' : '-'}${Math.abs(after - before)}`)),
    );
    const avg = stats.wins.length ? `${(stats.wins.reduce((t, v) => t + v, 0) / stats.wins.length / 1000).toFixed(2)} s` : '-';
    const res = ui.results(scr, {
      title: h('span', null, won ? 'You win' : 'You lose', h('span', { class: 'ld-res-vs' }, `vs ${B.name}`)),
      big: score,
      unit: elo,
      badge: won && after > lad.peak && lad.wins + lad.losses + rec.w + rec.l > 1 ? 'New peak' : null,
      rows: [
        ['Avg winning time', avg],
        ['Online record', `${rec.w} W · ${rec.l} L`],
        ['Fastest win', stats.wins.length ? `${(Math.min(...stats.wins) / 1000).toFixed(2)} s` : '-'],
        ['Wrong answers', stats.wrong],
      ],
      board: resultsBoard({ gameId: ID, kind: 'best', you: peak, cpu: ctx.cpuRows(after) }),
      boardTitle: 'Peak rating',
      actions: [
        { label: 'Rematch', kind: 'primary', onClick: ctx.again },
        { label: 'Options', onClick: ctx.showIntro },
      ],
    });
    const unitEl = res.el.querySelector('.results-unit');
    if (unitEl) unitEl.style.alignSelf = 'center';
    run.add(() => res.close());
  }

  // ---- go ----
  lobby = buildLobby();
  room.set({ duel: { st: 'open', r: myRating } });
  scan();
}
