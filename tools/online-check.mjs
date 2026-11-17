// Headless check of the shared features, using the stand-in runtime in
// tools/mock-claude.js: two pretend players in two tabs play an online Live
// Duel to the end, then the score boards and the owner's saving of a
// view-only player's scores are checked.
//
//   node tools/online-check.mjs [outDir] [--lag ms]
//
// Needs the local server running:  node tools/serve.mjs 4747
// Prints one line per check and exits non-zero if any failed.

import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const lagAt = args.indexOf('--lag');
const lag = lagAt >= 0 ? Number(args.splice(lagAt, 2)[1]) : 0;
const out = args[0] || join(tmpdir(), 'fret-arcade-online');
const port = process.env.PORT ?? 4747;
await mkdir(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: join(tmpdir(), `fret-arcade-online-${process.pid}`),
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

let failed = 0;
const errors = [];
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(who, hash, extra = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2 });
  page.on('console', (m) => m.type() === 'error' && errors.push(`${who}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${who}: ${e.stack || e}`));
  await page.goto(`http://localhost:${port}/index.html?mock=${who}&fast${lag ? `&lag=${lag}` : ''}${extra}#${hash}`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const fire = (el, type, Ctor = PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    };
    window.tapEl = (el) => {
      if (!el) throw new Error('tap: element not found');
      fire(el, 'pointerdown');
      fire(el, 'pointerup');
      fire(el, 'click', MouseEvent);
    };
    window.tapText = (text) => window.tapEl([...document.querySelectorAll('button')].find((b) => b.textContent.trim().toLowerCase().includes(text.toLowerCase())));
    // The game module is loaded once and then read directly: polling through
    // import() every few milliseconds is slow enough to distort the timing under test.
    let duel = null;
    import('/js/games/live-duel.js').then((mod) => (duel = mod));
    window.peek = () => (duel ? duel.hooks.peek() : null);
    // Answer the prompt on screen, rightly or wrongly.
    window.answer = async (right) => {
      const p = window.peek().prompt;
      if (p.t === 'find') {
        const open = [4, 9, 2, 7, 11, 4][p.s];
        const f = (p.pc - open + 12) % 12;
        window.tapEl(document.querySelector(`.fb-hit[data-s="${p.s}"][data-f="${right ? f : (f + 1) % 12}"]`));
      } else {
        const i = p.o.indexOf(p.pc);
        window.tapEl(document.querySelectorAll('.ld-opt')[right ? i : (i + 1) % 4]);
      }
    };
    // Queue this page's answers before the match starts, so nothing depends on
    // how fast this script reacts. plan: { [round]: { host: [right, delayMs], guest: [...] } };
    // the page uses whichever role it ends up with. The delay counts from the
    // moment the prompt shows on this screen.
    window.planAnswers = (plan) => {
      const done = new Set();
      setInterval(() => {
        const s = window.peek();
        const mine = s && s.phase === 'live' && !done.has(s.round) && plan[s.round] && plan[s.round][s.role];
        if (!mine) return;
        done.add(s.round);
        setTimeout(() => window.answer(mine[0]), mine[1]);
      }, 4);
    };
  });
  return page;
}
const peek = (page) => page.evaluate(() => window.peek());
async function until(what, fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}
const bothLive = (a, b, n) => until(`round ${n} live on both`, async () => {
    const [x, y] = [await peek(a), await peek(b)];
    return x && y && x.round === n && y.round === n && x.phase === 'live' && y.phase === 'live';
  });
const bothReveal = (a, b, n) => until(`round ${n} decided on both`, async () => {
    const [x, y] = [await peek(a), await peek(b)];
    return x && y && ((x.round === n && x.phase === 'reveal') || x.round > n || x.stage === 'over') && ((y.round === n && y.phase === 'reveal') || y.round > n || y.stage === 'over') ? [x, y] : null;
  });

