// M1.1: five fingers. Paint all five nails, moving between them every way a player can (tap a
// nail in hand view, arrows, swipe on background, mini-map), and check paint survives each nail
// being copied down to its small targets and back up. Memory ≤ 100 MB, no switch over 50 ms.
// Needs `npm run serve`. Part of `npm run robot`.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const f2 = (v) => v.toFixed(2);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}?scene=hand&flip=0`);
await page.evaluate(() => window.__salon.ready);

const r = await page.evaluate(async () => {
  const S = window.__salon, out = { switches: [], visits: [] }, cv = document.getElementById('gl');
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const settle = async () => { while (S.direction().turning || S.info().view === undefined) await S.nextFrame(); for (let i = 0; i < 45; i++) await S.nextFrame(); };
  const tap = (el, x, y, type = 'mouse') => {
    for (const t of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(t, { pointerId: 7, pointerType: type, clientX: x, clientY: y, buttons: t === 'pointerdown' ? 1 : 0, bubbles: true }));
  };
  const paint = async () => {
    const L = S.info().length;
    for (const x of [-0.36, -0.12, 0.12, 0.36]) await S.stroke([[x, 0.03], [x, L - 0.02]], { speed: 1.0 });
    await S.advance(20);
    return (await S.statsAll())[S.info().finger];
  };
  await S.clear();
  out.order = S.order();

  // Hand view: a stroke does nothing.
  out.handStroke = (await S.stroke([[0, 0.2], [0, 0.8]])).stamps;

  // Tap each nail in hand view, paint it, go back to the hand with the mini-map's palm.
  for (const id of [0, 1, 2, 3, 4]) {
    const [x, y] = S.nailOnScreen(id);
    tap(cv, x, y); await settle();
    const info = S.info();
    out.switches.push(S.switchMs());
    S.dip(); await S.stroke([[0, 0.3], [0, 0.6]], { dip: false });
    const loadAfterStroke = S.info().load;
    const st = await paint();
    out.visits.push({ id, arrived: info.finger, view: info.view, coverage: st.coverage, spill: st.spill, loadAfterStroke });
    const palm = document.querySelector('#map [data-hand]').getBoundingClientRect();
    tap(document.querySelector('#map [data-hand] rect'), palm.x + 8, palm.y + 8); await settle();
    out.visits[out.visits.length - 1].backToHand = S.info().view === 'hand';
  }
  out.bytes = S.paintBytes();

  // All five, after every one has been copied down and the others up again.
  out.all = (await S.statsAll()).map((s) => s.coverage);

  // Arrows go along the screen order; changing nails re-dips.
  await S.goTo('nail', out.order[0]); await settle();
  const seen = [S.info().finger];
  for (let i = 0; i < 4; i++) {
    await S.stroke([[0, 0.3], [0, 0.9]], { dip: false });          // use up some polish
    out.loadBefore = S.info().load;
    document.getElementById('next').dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
    document.getElementById('next').click(); await settle();
    seen.push(S.info().finger); out.loadAfter = S.info().load;
    out.switches.push(S.switchMs());
  }
  out.arrowOrder = seen;
  out.nextAtEnd = await S.step(1);                                   // no nail past the last

  // A swipe on empty background moves one nail; a swipe that starts on the nail paints and stays.
  // Real background: the first spot across the middle that has no finger under it. Let a
  // moment pass after the Pencil, as a hand reaching for a swipe would.
  const R = cv.getBoundingClientRect(), bgY = R.top + R.height * 0.5;
  let bgX = R.left + 20; while (bgX < R.right && !S.offHand(bgX, bgY)) bgX += 20;
  out.bgX = bgX;
  // (The robot's strokes run on their own clock; one real Pencil hover puts "last pen seen" on
  // the real one, as on the iPad.)
  cv.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, pointerType: 'pen', clientX: bgX, clientY: bgY, buttons: 0, bubbles: true }));
  await wait(900);
  const drag = async (x0, y0, x1, type = 'touch') => {
    const ev = (t, x, b) => cv.dispatchEvent(new PointerEvent(t, { pointerId: 9, pointerType: type, clientX: x, clientY: y0, width: 10, height: 10, buttons: b, bubbles: true }));
    ev('pointerdown', x0, 1); for (let k = 1; k <= 8; k++) { await wait(20); ev('pointermove', x0 + (x1 - x0) * k / 8, 1); } ev('pointerup', x1, 0);
    await settle();
  };
  const before = S.info().finger;
  await drag(bgX, bgY, bgX + 260);                                   // swipe right: the nail to the left
  out.swipe = { before, after: S.info().finger };
  const [nx, ny] = S.project(0, 0.6), st0 = S.stampCount(), f0 = S.info().finger;
  await drag(nx - 120, ny, nx + 120, 'pen');
  out.swipeOnNail = { stamps: S.stampCount() - st0, stayed: S.info().finger === f0 };

  // Mini-map nail tap.
  const dot = document.querySelector(`#map [data-finger="${out.order[2]}"] path`).getBoundingClientRect();
  tap(document.querySelector(`#map [data-finger="${out.order[2]}"] path`), dot.x + dot.width / 2, dot.y + dot.height / 2); await settle();
  out.mapTap = S.info().finger === out.order[2];

  // Visiting without painting leaves a nail exactly as it was (no copy down, so no softening).
  const c0 = (await S.statsAll()).map((s) => s.coverage);
  for (const id of [0, 4, 0, 4, 2]) { await S.goTo('nail', id); await settle(); }
  out.revisit = [c0, (await S.statsAll()).map((s) => s.coverage)];

  // Turned, the order flips (the thumb is on the right with fingertips up).
  await S.turn(); out.orderUp = S.order();
  return out;
});
await browser.close();

