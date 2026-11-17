// Optional "play your real guitar" input. Listens on the microphone and
// reports each newly plucked note. It is a bonus on top of tapping: the mic
// is refused in some places (embedded viewers, no permission), so callers
// must treat a failed start() as "tap only".

let stream = null;
let ctx = null;
let analyser = null;
let timer = null;
let buf = null;
const noteListeners = new Set();
const levelListeners = new Set();

// McLeod-style normalised square difference pitch detector.
function detect(data, sampleRate) {
  const n = data.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += data[i] * data[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.012) return { rms, freq: 0, clarity: 0 };
  const maxLag = Math.min(Math.floor(sampleRate / 70), n >> 1); // down to ~70 Hz
  const minLag = Math.floor(sampleRate / 1400);
  const nsdf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acf = 0;
    let div = 0;
    for (let i = 0; i < n - lag; i++) {
      acf += data[i] * data[i + lag];
      div += data[i] * data[i] + data[i + lag] * data[i + lag];
    }
    nsdf[lag] = div ? (2 * acf) / div : 0;
  }
  // First peak after the initial fall that reaches near the global maximum.
  let globalMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) globalMax = Math.max(globalMax, nsdf[lag]);
  if (globalMax < 0.8) return { rms, freq: 0, clarity: globalMax };
  const thresh = globalMax * 0.9;
  let lag = minLag;
  while (lag < maxLag && nsdf[lag] > 0) lag++; // skip the lobe around zero lag
  let best = -1;
  for (; lag < maxLag; lag++) {
    if (nsdf[lag] > thresh && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
      best = lag;
      break;
    }
  }
  if (best < 0) return { rms, freq: 0, clarity: globalMax };
  const a = nsdf[best - 1];
  const b = nsdf[best];
  const c = nsdf[best + 1];
  const shift = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return { rms, freq: sampleRate / (best + shift), clarity: b };
}

let lastMidi = null;
let stable = 0;
let emitted = null;
let prevRms = 0;

function tick() {
  analyser.getFloatTimeDomainData(buf);
  const { rms, freq } = detect(buf, ctx.sampleRate);
  levelListeners.forEach((fn) => fn(rms));
  // A sharp jump in level means a fresh pluck, even of the same note.
  if (rms > prevRms * 1.8 && rms > 0.03) emitted = null;
  prevRms = rms * 0.6 + prevRms * 0.4;
  if (!freq) {
    stable = 0;
    lastMidi = null;
    if (rms < 0.012) emitted = null;
    return;
  }
  const exact = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.round(exact);
  if (midi < 38 || midi > 88) return;
  if (midi === lastMidi) stable++;
  else {
    lastMidi = midi;
    stable = 1;
  }
  if (stable >= 2 && emitted !== midi) {
    emitted = midi;
    const cents = Math.round((exact - midi) * 100);
    noteListeners.forEach((fn) => fn({ midi, pc: ((midi % 12) + 12) % 12, cents, freq }));
  }
}

let blocked = false;

function policyAllows() {
  try {
    const fp = document.featurePolicy || document.permissionsPolicy;
    if (fp && typeof fp.allowsFeature === 'function') return fp.allowsFeature('microphone');
  } catch (e) {
    /* unknown: assume allowed */
  }
  return true;
}

export const mic = {
  /** True if a microphone could work here: the API exists, the page is allowed to use it, and it has not already been refused. */
  get supported() {
    return !blocked && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && policyAllows();
  },
  /** Pitch detector on a raw Float32Array, exposed for tests. */
  _detect: detect,
  get active() {
    return !!stream;
  },
  /** Ask for the mic and start listening. Resolves true on success, false if refused. */
  async start() {
    if (stream) return true;
    if (!mic.supported) return false;
    try {
      // Give up after 30 s so a permission prompt that never answers cannot stall a game.
      const pending = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      let timedOut = false;
      const got = await Promise.race([
        pending,
        new Promise((res) => setTimeout(() => { timedOut = true; res(null); }, 30000)),
      ]);
      if (!got) {
        if (timedOut) pending.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => {});
        return false;
      }
      stream = got;
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      buf = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      timer = setInterval(tick, 28);
      return true;
    } catch (e) {
      stream = null;
      blocked = true;
      return false;
    }
  },
  stop() {
    clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (ctx) ctx.close().catch(() => {});
    ctx = null;
    lastMidi = emitted = null;
    stable = 0;
  },
  /** fn({ midi, pc, cents, freq }) once per detected pluck. Returns an unsubscribe function. */
  onNote(fn) {
    noteListeners.add(fn);
    return () => noteListeners.delete(fn);
  },
  /** fn(rms) about 35 times a second while active, for a level meter. */
  onLevel(fn) {
    levelListeners.add(fn);
    return () => levelListeners.delete(fn);
  },
};
