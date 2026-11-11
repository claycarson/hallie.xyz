// M0.8: the hand turns without touching the paint, and every nail is upright (or leans exactly as
// camera.json's per-finger roll asks, for a finger that bends away from its nail) and the same
// size in both directions. Needs `npm run serve` (port 8813).
import { webkit } from 'playwright';
import { readFileSync } from 'node:fs';

const CAM = JSON.parse(readFileSync(new URL('../data/camera.json', import.meta.url), 'utf8'));

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
const browser = await webkit.launch();
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// Every finger, both directions: long axis vertical, tip on the correct side, same screen width.
const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const widths = [];
for (const flip of [0, 1]) for (const finger of [0, 1, 2, 3, 4]) {
  await page.goto(`${BASE}?scene=nail&finger=${finger}&flip=${flip}`);
  const r = await page.evaluate(async () => {
    await window.__salon.ready;
    const S = window.__salon, L = S.info().length;
    return { base: S.project(0, 0), tip: S.project(0, L), left: S.project(-0.4, L / 2), right: S.project(0.4, L / 2) };
  });
  const tipBelow = r.tip[1] > r.base[1], width = Math.hypot(r.right[0] - r.left[0], r.right[1] - r.left[1]) / 0.8;
  const angle = Math.abs(Math.atan2(r.tip[0] - r.base[0], r.tip[1] - r.base[1]) * 180 / Math.PI), lean = Math.min(angle, 180 - angle);
  const want = Math.abs(CAM.fingers[flip ? 'up' : 'down'][finger].roll ?? 0);
  widths.push(width);
  check(`finger ${finger} ${flip ? 'tips up' : 'tips down'}: upright`, Math.abs(lean - want) < 0.8 && tipBelow === !flip, `lean ${lean.toFixed(1)}° (asked ${want}°), width ${width.toFixed(0)} px`);
}
check('same nail width on screen, all fingers, both ways', Math.max(...widths) / Math.min(...widths) < 1.05, `${Math.min(...widths).toFixed(0)}–${Math.max(...widths).toFixed(0)} px`);

// Paint, turn, turn back. The stats may not move.
await page.goto(`${BASE}?scene=nail&debug`);     // fixed scene: wet polish does not level between the reads
await page.evaluate(() => window.__salon.ready);
let r = await page.evaluate(async () => {
  const S = window.__salon, L = S.info().length, out = {};
  const paint = async () => { for (const x of [-0.3, 0, 0.3]) await S.stroke([[x, 0.08], [x, L - 0.04]], { speed: 1.0 }); };
  await S.clear(); await paint();
  out.before = await S.stats();
  out.turned = await S.turn(); out.up = S.direction().up;
  out.afterTurn = await S.stats();
  await S.clear(); await paint();                    // the same strokes, painted tips-up
  out.paintedUp = await S.stats();
  await S.turn(); out.back = S.direction().up;
  return out;
});
const same = (a, b, eps) => ['coverage', 'evenness', 'spill', 'colorMatch', 'finishMatch'].every((k) => Math.abs(a[k] - b[k]) <= eps);
check('the turn button turns the hand', r.turned && r.up === true && r.back === false, `up ${r.up}, back ${r.back}`);
check('turning leaves the stats identical', same(r.before, r.afterTurn, 0), `coverage ${r.before.coverage} → ${r.afterTurn.coverage}`);
check('the same strokes painted tips-up read the same', same(r.before, r.paintedUp, 0.005), `coverage ${r.before.coverage.toFixed(4)} vs ${r.paintedUp.coverage.toFixed(4)}`);

// No stroke starts mid-turn, and no turn starts mid-stroke.
r = await page.evaluate(async () => {
  const S = window.__salon, out = {}, canvas = document.getElementById('gl');
  const turning = S.turn();
  out.mid = S.direction().turning;
  out.stamps = (await S.stroke([[0, 0.2], [0, 0.7]], {})).stamps;
  await turning; await S.turn();
  const [cx, cy] = S.project(0, 0.3);
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, pointerId: 7, pointerType: 'mouse', buttons: 1, bubbles: true }));
  out.refused = (await S.turn()) === false;
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, pointerId: 7, pointerType: 'mouse', bubbles: true }));
  return out;
});
check('no paint while the hand is turning', r.mid && r.stamps === 0, `turning ${r.mid}, stamps ${r.stamps}`);
check('no turn while the brush is down', r.refused, String(r.refused));

// The choice is remembered, and a real tap on the button works.
await page.evaluate(() => localStorage.clear());
await page.goto(`${BASE}?debug`);
await page.evaluate(() => window.__salon.ready);
await page.click('#turn');
await page.waitForFunction(() => window.__salon.direction().up && !window.__salon.direction().turning);
await page.reload();
r = await page.evaluate(async () => { await window.__salon.ready; const d = window.__salon.direction().up; await window.__salon.turn(); return d; });
check('the direction is remembered after a reload', r === true, `up ${r}`);

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
