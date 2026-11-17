// Other players: shared score boards and the live room.
//
// On the copy of the page published on claude.ai, the platform can hand the
// page three things: `user` (who is looking), `db` (a small shared store) and
// `room` (everyone who has the page open right now). Each one is optional. On
// any other host (the local copy, GitHub Pages), or when one is refused, that
// part of `net` stays off and the games fall back to their CPU boards and
// same-phone modes.
//
// What is shared is one small card per player: today's score and the best
// score in each game. It travels two ways:
//   db     players/<id>     lasting. Written by the player when their access
//                           lets them write, or by the owner's page for them.
//   room   presence.card    live. Anyone in the room can set it, so people who
//                           may not write still show up while they are here.
// A card is another person's input, so every one is cleaned before use, and
// two cards for the same player are merged by keeping the better score.
//
//   net.start({ card, lower })   once, from main.js
//   net.onChange(fn)             boards, names or the room changed
//   net.rows(gameId, kind)       other players' scores, kind 'day' | 'best'
//   net.myScore(gameId, kind)    this player's score, across their devices
//   net.status()                 what is switched on, for status lines
//   net.room                     presence helpers for live play (see below)

import { dayNumber } from './util.js';
import { store } from './store.js';

const S = {
  user: null,
  db: null,
  room: null,
  me: { id: null, isOwner: false, canPost: null },
  boards: 'off', // off | loading | late | live
  rows: new Map(), // player id -> card, from the store
  names: new Map(), // player id -> display name ('' when it cannot be shown)
  peers: [], // everyone in the room now, this page included
  myPeer: null,
  connected: false,
};

let cardSource = () => ({ day: {}, best: {} });
let isLower = () => false;
const listeners = new Set();
const peerListeners = new Set();
let changeQueued = false;
function changed() {
  if (changeQueued) return;
  changeQueued = true;
  queueMicrotask(() => {
    changeQueued = false;
    listeners.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    });
  });
}

// ---- cards ------------------------------------------------------------------
const KEY_OK = /^[a-z][a-z-]{1,23}$/;
const ID_OK = /^[A-Za-z0-9_.~:@+-]{1,200}$/;

function cleanCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { v: 1, d: Number.isInteger(raw.d) ? raw.d : 0, day: {}, best: {} };
  for (const part of ['day', 'best']) {
    const src = raw[part];
    if (!src || typeof src !== 'object') continue;
    let n = 0;
    for (const k of Object.keys(src)) {
      const v = Number(src[k]);
      if (n >= 12 || !KEY_OK.test(k) || src[k] == null || !Number.isFinite(v)) continue;
      out[part][k] = Math.max(0, Math.min(99999, Math.round(v)));
      n++;
    }
  }
  return out;
}
const isEmpty = (c) => !c || (!Object.keys(c.day).length && !Object.keys(c.best).length);
const sameCard = (a, b) => JSON.stringify(sortCard(a)) === JSON.stringify(sortCard(b));
function sortCard(c) {
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return { v: 1, d: c.d, day: sorted(c.day), best: sorted(c.best) };
}
/** Keep the better score for every game. Day scores only count for the newer day. */
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const d = Math.max(a.d, b.d);
  const out = { v: 1, d, day: {}, best: {} };
  const keep = (kind, k, v) => {
    const cur = out[kind][k];
    out[kind][k] = cur == null ? v : isLower(k, kind) ? Math.min(cur, v) : Math.max(cur, v);
  };
  for (const c of [a, b]) {
    if (c.d === d) for (const k in c.day) keep('day', k, c.day[k]);
    for (const k in c.best) keep('best', k, c.best[k]);
  }
  return out;
}
function myCard() {
  let src;
  try {
    src = cardSource();
  } catch (e) {
    src = null;
  }
  return cleanCard({ d: dayNumber(), ...(src || {}) }) || { v: 1, d: dayNumber(), day: {}, best: {} };
}

// ---- startup ----------------------------------------------------------------
let resolveReady;
const ready = new Promise((res) => (resolveReady = res));

async function init() {
  const c = typeof window !== 'undefined' ? window.claude : null;
  if (!c || typeof c.use !== 'function') return;
  const use = (name) =>
    Promise.resolve()
      .then(() => c.use(name))
      .catch(() => null);
  const user = await use('user');
  if (user) {
    S.user = user;
    try {
      const me = await user.me();
      S.me.id = me && typeof me.id === 'string' && ID_OK.test(me.id) ? me.id : null;
      S.me.isOwner = !!(me && me.isOwner);
      S.me.canPost = await user.can('data.write');
    } catch (e) {
      /* no identity: boards can still be read, the room still works */
    }
  }
  await Promise.all([use('db').then((db) => db && startBoards(db)), use('room').then((room) => room && startRoom(room))]);
  changed();
}

