# Fret Arcade

Seven small games for learning the guitar fretboard, built for a phone held sideways.

**Play:** https://brendansudol.github.io/fret-arcade/

| Game | What you do | What it trains |
|---|---|---|
| Fret Sprint | Find as many named notes as you can in 60 seconds | Note locations, speed |
| Fretdle | Guess a hidden four-string chord voicing in six tries | Notes per string, chord spelling |
| Interval Path | Follow "up a major 3rd" style prompts across the neck | Interval shapes |
| Lick HORSE | Copy a short lick by ear or take a letter | Ear to fretboard |
| Chord-Tone Chase | Land on a chord tone on beat one over a backing track | Playing the changes |
| Triad Drop | Build each falling chord on three strings before it lands | Triad shapes and inversions |
| Live Duel | Race an opponent to name or find a note, with a rating | Recall under pressure |

Progress, bests and the fretboard heat map are kept in the browser you play in.
Opponents and score boards on this site are computer players, always tagged CPU.

## Status

These are prototypes for trying out the game ideas. Shared score boards and
the two-device Live Duel only work on the copy of the page published on
claude.ai, because they use that platform's shared storage and live room. On
any other host those parts switch themselves off.

Real-guitar input through the microphone (Fret Sprint and Lick HORSE) needs a
secure page (https or localhost) and has not been tried with a real guitar yet.

## Run it on your computer

Plain ES modules, no framework and no build step:

```bash
node tools/serve.mjs
```

Then open http://localhost:4747. Any static file server works too.

## Working on it

`tools/GAME-GUIDE.md` explains how the shell and a game fit together, the look
and feel rules, and how to check a change. The development tools need their
packages once (`cd tools && npm install`) and a local Chrome:

```bash
node tools/shot.mjs fret-sprint out.png     # headless screenshot or scripted play
node tools/online-check.mjs                 # two pretend players, full online match
node tools/build.mjs                        # one-file bundle in dist/ for publishing
```
