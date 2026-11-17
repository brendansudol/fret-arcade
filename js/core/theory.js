// Music theory helpers for a standard-tuned guitar.
//
// Conventions used everywhere in this project:
//   string index s: 0 = low E (6th string) ... 5 = high E (1st string)
//   fret f:         0 = open string ... 12
//   midi:           E2 = 40 (open low E), middle C = 60
//   pc:             pitch class 0..11, C = 0

import { mod } from './util.js';

export const TUNING = [40, 45, 50, 55, 59, 64];
export const STRING_LETTERS = ['E', 'A', 'D', 'G', 'B', 'E'];
export const STRING_NAMES = ['low E', 'A', 'D', 'G', 'B', 'high E'];
export const MAX_FRET = 12;

export const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
export const NATURAL_PCS = [0, 2, 4, 5, 7, 9, 11];

export const mod12 = (n) => mod(n, 12);
export const isNatural = (pc) => NATURAL_PCS.includes(mod12(pc));
export const midiAt = (s, f) => TUNING[s] + f;
export const pcAt = (s, f) => mod12(TUNING[s] + f);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Name of a pitch class. pref: 'sharp' | 'flat'. */
export function pcName(pc, pref = 'sharp') {
  return (pref === 'flat' ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)];
}

/** Both spellings when a note has two, e.g. "C♯/D♭". */
export function pcNameBoth(pc) {
  const a = SHARP_NAMES[mod12(pc)];
  const b = FLAT_NAMES[mod12(pc)];
  return a === b ? a : `${a}/${b}`;
}

/** e.g. midiName(40) -> "E2" */
export function midiName(midi, pref = 'sharp') {
  return pcName(midi, pref) + (Math.floor(midi / 12) - 1);
}

/** Every {s, f} on the neck with this pitch class. */
export function positionsOfPc(pc, { minFret = 0, maxFret = MAX_FRET, strings = [0, 1, 2, 3, 4, 5] } = {}) {
  const out = [];
  for (const s of strings) {
    for (let f = minFret; f <= maxFret; f++) {
      if (pcAt(s, f) === mod12(pc)) out.push({ s, f });
    }
  }
  return out;
}

/** Every {s, f} on the neck with this exact pitch. */
export function positionsOfMidi(midi, { minFret = 0, maxFret = MAX_FRET, strings = [0, 1, 2, 3, 4, 5] } = {}) {
  const out = [];
  for (const s of strings) {
    const f = midi - TUNING[s];
    if (f >= minFret && f <= maxFret) out.push({ s, f });
  }
  return out;
}

export const INTERVALS = [
  { semis: 0, short: 'P1', name: 'unison' },
  { semis: 1, short: 'm2', name: 'minor 2nd' },
  { semis: 2, short: 'M2', name: 'major 2nd' },
  { semis: 3, short: 'm3', name: 'minor 3rd' },
  { semis: 4, short: 'M3', name: 'major 3rd' },
  { semis: 5, short: 'P4', name: 'perfect 4th' },
  { semis: 6, short: 'TT', name: 'tritone' },
  { semis: 7, short: 'P5', name: 'perfect 5th' },
  { semis: 8, short: 'm6', name: 'minor 6th' },
  { semis: 9, short: 'M6', name: 'major 6th' },
  { semis: 10, short: 'm7', name: 'minor 7th' },
  { semis: 11, short: 'M7', name: 'major 7th' },
  { semis: 12, short: 'P8', name: 'octave' },
];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  majPent: [0, 2, 4, 7, 9],
  minPent: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

