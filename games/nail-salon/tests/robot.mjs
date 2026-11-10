// Robot painter (PLAN §16): scripted strokes with known geometry and speed through
// window.__salon, then assertions on the stats. Needs `npm run serve` (port 8813).
import { webkit } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text()); });
await page.goto(`${BASE}?scene=nail&debug`);
await page.evaluate(() => window.__salon.ready);

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const shot = (name) => page.screenshot({ path: new URL(`./shots/robot-${name}.png`, import.meta.url).pathname });
const run = (fn, arg) => page.evaluate(fn, arg);
const f = (n) => n.toFixed(3);

// M0.4a: three slow side-by-side strokes cover the nail and spill nothing.
let r = await run(async () => {
  const S = window.__salon, L = S.info().length;
  await S.clear();
  for (const x of [-0.3, 0, 0.3]) await S.stroke([[x, 0.08], [x, L - 0.04]], { speed: 1.0 });
  return S.stats();
});
check('three slow strokes cover the nail', r.coverage >= 0.9 && r.spill === 0, `coverage ${f(r.coverage)} spill ${f(r.spill)} even ${f(r.evenness)}`);
check('colour and finish match the request', r.colorMatch > 0.95 && r.finishMatch > 0.9, `colour ${f(r.colorMatch)} finish ${f(r.finishMatch)}`);
await shot('three-strokes');

// M0.4b: film from one slow pass, one fast pass, two fast passes (centre line).
r = await run(async () => {
  const S = window.__salon, L = S.info().length, line = [[0, 0.1], [0, L - 0.05]], out = {};
  await S.clear(); await S.stroke(line, { speed: 1.0 }); await S.stats(); out.slow = S.filmAt(0, 0.5);
  await S.clear(); await S.stroke(line, { speed: 8 }); await S.stats(); out.fast = S.filmAt(0, 0.5);
  await S.stroke(line, { speed: 8 }); await S.stats(); out.fast2 = S.filmAt(0, 0.5);
  return out;
});
check('slow pass film ≥ 0.80', r.slow >= 0.8, f(r.slow));
check('fast pass film 0.45–0.65', r.fast >= 0.45 && r.fast <= 0.65, f(r.fast));
check('second fast pass film ≥ 0.78', r.fast2 >= 0.78, f(r.fast2));
await shot('fast-twice');

// M0.4c: the fold wall. A stroke along the inside of the wall spills nothing; a stroke on
// the skin is a spill and shows.
r = await run(async () => {
  const S = window.__salon, out = {};
  await S.clear(); await S.stroke([[0.42, 0.3], [0.42, 0.7]], { speed: 1.0 }); out.wall = await S.stats();
  await S.clear(); await S.stroke([[0.72, 0.1], [0.72, 0.7]], { speed: 1.0 }); out.skin = await S.stats();
  return out;
});
check('stroke against the wall does not spill', r.wall.spill === 0 && r.wall.coverage > 0.05, `spill ${f(r.wall.spill)} coverage ${f(r.wall.coverage)}`);
check('stroke on the skin is a spill', r.skin.spill > 0.02 && r.skin.coverage < 0.02, `spill ${f(r.skin.spill)} coverage ${f(r.skin.coverage)}`);
await shot('spill');

// A stroke that starts just outside the outline is snapped inside (forgiving start).
r = await run(async () => {
  const S = window.__salon;
  await S.clear(); await S.stroke([[0, -0.05], [0, 0.6]], { speed: 1.0 });
  return S.stats();
});
check('forgiving start: no spill from 0.05 outside', r.spill === 0, `spill ${f(r.spill)}`);

// A stroke that runs off the free edge into the air is not a spill.
r = await run(async () => {
  const S = window.__salon, L = S.info().length;
  await S.clear(); await S.stroke([[0, 0.3], [0, L + 0.5]], { speed: 1.0 });
  return S.stats();
});
check('running off the tip is not a spill', r.spill === 0, `spill ${f(r.spill)}`);

// M0.5: a painted rectangle of known size reads back as its share of the outline.
r = await run(async () => {
  const S = window.__salon, rad = 0.04;
  await S.clear(); S.setBrush(rad);
  const x0 = -0.2, x1 = 0.2, y0 = 0.35, y1 = 0.65;
  for (let pass = 0; pass < 3; pass++) for (let x = x0; x <= x1 + 1e-6; x += rad * 0.5) await S.stroke([[x, y0], [x, y1]], { speed: 0.8 });
  S.setBrush();
  const st = await S.stats();
  return { st, area: S.area(), rect: (x1 - x0) * (y1 - y0), grown: (x1 - x0 + rad) * (y1 - y0 + rad * 1.35) };
});
const share = r.rect / r.area, grown = r.grown / r.area;
check('rectangle coverage within 0.02 of its share', Math.abs(r.st.coverage - grown) <= 0.02, `coverage ${f(r.st.coverage)} rect ${f(share)} with brush edge ${f(grown)}`);
await shot('rectangle');

// M0.6 (logic only): tilt changes width; a touch just after a pen does not paint; 61 s later it does.
r = await run(async () => {
  const S = window.__salon, L = S.info().length, out = {};
  await S.clear(); await S.stroke([[0, 0.2], [0, 0.7]], { altitude: 80 * Math.PI / 180, at: 10000 }); out.upright = (await S.stats()).coverage;
  await S.clear(); await S.stroke([[0, 0.2], [0, 0.7]], { altitude: 20 * Math.PI / 180, at: 20000 }); out.flat = (await S.stats()).coverage;
  await S.clear();
  out.palm = (await S.stroke([[0, 0.2], [0, 0.7]], { pointerType: 'touch', at: 25000 })).stamps;
  out.later = (await S.stroke([[0, 0.2], [0, 0.7]], { pointerType: 'touch', at: 20000 + 61000 + 5000 })).stamps;
  return out;
});
check('flat Pencil paints wider than upright', r.flat > r.upright * 1.2, `upright ${f(r.upright)} flat ${f(r.flat)}`);
check('palm rejection, then finger painting returns', r.palm === 0 && r.later > 0, `stamps ${r.palm} then ${r.later}`);

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