try {
  // start from an empty shared store
  const seed = await browser.newPage();
  await seed.goto(`http://localhost:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await seed.evaluate(() => localStorage.clear());
  await seed.close();

  // ---- two players find each other and play a match ----
  const ann = await open('ann', 'live-duel');
  const bob = await open('bob', 'live-duel');
  for (const pg of [ann, bob]) await pg.evaluate(() => window.tapText('online'));
  await sleep(300);
  await bob.screenshot({ path: join(out, '1-intro-online.png') });
  const line = await bob.evaluate(() => document.querySelector('.intro-best-value')?.textContent);
  check(/here now/.test(line || ''), 'start screen sees the other player', line);

  // The rule that decides a round, checked directly so the result does not
  // depend on how busy this machine is: judge(host, guest, elapsed, grace).
  const rule = await bob.evaluate(async () => {
    const { judge } = (await import('/js/games/live-duel.js')).hooks.model;
    const ok = (ms) => ({ ok: true, ms });
    const no = (ms) => ({ ok: false, ms });
    return {
      guestQuickerArrivesLate: judge(ok(900), ok(700), 1100, 500),
      hostQuicker: judge(ok(700), ok(900), 950, 500),
      hostHoldsItsPoint: judge(ok(700), null, 800, 500),
      hostHoldOver: judge(ok(700), null, 1201, 500),
      guestAloneRight: judge(null, ok(700), 760, 500),
      guestRightHostWrong: judge(no(300), ok(700), 760, 500),
      hostRightGuestWrong: judge(ok(700), no(300), 705, 500),
      bothWrong: judge(no(300), no(400), 450, 500),
      oneWrongOnly: judge(no(300), null, 450, 500),
      nobodyYet: judge(null, null, 450, 500),
    };
  });
  const is = (v, win, ms) => !!v && v.win === win && (ms == null || v.ms === ms);
  check(is(rule.guestQuickerArrivesLate, 1, 700), 'rule: both right, the quicker answer wins even if it arrives second');
  check(is(rule.hostQuicker, 0, 700), 'rule: both right, the host wins when it is quicker');
  check(rule.hostHoldsItsPoint && rule.hostHoldsItsPoint.wait === 400 && is(rule.hostHoldOver, 0, 700), 'rule: the host holds its own point for the grace time, then takes it');
  check(is(rule.guestAloneRight, 1, 700) && is(rule.guestRightHostWrong, 1, 700) && is(rule.hostRightGuestWrong, 0, 700), 'rule: a lone right answer takes the point');
  check(is(rule.bothWrong, null) && rule.bothWrong.why === 'both' && rule.oneWrongOnly === null && rule.nobodyYet === null, 'rule: both wrong ends the round, one wrong waits for the other');

  // Then a whole match, with each page's answers queued up front:
  // round 1: only the guest answers, right         -> guest's point
  // round 2: both wrong                            -> nobody
  // round 3: only the host answers, right          -> host's point, after its hold
  // round 4: the host is wrong and locked out, then the guest takes the round and the match
  const plan = { 1: { guest: [true, 30] }, 2: { host: [false, 30], guest: [false, 60] }, 3: { host: [true, 30] }, 4: { host: [false, 20], guest: [true, 1500] } };
  for (const pg of [ann, bob]) await pg.evaluate((pl) => window.planAnswers(pl), plan);

  await ann.evaluate(() => window.tapText('find a match'));
  await sleep(500);
  await ann.screenshot({ path: join(out, '2-lobby-waiting.png') });
  const waitingLine = await bob.evaluate(() => document.querySelector('.intro-best-value')?.textContent);
  check(/waiting for a match/.test(waitingLine || ''), 'start screen shows someone waiting', waitingLine);
  await bob.evaluate(() => window.tapText('find a match'));

  await until('both in a match', async () => (await peek(ann))?.stage === 'match' && (await peek(bob))?.stage === 'match');
  const [ra, rb] = [(await peek(ann)).role, (await peek(bob)).role];
  check(ra !== rb && [ra, rb].includes('host'), 'one side hosts, the other follows', `ann ${ra}, bob ${rb}`);
  const host = ra === 'host' ? ann : bob;
  const guest = ra === 'host' ? bob : ann;
  const hostName = ra === 'host' ? 'ann' : 'bob';
  const order = (hs, gs) => (ra === 'host' ? [hs, gs] : [gs, hs]); // [ann, bob]

  let [x, y] = await bothReveal(host, guest, 1);
  check(x.score.join() === '0,1' && y.score.join() === '1,0', "match: the guest's lone right answer takes the point", `host ${x.score}, guest ${y.score}`);
  await host.screenshot({ path: join(out, '4-round-lost.png') });
  [x, y] = await bothReveal(host, guest, 2);
  check(x.score.join() === '0,1' && y.score.join() === '1,0', 'match: both wrong, nobody scores', `host ${x.score}, guest ${y.score}`);
  [x, y] = await bothReveal(host, guest, 3);
  check(x.score.join() === '1,1' && y.score.join() === '1,1', "match: the host's lone right answer takes the point", `host ${x.score}, guest ${y.score}`);
  await bothLive(ann, bob, 4);
  await sleep(250);
  await host.screenshot({ path: join(out, '5-locked-out.png') });
  await guest.screenshot({ path: join(out, '3-round-live.png') });
  await until('match over on both', async () => (await peek(ann))?.stage === 'over' && (await peek(bob))?.stage === 'over');
  [x, y] = [await peek(host), await peek(guest)];
  check(x.result && x.result.won === false && y.result && y.result.won === true, 'both screens agree who won', `host ${x.result?.score}, guest ${y.result?.score}`);
  check(x.result?.after === 984 && y.result?.after === 1016, 'ratings move by Elo', `host ${x.result?.after}, guest ${y.result?.after}`);
  await sleep(900);
  await guest.screenshot({ path: join(out, '6-result-win.png') });
  await host.screenshot({ path: join(out, '7-result-loss.png') });
  const boardNames = await guest.evaluate(() => [...document.querySelectorAll('.results-side .board li')].map((li) => li.textContent));
  check(boardNames.some((t) => (hostName === 'ann' ? /Ann/ : /Bob/).test(t)), "the winner's board lists the other player", boardNames.join(' | '));

  // ---- the shared board has both cards ----
  const dbNow = await bob.evaluate(() => JSON.parse(localStorage.getItem('mock-claude-db') || '{}'));
  const [annPeak, bobPeak] = order(1000, 1016);
  check(dbNow['players/u_ann']?.best?.['live-duel'] === annPeak && dbNow['players/u_bob']?.best?.['live-duel'] === bobPeak, 'each player saved their own card', JSON.stringify(dbNow));

  // ---- rematch, then one side walks away ----
  await ann.evaluate(() => window.tapText('rematch'));
  await bob.evaluate(() => window.tapText('rematch'));
  await until('rematch started', async () => (await peek(ann))?.stage === 'match' && (await peek(bob))?.stage === 'match');
  await bothLive(ann, bob, 1);
  await ann.evaluate(() => (location.hash = ''));
  await until('Bob told that Ann left', async () => (await peek(bob))?.result?.left === true, 6000);
  await sleep(300);
  await bob.screenshot({ path: join(out, '8-opponent-left.png') });
  const bobRating = (await bob.evaluate(async () => (await import('/js/core/store.js')).store.get('live-duel', 'ladder'))).rating;
  check(bobRating === bobPeak || bobRating === 984, 'leaving mid-match ends it for the other side without a rating change', `bob still ${bobRating}`);

  // ---- hub and Scores screen ----
  await sleep(400);
  await ann.screenshot({ path: join(out, '9-hub-here-now.png') });
  const chip = await ann.evaluate(() => document.querySelector('.chip-here')?.textContent);
  check(/1\s*here now/.test(chip || ''), 'hub shows who is here', chip);
  await bob.evaluate(() => (location.hash = 'scores'));
  await sleep(300);
  await bob.evaluate(() => window.tapText('live duel'));
  await sleep(300);
  await bob.screenshot({ path: join(out, '10-scores.png') });
  const rows = await bob.evaluate(() => [...document.querySelectorAll('.scores-col .board li')].map((li) => li.textContent));
  check(rows.length === 2 && rows.some((t) => /You/.test(t)) && rows.some((t) => /Ann/.test(t)) && /1016/.test(rows[0]), 'Scores lists real players, best first', rows.join(' | '));
  await bob.evaluate(() => (location.hash = 'live-duel'));
  await sleep(200);
  await bob.evaluate(() => window.tapText('find a match'));
  await sleep(700);
  await ann.screenshot({ path: join(out, '11-hub-invite.png') });
  const foot = await ann.evaluate(() => document.querySelector('.foot-link')?.textContent);
  check(/Bob is waiting/.test(foot || ''), 'hub offers the waiting match', foot);
  await ann.evaluate(() => window.tapEl(document.querySelector('.foot-link')));
  await sleep(400);
  await ann.evaluate(() => window.tapText('find a match'));
  await until('joined from the hub', async () => (await peek(ann))?.stage === 'match' && (await peek(bob))?.stage === 'match');
  check(true, 'tapping the hub line leads into the match');
  await ann.close();
  await bob.close();

  // ---- a view-only player: cannot save, the owner's page saves for them ----
  const cy = await open('cy', 'fret-sprint', '&viewer');
  await cy.evaluate(async () => {
    const { store } = await import('/js/core/store.js');
    const { todayKey } = await import('/js/core/util.js');
    store.set('fret-sprint', 'today', { key: todayKey(), score: 31 });
    store.recordRun('fret-sprint', 31, { mode: 'daily' });
  });
  await sleep(900);
  let db2 = await cy.evaluate(() => JSON.parse(localStorage.getItem('mock-claude-db') || '{}'));
  check(!db2['players/u_cy'], 'a view-only player cannot write to the board');
  const dee = await open('dee', 'scores', '&owner');
  await sleep(1200);
  db2 = await cy.evaluate(() => JSON.parse(localStorage.getItem('mock-claude-db') || '{}'));
  check(db2['players/u_cy']?.day?.['fret-sprint'] === 31, "the owner's page saves it for them", JSON.stringify(db2['players/u_cy']));
  await dee.screenshot({ path: join(out, '12-scores-owner.png') });
  const seen = await dee.evaluate(() => [...document.querySelectorAll('.scores-col .board li')].map((li) => li.textContent));
  check(seen.some((t) => /Cy/.test(t) && /31/.test(t)), 'the owner sees the view-only player on the board', seen.join(' | '));
  // a results board in another game shows the real player among the CPU rows
  await dee.evaluate(() => (location.hash = 'fret-sprint'));
  await sleep(300);
  await dee.evaluate(() => window.tapText('start'));
  await until('the short daily run to end', () => dee.evaluate(() => !!document.querySelector('.results-side .board')), 20000);
  const fsBoard = await dee.evaluate(() => [...document.querySelectorAll('.results-side .board li')].map((li) => li.textContent));
  check(fsBoard.some((t) => /Cy/.test(t) && /31/.test(t)) && fsBoard.some((t) => /CPU/.test(t)), "a daily results board ranks the real player with the CPU rows", fsBoard.join(' | '));
  await sleep(300);
  await dee.screenshot({ path: join(out, '14-daily-board.png') });
  await cy.evaluate(() => (location.hash = 'scores'));
  await sleep(400);
  await cy.screenshot({ path: join(out, '13-scores-view-only.png') });
  const status = await cy.evaluate(() => document.querySelector('.scores-foot')?.textContent);
  check(/view-only/.test(status || ''), 'a view-only player is told so', status);
} catch (e) {
  failed++;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
}
if (errors.length) {
  failed++;
  console.log('CONSOLE ERRORS:\n' + errors.join('\n'));
}
console.log(failed ? `${failed} problem(s). Screenshots in ${out}` : `all checks passed. Screenshots in ${out}`);
process.exitCode = failed ? 1 : 0;
