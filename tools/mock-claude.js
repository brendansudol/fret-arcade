// Stand-in for the page runtime that claude.ai gives a published page, so the
// shared boards and two-device play can be tried on the local copy. It only
// switches on when the address has ?mock=<name>:
//
//   http://localhost:4747/?mock=ann            signed in as "Ann", may post scores
//   http://localhost:4747/?mock=bob&viewer     view-only: cannot write, can join the room
//   http://localhost:4747/?mock=cy&owner       the page's owner
//   ...&lag=150                                delay everything from the room by 150 ms
//   ...&nodb  or  &noroom                      that part is refused
//
// Open two tabs with different names and they see each other. State is shared
// between tabs of this one browser (BroadcastChannel and localStorage);
// nothing leaves the machine. Each name also keeps its own local progress.
// This file is not part of the published build.
(() => {
  const q = new URLSearchParams(location.search);
  if (!q.has('mock')) return;
  const who = (q.get('mock') || 'you').toLowerCase().replace(/[^a-z0-9]/g, '') || 'you';
  const isOwner = q.has('owner');
  const viewer = q.has('viewer');
  const lag = Math.max(0, Number(q.get('lag')) || 0);
  const myId = `u_${who}`;
  const nameOf = (id) => (typeof id === 'string' && id.startsWith('u_') ? id.charAt(2).toUpperCase() + id.slice(3) : '');
  const later = (fn, ms = 20) => setTimeout(fn, ms);
  const freeze = (o) => Object.freeze(o);

  // ---- user ----
  const profile = (id) => ({ id, name: nameOf(id), avatarUrl: 'data:,', color: '#888', email: null, isMe: id === myId, guest: false });
  const user = freeze({
    isOwner: async () => isOwner,
    canEdit: async () => isOwner,
    can: async (what) => (what === 'data.write' ? !viewer : false),
    me: async () => ({ ...profile(myId), isOwner, canEdit: isOwner }),
    id: async () => myId,
    name: async () => nameOf(myId),
    profiles: async (ids) => Object.fromEntries((Array.isArray(ids) ? ids : [ids]).map((id) => [id, profile(id)])),
    search: async () => [],
  });

  // ---- db: documents in localStorage, changes announced to other tabs ----
  const DB_KEY = 'mock-claude-db';
  const readAll = () => {
    try {
      return JSON.parse(localStorage.getItem(DB_KEY) || '{}');
    } catch (e) {
      return {};
    }
  };
  const dbChan = new BroadcastChannel('mock-claude-db');
  const dbSubs = new Set();
  const fire = () => dbSubs.forEach((fn) => fn());
  dbChan.onmessage = () => later(fire, lag);
  const snapDoc = (path, all) => {
    const body = all[path];
    return freeze({ id: path.split('/').pop(), exists: body !== undefined, data: () => body, metadata: { fromCache: false, hasPendingWrites: false } });
  };
  const mayWrite = (path) => {
    const seg = path.split('/');
    if (seg[0] !== 'players' || seg.length !== 2) return isOwner;
    return isOwner || (!viewer && seg[1] === myId);
  };
  const write = (path, fn) =>
    new Promise((res, rej) =>
      later(() => {
        if (!mayWrite(path)) return rej({ code: 'invalid_argument', message: 'mock: this viewer may not write here' });
        const all = readAll();
        fn(all);
        localStorage.setItem(DB_KEY, JSON.stringify(all));
        dbChan.postMessage(1);
        fire();
        res();
      }),
    );
  const docRef = (path) => {
    if (path.split('/').length % 2) throw new TypeError(`mock: "${path}" is not a document path`);
    return {
      id: path.split('/').pop(),
      path,
      get: async () => snapDoc(path, readAll()),
      set: (data) => write(path, (all) => (all[path] = JSON.parse(JSON.stringify(data)))),
      update: (data) => write(path, (all) => (all[path] = { ...(all[path] || {}), ...JSON.parse(JSON.stringify(data)) })),
      delete: () => write(path, (all) => delete all[path]),
      onSnapshot(next) {
        const run = () => next(snapDoc(path, readAll()));
        dbSubs.add(run);
        later(run);
        return () => dbSubs.delete(run);
      },
      collection: (sub) => colRef(`${path}/${sub}`),
    };
  };
  const colRef = (path, max = 1000) => {
    if (!(path.split('/').length % 2)) throw new TypeError(`mock: "${path}" is not a collection path`);
    const depth = path.split('/').length + 1;
    const read = () => {
      const all = readAll();
      const docs = Object.keys(all)
        .filter((p) => p.startsWith(`${path}/`) && p.split('/').length === depth)
        .sort()
        .slice(0, max)
        .map((p) => snapDoc(p, all));
      return freeze({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } });
    };
    const ref = {
      path,
      doc: (id = Math.random().toString(36).slice(2, 12)) => docRef(`${path}/${id}`),
      add: async (data) => {
        const d = ref.doc();
        await d.set(data);
        return d;
      },
      where: () => ref,
      orderBy: () => ref,
      limit: (n) => colRef(path, n),
      get: async () => read(),
      onSnapshot(next) {
        const run = () => next(read());
        dbSubs.add(run);
        later(run);
        return () => dbSubs.delete(run);
      },
    };
    return ref;
  };
  const db = freeze({ doc: docRef, collection: (p) => colRef(p) });

  // ---- room: presence between tabs ----
  const myPeer = Array.from({ length: 16 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');
  const roomChan = new BroadcastChannel('mock-claude-room');
  let myPresence = freeze({});
  const others = new Map(); // peer -> { peer, by, presence, updatedAt, seen }
  let snapshot = freeze([]);
  const peerSubs = new Set();
  let pending = null; // { joined, left, updated } waiting for the next delivery
  const asPeer = (o) => freeze({ peer: o.peer, by: o.by, isMe: o.by === myId, sameTab: o.peer === myPeer, kind: 'viewer', guest: false, presence: o.presence, updatedAt: o.updatedAt });
  let mine = asPeer({ peer: myPeer, by: myId, presence: myPresence, updatedAt: Date.now() });
  const rebuild = () => {
    snapshot = freeze([mine, ...[...others.values()].map((o) => o.view)].sort((a, b) => (a.peer < b.peer ? -1 : 1)));
  };
  const note = (kind, peer) => {
    if (!pending) {
      pending = { joined: new Map(), left: new Map(), updated: new Map() };
      later(() => {
        const chg = pending;
        pending = null;
        rebuild();
        const out = freeze({ peers: snapshot, joined: freeze([...chg.joined.values()]), left: freeze([...chg.left.values()]), updated: freeze([...chg.updated.values()]) });
        peerSubs.forEach((fn) => fn(out));
      }, 16);
    }
    pending[kind].set(peer.peer, peer);
  };
  const say = (type) => roomChan.postMessage({ type, peer: myPeer, by: myId, presence: myPresence });
  const hear = (msg) => {
    if (!msg || msg.peer === myPeer) return;
    if (msg.type === 'bye') {
      const gone = others.get(msg.peer);
      if (gone) {
        others.delete(msg.peer);
        note('left', gone.view);
      }
      return;
    }
    if (msg.type === 'hello') say('state');
    const cur = others.get(msg.peer);
    const same = cur && JSON.stringify(cur.presence) === JSON.stringify(msg.presence);
    const rec = { peer: msg.peer, by: msg.by, presence: same ? cur.presence : freeze(msg.presence || {}), updatedAt: same ? cur.updatedAt : Date.now(), seen: Date.now() };
    rec.view = same ? cur.view : asPeer(rec);
    others.set(msg.peer, rec);
    if (!cur) note('joined', rec.view);
    else if (!same) note('updated', rec.view);
  };
  roomChan.onmessage = (ev) => (lag ? later(() => hear(ev.data), lag) : hear(ev.data));
  setInterval(() => {
    say('state');
    for (const [peer, o] of others) {
      if (Date.now() - o.seen < 3500) continue;
      others.delete(peer);
      note('left', o.view);
    }
  }, 1000);
  addEventListener('pagehide', () => say('bye'));
  say('hello');
  rebuild();

  const room = freeze({
    emit: async () => {},
    on: () => () => {},
    presence: async (patch) => {
      const next = { ...myPresence };
      for (const k in patch) {
        if (patch[k] === null) delete next[k];
        else next[k] = JSON.parse(JSON.stringify(patch[k]));
      }
      if (new TextEncoder().encode(JSON.stringify(next)).length > 4096) throw { code: 'invalid_argument', message: 'mock: presence is over 4 KiB' };
      myPresence = freeze(next);
      mine = asPeer({ peer: myPeer, by: myId, presence: myPresence, updatedAt: Date.now() });
      note('updated', mine);
      say('state');
    },
    peers: () => snapshot,
    onPeers(fn) {
      peerSubs.add(fn);
      later(() => peerSubs.has(fn) && fn(freeze({ peers: snapshot, joined: snapshot, left: freeze([]), updated: freeze([]) })));
      return () => peerSubs.delete(fn);
    },
    join: async () => {
      throw { code: 'not_permitted', message: 'mock: no named rooms' };
    },
    connected: () => true,
    onConnection(fn) {
      later(() => fn(true));
      return () => {};
    },
  });

  const served = { user, db: q.has('nodb') ? null : db, room: q.has('noroom') ? null : room };
  window.claude = freeze({ use: (name) => new Promise((res) => later(() => res(served[name] ?? null), 30)) });
})();