function startBoards(db) {
  S.db = db;
  S.boards = 'loading';
  const late = setTimeout(() => {
    if (S.boards !== 'loading') return;
    S.boards = 'late';
    changed();
  }, 10000);
  try {
    db.collection('players')
      .limit(300)
      .onSnapshot(
        (snap) => {
          const rows = new Map();
          for (const doc of snap.docs) {
            const card = ID_OK.test(doc.id) ? cleanCard(doc.data()) : null;
            if (card) rows.set(doc.id, card);
          }
          S.rows = rows;
          if (!snap.metadata || !snap.metadata.fromCache) {
            clearTimeout(late);
            S.boards = 'live';
          }
          resolveNames();
          pushCard();
          relay();
          changed();
        },
        () => {
          clearTimeout(late);
          S.db = null;
          S.boards = 'off';
          changed();
        },
      );
  } catch (e) {
    clearTimeout(late);
    S.db = null;
    S.boards = 'off';
  }
}

function startRoom(room) {
  S.room = room;
  const lost = () => {
    S.room = null;
    S.peers = [];
    S.connected = false;
    changed();
    peerListeners.forEach((fn) => fn());
  };
  try {
    room.onPeers((change) => {
      S.peers = change.peers || [];
      const mine = S.peers.find((p) => p.sameTab);
      if (mine) S.myPeer = mine.peer;
      resolveNames();
      relay();
      changed();
      peerListeners.forEach((fn) => fn());
    }, lost);
    room.onConnection(
      (ok) => {
        S.connected = !!ok;
        changed();
        peerListeners.forEach((fn) => fn());
      },
      () => {},
    );
  } catch (e) {
    lost();
    return;
  }
  pushPresence();
}

// ---- publishing this player's card --------------------------------------------
function pushPresence() {
  if (!S.room) return;
  S.room.presence({ uid: S.me.id, card: myCard() }).catch(() => {});
}

let writing = false;
let writeAgain = false;
async function pushCard() {
  // Wait for the store's own answer first: set() replaces the whole card, so
  // writing before reading could drop a better score saved from another device.
  if (!S.db || !S.me.id || S.me.canPost === false || S.boards !== 'live') return;
  const row = S.rows.get(S.me.id) || null;
  const next = merge(myCard(), row);
  if (row ? sameCard(next, row) : isEmpty(next)) return;
  if (writing) {
    writeAgain = true;
    return;
  }
  writing = true;
  try {
    await S.db.doc(`players/${S.me.id}`).set(next);
  } catch (e) {
    // Refused: this viewer's access does not let them write. Read-only for the visit.
    if (e && ['invalid_argument', 'not_granted', 'revoked'].includes(e.code)) S.me.canPost = false;
    writeAgain = false;
    changed();
  }
  writing = false;
  if (writeAgain) {
    writeAgain = false;
    pushCard();
  }
}

// The owner's page saves the cards of people who are here but may not write,
// so their scores are still on the board after they leave. Only for people
// the platform itself has identified (peer.by), never an id a page claims.
const relaying = new Set();
let relayFails = 0;
function relay() {
  if (!S.db || !S.me.isOwner || S.boards !== 'live' || relayFails >= 3) return;
  for (const p of S.peers) {
    if (p.isMe || p.kind !== 'viewer' || !p.by || !ID_OK.test(p.by) || relaying.has(p.by)) continue;
    const card = cleanCard(p.presence && p.presence.card);
    if (isEmpty(card)) continue;
    const row = S.rows.get(p.by) || null;
    const next = merge(card, row);
    if (row && sameCard(next, row)) continue;
    relaying.add(p.by);
    S.db
      .doc(`players/${p.by}`)
      .set(next)
      .catch(() => {
        relayFails++;
      })
      .then(() => relaying.delete(p.by));
  }
}

let syncTimer = 0;
/** This player's scores changed: publish the card (shortly, so a burst of saves is one update). */
function sync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    pushPresence();
    pushCard();
    changed();
  }, 350);
}

// ---- names ------------------------------------------------------------------
const idOf = (p) => (p.by && ID_OK.test(p.by) ? p.by : p.presence && typeof p.presence.uid === 'string' && ID_OK.test(p.presence.uid) ? p.presence.uid : null);