check('the screen order runs thumb first with fingertips down', r.order[0] === 0 && r.order[4] === 4, `order ${r.order.join(' ')}`);
check('a stroke in hand view paints nothing', r.handStroke === 0, `stamps ${r.handStroke}`);
for (const v of r.visits) check(`tap nail ${v.id} in hand view, paint it, palm back to hand`, v.arrived === v.id && v.view === 'nail' && v.coverage >= 0.9 && v.spill < 0.02 && v.backToHand, `arrived ${v.arrived} ${v.view}, coverage ${f2(v.coverage)} spill ${v.spill.toFixed(3)} back ${v.backToHand}`);
check('all five nails keep their paint after the round trips', r.all.every((c) => c >= 0.9), `coverage ${r.all.map(f2).join(' ')}`);
check('paint memory within 100 MB', r.bytes <= 100 * 1048576, `${(r.bytes / 1048576).toFixed(1)} MB`);
check('no nail switch over 50 ms', Math.max(...r.switches) <= 50, `max ${Math.max(...r.switches).toFixed(1)} ms`);
check('the next arrow walks the screen order, and stops at the end', r.arrowOrder.join() === r.order.join() && !r.nextAtEnd, `visited ${r.arrowOrder.join(' ')}`);
check('changing nails re-dips the brush', r.loadBefore < 1 && r.loadAfter === 1, `load ${f2(r.loadBefore)} → ${f2(r.loadAfter)}`);
const idx = r.order.indexOf(r.swipe.before);
check('a swipe on background moves one nail', r.swipe.after === r.order[idx - 1], `${r.swipe.before} → ${r.swipe.after} (from x ${Math.round(r.bgX)})`);
check('a swipe that starts on the nail paints and stays put', r.swipeOnNail.stamps > 0 && r.swipeOnNail.stayed, `stamps ${r.swipeOnNail.stamps}, stayed ${r.swipeOnNail.stayed}`);
check('tapping a nail on the mini-map goes there', r.mapTap, `${r.mapTap}`);
check('visiting without painting changes nothing', r.revisit[0].every((c, i) => Math.abs(c - r.revisit[1][i]) < 0.003), `${r.revisit[0].map(f2).join(' ')} → ${r.revisit[1].map(f2).join(' ')}`);
check('fingertips up puts the thumb on the right', r.orderUp[4] === 0, `order ${r.orderUp.join(' ')}`);
process.exit(failed ? 1 : 0);
