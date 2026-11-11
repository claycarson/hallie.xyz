// M0.6: the 3D brush follows the Pencil, leans with it, floats on hover, and never paints from a
// predicted sample. Needs `npm run serve` (port 8813).
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const shot = (name) => page.screenshot({ path: new URL(`./shots/brush-${name}.png`, import.meta.url).pathname });

await page.goto(`${BASE}?scene=nail`);
await page.evaluate(() => window.__salon.ready);
let r = await page.evaluate(async () => {
  const S = window.__salon, out = {};
  await S.nextFrame(); await S.nextFrame();
  out.idle = S.brush();
  await S.pen('hover', 0, 0.6);
  out.hover = S.brush(); out.hoverStamps = S.stampCount();
  return out;
});
check('hidden until the Pencil is seen', r.idle.visible === false, `visible ${r.idle.visible}`);
check('hover floats above the nail and lays no paint', r.hover.visible && r.hover.tipZ > r.hover.surfaceZ + 0.1 && r.hoverStamps === 0, `gap ${(r.hover.tipZ - r.hover.surfaceZ).toFixed(3)} stamps ${r.hoverStamps}`);
await shot('hover');

r = await page.evaluate(async () => {
  const S = window.__salon, out = {}, A = Math.PI / 180;
  await S.pen('down', 0, 0.3, { altitude: 60 * A }); await S.pen('move', 0, 0.4, { altitude: 60 * A }); await S.pen('move', 0, 0.55, { altitude: 60 * A });
  out.down = S.brush(); out.stamps = S.stampCount();
  await S.pen('predict', 0.2, 0.9, { altitude: 60 * A });
  out.predicted = S.brush(); out.stampsAfter = S.stampCount();
  await S.pen('move', 0, 0.6, { altitude: 25 * A }); out.low = S.brush();
  const tail = (b) => { const [x, y] = S.project(b.tail[0], b.tail[1]), [cx, cy] = S.project(b.x, b.y); return [x - cx, y - cy]; };
  out.screen = tail(S.brush());
  await S.pen('up', 0, 0.6);
  return out;
});
check('touching: the bristles splay and sit on the nail', r.down.touching && r.down.splay > 1.2 && r.down.tipZ <= r.down.surfaceZ + 0.01, `splay ${r.down.splay}, gap ${(r.down.tipZ - r.down.surfaceZ).toFixed(3)}`);
check('a predicted sample moves the brush and paints nothing', Math.abs(r.predicted.x - 0.2) < 0.02 && r.stampsAfter === r.stamps, `x ${r.predicted.x.toFixed(3)}, stamps ${r.stamps} → ${r.stampsAfter}`);
check('it leans further as the Pencil tilts', r.low.axisZ < r.down.axisZ - 0.2, `axis z ${r.down.axisZ.toFixed(2)} → ${r.low.axisZ.toFixed(2)}`);
check('its tail leans the way the Pencil does on screen', r.screen[0] > 0 && r.screen[1] > 0, `tail ${r.screen.map((n) => n.toFixed(0))} px`);

await page.evaluate(async () => { const S = window.__salon, A = Math.PI / 180; await S.pen('down', -0.15, 0.3, { altitude: 45 * A }); await S.pen('move', -0.1, 0.5, { altitude: 45 * A }); await S.pen('move', -0.05, 0.75, { altitude: 45 * A }); });
await shot('touching');
await page.evaluate(() => window.__salon.pen('up', 0, 0.6));

r = await page.evaluate(async () => {
  const S = window.__salon, out = {};
  await S.turn(); await S.pen('hover', 0, 0.6, { azimuth: 0.8 });
  const b = S.brush(); const [x, y] = S.project(b.tail[0], b.tail[1]), [cx, cy] = S.project(b.x, b.y);
  out.screen = [x - cx, y - cy];
  return out;
});
check('tips-up: it still leans the same way on screen', r.screen[0] > 0 && r.screen[1] > 0, `tail ${r.screen.map((n) => n.toFixed(0))} px`);
await shot('turned');

// A real PointerEvent keeps its tilt through the input path (its fields are getters, so a copy of
// the event would lose them).
await page.goto(`${BASE}?scene=nail&debug`);
await page.evaluate(() => window.__salon.ready);
r = await page.evaluate(async () => {
  const S = window.__salon, c = document.getElementById('gl'), [x, y] = S.project(0, 0.4);
  const fire = (t, o) => c.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 9, pointerType: 'pen', buttons: 1, bubbles: true, tiltX: 40, tiltY: 0, ...o }));
  fire('pointerdown'); await S.nextFrame();
  const axis = S.brush().axisZ, report = document.querySelector('#debug pre');
  fire('pointerup', { buttons: 0 });
  return { axis, tilted: S.brush().axisZ < 0.9 };
});
check('a real pen event keeps its tilt', r.tilted, `axis z ${r.axis.toFixed(2)}`);

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