async function resolveNames() {
  if (!S.user) return;
  const ids = new Set(S.rows.keys());
  for (const p of S.peers) {
    const id = idOf(p);
    if (id) ids.add(id);
  }
  if (!ids.size) return;
  let found;
  try {
    found = await S.user.profiles([...ids]);
  } catch (e) {
    return;
  }
  let dirty = false;
  for (const id of ids) {
    const name = String((found && found[id] && found[id].name) || '').slice(0, 40);
    if (S.names.get(id) !== name) {
      S.names.set(id, name);
      dirty = true;
    }
  }
  if (dirty) {
    changed();
    peerListeners.forEach((fn) => fn());
  }
}

// ---- reading ----------------------------------------------------------------
/** Everyone known: on the stored board, in the room, or both. One entry per person. */
function players() {
  const map = new Map();
  const put = (key, id, card, here, me) => {
    const cur = map.get(key);
    if (cur) {
      cur.card = merge(cur.card, card);
      cur.here = cur.here || here;
      cur.me = cur.me || me;
    } else {
      map.set(key, { key, id, card, here, me });
    }
  };
  for (const [id, card] of S.rows) put(id, id, card, false, id === S.me.id);
  for (const p of S.peers) {
    if (p.kind !== 'viewer') continue;
    const id = idOf(p);
    const me = !!p.isMe || (!!id && id === S.me.id);
    put(id || `peer:${p.peer}`, id, cleanCard(p.presence && p.presence.card), !me, me);
  }
  return [...map.values()];
}

export const net = {
  ready,

  /**
   * card   () => ({ day: { gameId: score }, best: { gameId: score } }) from this browser's progress
   * lower  (gameId, kind) => true when a lower score is the better one
   */
  start({ card, lower } = {}) {
    if (card) cardSource = card;
    if (lower) isLower = lower;
    store.onChange(sync);
    init()
      .catch((e) => console.error(e))
      .then(resolveReady);
  },

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** What is switched on. `on` is true when other players can show up at all. */
  status() {
    const all = players();
    return {
      on: !!(S.db || S.room),
      boards: S.boards,
      room: !!S.room,
      connected: S.connected,
      canPost: S.me.canPost,
      isOwner: S.me.isOwner,
      players: all.filter((p) => !isEmpty(p.card)).length,
      here: all.filter((p) => p.here).length,
    };
  },

  /** Other players' scores for a board: [{ key, name, score, here }]. kind: 'day' | 'best'. */
  rows(gameId, kind) {
    const today = dayNumber();
    const out = [];
    for (const pl of players()) {
      const c = pl.card;
      if (pl.me || !c || (kind === 'day' && c.d !== today)) continue;
      const score = c[kind][gameId];
      if (score == null) continue;
      out.push({ key: pl.key, name: (pl.id && S.names.get(pl.id)) || 'Someone', score, here: pl.here });
    }
    return out;
  },

  /** This player's own score, counting what their other devices have saved. null if none. */
  myScore(gameId, kind) {
    let card = myCard();
    for (const pl of players()) if (pl.me) card = merge(card, pl.card);
    if (kind === 'day' && card.d !== dayNumber()) return null;
    return card[kind][gameId] ?? null;
  },

  sync,

  // ---- the room, for live play ------------------------------------------------
  // Only presence is used (never events), so anyone the room admits can take
  // part whatever their sharing level. Presence is one object per open page;
  // `net` keeps `uid` and `card` in it, and a game may keep one more field.
  room: {
    get on() {
      return !!S.room;
    },
    get connected() {
      return !!S.room && S.connected;
    },
    /** This page's label in the room, or null before the room has answered. */
    me() {
      return S.myPeer;
    },
    /** People on other pages: [{ peer, presence, isMe, ... }]. */
    others() {
      return S.peers.filter((p) => !p.sameTab && p.kind === 'viewer');
    },
    /** Merge fields into this page's presence. Never rejects. */
    set(patch) {
      if (!S.room) return Promise.resolve();
      return S.room.presence(patch).catch(() => {});
    },
    /** fn() whenever the room, a presence or a name changes. Returns an unsubscribe function. */
    onPeers(fn) {
      peerListeners.add(fn);
      return () => peerListeners.delete(fn);
    },
    /** A short name to show for a peer. */
    nameOf(p) {
      if (!p) return 'Player';
      if (p.isMe) return 'Other you';
      const id = idOf(p);
      const full = (id && S.names.get(id)) || '';
      return full.split(/\s+/)[0].slice(0, 10) || (p.guest ? 'Guest' : 'Player');
    },
  },
};
