// All sound is synthesised with Web Audio: a plucked-string voice
// (Karplus-Strong), chip-style UI blips, and a tiny drum/bass/keys kit for
// backing tracks. Nothing is loaded from the network.
//
// Timing: every play function takes an optional `when` in AudioContext
// seconds (audio.now() is "right now"). Omit it to play immediately.

import { midiToFreq } from './theory.js';
import { store } from './store.js';

let ctx = null;
let master = null;
let noiseBuf = null;
const pluckCache = new Map();

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC({ latencyHint: 'interactive' });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;
  master = ctx.createGain();
  master.gain.value = store.settings.sound ? 0.9 : 0;
  master.connect(comp).connect(ctx.destination);
  // 1 second of white noise, reused by the drum voices.
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

function pluckBuffer(midi) {
  const c = ensure();
  if (pluckCache.has(midi)) return pluckCache.get(midi);
  const sr = c.sampleRate;
  const freq = midiToFreq(midi);
  // Each pass reads a sample and writes back the mean of it and its neighbour,
  // so the loop's true period is N - 0.5 samples. playbackRate corrects the rest.
  const N = Math.max(2, Math.round(sr / freq + 0.5));
  const actual = sr / (N - 0.5);
  const dur = 2.6;
  const len = Math.floor(sr * dur);
  const buf = c.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const ring = new Float32Array(N);
  // Excitation: noise, softened more on low strings so they are round, not buzzy.
  let prev = 0;
  const soft = midi < 52 ? 0.42 : midi < 64 ? 0.55 : 0.7;
  for (let i = 0; i < N; i++) {
    prev = prev + soft * (Math.random() * 2 - 1 - prev);
    ring[i] = prev;
  }
  let mean = 0;
  for (let i = 0; i < N; i++) mean += ring[i];
  mean /= N;
  let peak = 0;
  for (let i = 0; i < N; i++) {
    ring[i] -= mean;
    peak = Math.max(peak, Math.abs(ring[i]));
  }
  for (let i = 0; i < N; i++) ring[i] /= peak || 1;
  // Per-loop gain chosen for a decay time that shortens up the neck.
  const t60 = 3.4 - (midi - 40) * 0.045;
  const g = Math.pow(0.001, 1 / (actual * t60));
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const a = ring[idx];
    const b = ring[idx + 1 === N ? 0 : idx + 1];
    out[i] = a;
    ring[idx] = (a + b) * 0.5 * g;
    idx = idx + 1 === N ? 0 : idx + 1;
  }
  const entry = { buf, rate: freq / actual };
  pluckCache.set(midi, entry);
  return entry;
}

function env(when, attack, peak, dur, release = 0.06) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
  g.gain.setValueAtTime(Math.max(0.0002, peak), when + Math.max(attack, dur - release));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  return g;
}

function osc(type, freq, when, dur, peak, { attack = 0.004, glideTo = null, lp = null } = {}) {
  const c = ensure();
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, when + dur);
  const g = env(when, attack, peak, dur);
  let node = o;
  if (lp) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    node = o.connect(f);
  }
  node.connect(g).connect(master);
  o.start(when);
  o.stop(when + dur + 0.02);
}

function noise(when, dur, peak, { hp = null, bp = null, lp = null } = {}) {
  const c = ensure();
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  let node = src;
  if (hp) {
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    node = node.connect(f);
  }
  if (bp) {
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = bp;
    f.Q.value = 0.8;
    node = node.connect(f);
  }
  if (lp) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    node = node.connect(f);
  }
  const g = c.createGain();
  g.gain.setValueAtTime(peak, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  node.connect(g).connect(master);
  src.start(when, Math.random() * 0.5);
  src.stop(when + dur + 0.02);
}

const SFX = {
  tap: (t) => osc('triangle', 1400, t, 0.03, 0.05),
  tick: (t) => osc('square', 1100, t, 0.03, 0.05),
  tock: (t) => osc('square', 740, t, 0.03, 0.05),
  good: (t) => {
    osc('square', 880, t, 0.07, 0.07);
    osc('square', 1320, t + 0.07, 0.11, 0.07);
  },
  great: (t) => {
    osc('square', 880, t, 0.06, 0.07);
    osc('square', 1175, t + 0.06, 0.06, 0.07);
    osc('square', 1760, t + 0.12, 0.14, 0.07);
  },
  bad: (t) => osc('sawtooth', 150, t, 0.2, 0.13, { glideTo: 85, lp: 900 }),
  count: (t) => osc('square', 660, t, 0.09, 0.07),
  go: (t) => osc('square', 990, t, 0.22, 0.08),
  level: (t) => {
    osc('triangle', 523, t, 0.08, 0.12);
    osc('triangle', 784, t + 0.08, 0.08, 0.12);
    osc('triangle', 1047, t + 0.16, 0.16, 0.12);
  },
  win: (t) => [523, 659, 784, 1047, 1319].forEach((f, i) => osc('square', f, t + i * 0.085, i === 4 ? 0.3 : 0.085, 0.07)),
  lose: (t) => [392, 330, 262, 196].forEach((f, i) => osc('triangle', f, t + i * 0.13, i === 3 ? 0.4 : 0.13, 0.13)),
  drop: (t) => osc('sine', 420, t, 0.16, 0.14, { glideTo: 130 }),
  stomp: (t) => {
    osc('sine', 150, t, 0.1, 0.25, { glideTo: 60 });
    noise(t, 0.03, 0.12, { hp: 2500 });
  },
};

