// Headless check: load a page of the app at phone-landscape size, optionally
// run a script in it, save a screenshot, and print any console errors.
//
//   node tools/shot.mjs <hash> <out.png> [--js "<code>"] [--js-file file.js]
//                       [--wait ms] [--dark] [--portrait] [--size WxH] [--keep]
//
//   <hash>   game id (fret-sprint, fretdle, ...), "progress", or "" for the hub
//   --js     async code run in the page after load; its return value is printed.
//            Helpers available in that code:
//              tap(selector)            click the first match (real pointer + click events)
//              tapText(text)            click the first button containing the text
//              cell(s, f)               tap fretboard cell (string 0-5, fret 0-12)
//              sleep(ms)
//   --wait   extra ms to wait before the screenshot (default 300)
//   --keep   keep localStorage from the previous run (default: start clean)
//   --page   page to load instead of index.html (e.g. dist/preview.html)
//   --fast   load with ?fast so games shorten their long timers (see TEST.fast in util.js)
//
// Needs the local server running:  node tools/serve.mjs 4747

import puppeteer from 'puppeteer-core';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const bool = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
let js = flag('--js');
const jsFile = flag('--js-file');
const wait = Number(flag('--wait') ?? 300);
const size = flag('--size');
const port = flag('--port') ?? process.env.PORT ?? 4747;
const dark = bool('--dark');
const portrait = bool('--portrait');
const keep = bool('--keep');
const fast = bool('--fast');
const pagePath = flag('--page') ?? 'index.html';
const [hash = '', out = 'shot.png'] = args;
if (jsFile) js = await readFile(jsFile, 'utf8');

let [w, h] = size ? size.split('x').map(Number) : portrait ? [390, 760] : [844, 390];
const profile = join(tmpdir(), `fret-arcade-shot-${keep ? 'keep-' + hash : process.pid}`);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: profile,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  if (dark) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  await page.goto(`http://localhost:${port}/${pagePath}${fast ? '?fast' : ''}${hash ? '#' + hash : ''}`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const fire = (el, type, Ctor = PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    };
    window.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.tapEl = (el) => {
      if (!el) throw new Error('tap: element not found');
      fire(el, 'pointerdown');
      fire(el, 'pointerup');
      fire(el, 'click', MouseEvent);
    };
    window.tap = (sel) => window.tapEl(document.querySelector(sel));
    window.tapText = (text) => window.tapEl([...document.querySelectorAll('button')].find((b) => b.textContent.trim().toLowerCase().includes(text.toLowerCase())));
    window.cell = (s, f, root = document) => window.tapEl(root.querySelector(`.fb-hit[data-s="${s}"][data-f="${f}"]`));
  });
  if (js) {
    const result = await page.evaluate(`(async () => { ${js} })()`);
    if (result !== undefined) console.log('result:', typeof result === 'string' ? result : JSON.stringify(result));
  }
  await new Promise((r) => setTimeout(r, wait));
  await mkdir(dirname(out) || '.', { recursive: true }).catch(() => {});
  await page.screenshot({ path: out });
  console.log(`saved ${out} (${w}x${h}${dark ? ', dark' : ''})`);
} finally {
  await browser.close();
}
if (errors.length) {
  console.log('CONSOLE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('no console errors');
}