// tones: semitones above the root. steps: scale-degree numbers used for spelling.
// degrees: how each tone is labelled relative to the root.
export const CHORD_TYPES = {
  maj: { label: 'major', symbol: '', tones: [0, 4, 7], steps: [1, 3, 5], degrees: ['R', '3', '5'] },
  min: { label: 'minor', symbol: 'm', tones: [0, 3, 7], steps: [1, 3, 5], degrees: ['R', '♭3', '5'] },
  dim: { label: 'diminished', symbol: '°', tones: [0, 3, 6], steps: [1, 3, 5], degrees: ['R', '♭3', '♭5'] },
  aug: { label: 'augmented', symbol: '+', tones: [0, 4, 8], steps: [1, 3, 5], degrees: ['R', '3', '♯5'] },
  sus4: { label: 'suspended 4th', symbol: 'sus4', tones: [0, 5, 7], steps: [1, 4, 5], degrees: ['R', '4', '5'] },
  7: { label: 'dominant 7th', symbol: '7', tones: [0, 4, 7, 10], steps: [1, 3, 5, 7], degrees: ['R', '3', '5', '♭7'] },
  maj7: { label: 'major 7th', symbol: 'maj7', tones: [0, 4, 7, 11], steps: [1, 3, 5, 7], degrees: ['R', '3', '5', '7'] },
  m7: { label: 'minor 7th', symbol: 'm7', tones: [0, 3, 7, 10], steps: [1, 3, 5, 7], degrees: ['R', '♭3', '5', '♭7'] },
  m7b5: { label: 'half-diminished', symbol: 'm7♭5', tones: [0, 3, 6, 10], steps: [1, 3, 5, 7], degrees: ['R', '♭3', '♭5', '♭7'] },
  6: { label: 'major 6th', symbol: '6', tones: [0, 4, 7, 9], steps: [1, 3, 5, 6], degrees: ['R', '3', '5', '6'] },
  m6: { label: 'minor 6th', symbol: 'm6', tones: [0, 3, 7, 9], steps: [1, 3, 5, 6], degrees: ['R', '♭3', '5', '6'] },
};

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MINORISH = new Set(['min', 'dim', 'm7', 'm7b5', 'm6']);
// The root spellings players actually meet: Db/Eb/Ab/Bb majors, C#/F#/G# minors.
const MAJOR_ROOTS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_ROOTS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

/** Usual spelling of a chord root, e.g. rootName(1, 'min') -> "C♯". */
export function rootName(pc, type = 'maj') {
  return (MINORISH.has(type) ? MINOR_ROOTS : MAJOR_ROOTS)[mod12(pc)];
}

function spell(rootStr, semis, step) {
  const letterIdx = LETTERS.indexOf(rootStr[0]);
  const rootPc = LETTER_PC[rootStr[0]] + (rootStr[1] === '♯' ? 1 : rootStr[1] === '♭' ? -1 : 0);
  const letter = LETTERS[(letterIdx + step - 1) % 7];
  const targetPc = mod12(rootPc + semis);
  let diff = mod12(targetPc - LETTER_PC[letter]);
  if (diff > 6) diff -= 12;
  if (diff === 0) return letter;
  if (diff === 1) return letter + '♯';
  if (diff === -1) return letter + '♭';
  return null; // would need a double accidental
}

/**
 * chord(rootPc, type) -> {
 *   root, type, name ("C♯m7"), label ("minor 7th"), pcs: [1,4,8,11],
 *   notes: ["C♯","E","G♯","B"], degrees: ["R","♭3","5","♭7"],
 *   degreeOf(pc) -> "♭3" | null, nameOf(pc) -> "E" (spelled for this chord)
 * }
 */
export function chord(rootPc, type = 'maj') {
  const t = CHORD_TYPES[type];
  if (!t) throw new Error(`unknown chord type ${type}`);
  const root = mod12(rootPc);
  const rName = rootName(root, type);
  const pcs = t.tones.map((x) => mod12(root + x));
  const flatPref = rName.includes('♭') || (MINORISH.has(type) && !rName.includes('♯')) || type === '7';
  const notes = t.tones.map((semis, i) => spell(rName, semis, t.steps[i]) || pcName(root + semis, flatPref ? 'flat' : 'sharp'));
  return {
    root,
    type,
    name: rName + t.symbol,
    label: t.label,
    pcs,
    notes,
    degrees: t.degrees.slice(),
    degreeOf: (pc) => {
      const i = pcs.indexOf(mod12(pc));
      return i < 0 ? null : t.degrees[i];
    },
    nameOf: (pc) => {
      const i = pcs.indexOf(mod12(pc));
      return i < 0 ? pcName(pc, flatPref ? 'flat' : 'sharp') : notes[i];
    },
  };
}

/** Sharp or flat spelling that suits a key, for labelling scale tones. */
export function prefForKey(rootPc, minor = false) {
  const flatMajors = [5, 10, 3, 8, 1]; // F Bb Eb Ab Db
  const flatMinors = [2, 7, 0, 5, 10, 3]; // Dm Gm Cm Fm Bbm Ebm
  return (minor ? flatMinors : flatMajors).includes(mod12(rootPc)) ? 'flat' : 'sharp';
}

/** Interval record for a semitone distance (0..12). */
export const intervalOf = (semis) => INTERVALS[Math.abs(semis) > 12 ? mod12(semis) : Math.abs(semis)];