export const audio = {
  /** Call from a user gesture. main.js already does this on the first tap. */
  unlock() {
    const c = ensure();
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) {
      /* optional API */
    }
    if (c.state !== 'running') c.resume().catch(() => {});
  },
  /** Current AudioContext time in seconds. */
  now() {
    return ensure().currentTime;
  },
  get ctx() {
    return ensure();
  },
  /** Raw samples of a plucked note, exposed for tests: { data, sampleRate, rate }. */
  _pluckData(midi) {
    const { buf, rate } = pluckBuffer(midi);
    return { data: buf.getChannelData(0), sampleRate: buf.sampleRate, rate };
  },
  setMuted(muted) {
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.01);
  },

  /** Plucked guitar note. dur is how long it rings before being damped. */
  pluck(midi, { when = null, gain = 0.8, dur = 2.2 } = {}) {
    const c = ensure();
    const t = when ?? c.currentTime;
    const { buf, rate } = pluckBuffer(midi);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.setValueAtTime(gain, t + Math.max(0.02, dur - 0.08));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  },
  /** Strum several notes low to high (or high to low with down: false). */
  strum(midis, { when = null, gap = 0.032, gain = 0.6, dur = 2.4, down = true } = {}) {
    const t = when ?? ensure().currentTime;
    const order = [...midis].sort((a, b) => (down ? a - b : b - a));
    order.forEach((m, i) => audio.pluck(m, { when: t + i * gap, gain, dur }));
  },
  /** Plain synth tone, for melodies that should not sound like the guitar. */
  tone(midi, { when = null, dur = 0.3, gain = 0.12, type = 'triangle' } = {}) {
    const t = when ?? ensure().currentTime;
    osc(type, midiToFreq(midi), t, dur, gain, { attack: 0.008 });
  },
  /** UI sounds: tap tick tock good great bad count go level win lose drop stomp */
  sfx(name, when = null) {
    const c = ensure();
    const fn = SFX[name];
    if (fn) fn(when ?? c.currentTime);
  },

  // ---- backing-track kit ------------------------------------------------
  kick(when, gain = 0.5) {
    osc('sine', 130, when, 0.16, gain, { glideTo: 42, attack: 0.002 });
  },
  snare(when, gain = 0.22) {
    ensure();
    noise(when, 0.13, gain, { bp: 1900 });
    osc('triangle', 190, when, 0.07, gain * 0.5, { glideTo: 140 });
  },
  hat(when, gain = 0.08, open = false) {
    ensure();
    noise(when, open ? 0.16 : 0.035, gain, { hp: 7000 });
  },
  bass(midi, when, dur = 0.4, gain = 0.3) {
    ensure();
    osc('triangle', midiToFreq(midi), when, dur, gain, { attack: 0.006, lp: 700 });
    osc('sine', midiToFreq(midi), when, dur, gain * 0.6, { attack: 0.006 });
  },
  /** Soft electric-piano style chord stab. */
  keys(midis, when, dur = 0.5, gain = 0.06) {
    ensure();
    for (const m of midis) {
      osc('sine', midiToFreq(m), when, dur, gain, { attack: 0.006 });
      osc('triangle', midiToFreq(m) * 2, when, dur * 0.5, gain * 0.25, { attack: 0.004 });
    }
  },
  click(when, accent = false) {
    ensure();
    osc('square', accent ? 1500 : 1000, when, 0.025, accent ? 0.09 : 0.06);
  },

  /**
   * Steady beat clock for backing tracks and rhythm judging.
   *   const clock = audio.clock({ bpm: 90, onBeat(i, t) { audio.kick(t) } })
   *   clock.start(0.6)        first beat lands 0.6 s from now
   *   clock.beatAt(audio.now()) fractional beat position right now
   *   clock.timeOf(8)         AudioContext time of beat 8
   *   clock.stop()
   * onBeat is called slightly ahead of time with the exact time `t` to
   * schedule sounds at; do not use it for visuals that must be in sync,
   * derive those from beatAt() in an animation loop.
   */
  clock({ bpm = 90, onBeat }) {
    const c = ensure();
    const spb = 60 / bpm;
    let t0 = 0;
    let next = 0;
    let timer = null;
    const pump = () => {
      while (t0 + next * spb < c.currentTime + 0.14) {
        onBeat?.(next, t0 + next * spb);
        next++;
      }
    };
    return {
      spb,
      get running() {
        return timer != null;
      },
      start(delay = 0.3) {
        t0 = c.currentTime + delay;
        next = 0;
        pump();
        timer = setInterval(pump, 25);
      },
      stop() {
        clearInterval(timer);
        timer = null;
      },
      beatAt: (time) => (time - t0) / spb,
      timeOf: (beat) => t0 + beat * spb,
    };
  },
};

store.onChange(() => audio.setMuted(!store.settings.sound));
