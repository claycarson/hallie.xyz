// Palm rejection with real PointerEvents through the canvas (two contacts at once, which the
// robot painter's samples can't do). Clay's palm got in the way on the iPad.
// Needs `npm run serve`. Part of `npm run robot`.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

/** Fresh page (no pen seen yet), then run `steps` in it; returns stamps laid and the hand's direction. */
async function scenario(steps) {
  await page.goto(`${BASE}?scene=nail`);
  await page.evaluate(() => window.__salon.ready);
  return page.evaluate(async (steps) => {
    const S = window.__salon, cv = document.getElementById('gl'), wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await S.clear();
    const before = S.stampCount(), up0 = S.direction().up;
    const fire = (el, type, id, kind, [x, y], size = 10, buttons = 1) => {
      const [cx, cy] = el === cv ? S.project(x, y) : [x, y];
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: kind, clientX: cx, clientY: cy, width: size, height: size, buttons, bubbles: true, isPrimary: kind !== 'touch' || id === 2 }));
    };
    for (const [op, ...a] of steps) {
      if (op === 'wait') await wait(a[0]);
      else if (op === 'button') {                 // press the turn button with this pointer type
        const b = document.getElementById('turn'), r = b.getBoundingClientRect(), at = [r.x + r.width / 2, r.y + r.height / 2];
        fire(b, 'pointerdown', a[1], a[0], at, a[2] ?? 10); fire(b, 'pointerup', a[1], a[0], at, a[2] ?? 10, 0); b.click();
        await wait(700);
      } else fire(cv, `pointer${op}`, ...a);
      await S.nextFrame();
    }
    await wait(50); await S.nextFrame();
    return { stamps: S.stampCount() - before, turned: S.direction().up !== up0 };
  }, steps);
}
const path = (id, kind, size, from, to, n = 12, ms = 25) => {
  const out = [['down', id, kind, from, size]];
  for (let i = 1; i <= n; i++) out.push(['move', id, kind, [from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n], size], ['wait', ms]);
  return out;
};

// A palm lands first; then the Pencil paints while the palm stays down.
let r = await scenario([['down', 2, 'touch', [0.3, 0.9], 12], ['wait', 60], ...path(3, 'pen', 1, [-0.2, 0.2], [-0.2, 0.8]), ['up', 3, 'pen', [-0.2, 0.8], 1, 0], ['move', 2, 'touch', [0.2, 0.6], 12], ['wait', 200], ['move', 2, 'touch', [0.1, 0.3], 12], ['up', 2, 'touch', [0.1, 0.3], 12, 0]]);
const penOnly = await scenario([...path(3, 'pen', 1, [-0.2, 0.2], [-0.2, 0.8]), ['up', 3, 'pen', [-0.2, 0.8], 1, 0]]);
check('Pencil paints while a palm is already down', r.stamps > 0 && Math.abs(r.stamps - penOnly.stamps) <= 2, `stamps ${r.stamps}, Pencil alone ${penOnly.stamps}`);

// A big contact sweeping the nail, no Pencil seen yet: a palm.
r = await scenario([...path(2, 'touch', 80, [0.3, 0.2], [-0.3, 0.9]), ['up', 2, 'touch', [-0.3, 0.9], 80, 0]]);
check('a palm-sized touch never paints', r.stamps === 0, `stamps ${r.stamps}`);

// A small contact resting still, then lifting, no Pencil seen yet: the side of a hand.
r = await scenario([['down', 2, 'touch', [0, 0.5], 10], ['wait', 400], ['up', 2, 'touch', [0, 0.5], 10, 0]]);
check('a resting touch never paints', r.stamps === 0, `stamps ${r.stamps}`);

// Finger painting still works: a moving fingertip, and a quick dab.
r = await scenario([...path(2, 'touch', 10, [0, 0.2], [0, 0.8]), ['up', 2, 'touch', [0, 0.8], 10, 0]]);
check('a fingertip still paints', r.stamps > 0, `stamps ${r.stamps}`);
r = await scenario([['down', 2, 'touch', [0, 0.5], 10], ['wait', 60], ['up', 2, 'touch', [0, 0.5], 10, 0]]);
check('a quick finger dab still paints', r.stamps > 0, `stamps ${r.stamps}`);

// Right after the Pencil, a touch on the turn button is a palm; the Pencil can still press it.
r = await scenario([...path(3, 'pen', 1, [-0.2, 0.2], [-0.2, 0.5], 4), ['up', 3, 'pen', [-0.2, 0.5], 1, 0], ['button', 'touch', 2]]);
check('a palm on the turn button does not turn the hand', !r.turned, `turned ${r.turned}`);
r = await scenario([...path(3, 'pen', 1, [-0.2, 0.2], [-0.2, 0.5], 4), ['up', 3, 'pen', [-0.2, 0.5], 1, 0], ['button', 'pen', 3]]);
check('the Pencil turns the hand', r.turned, `turned ${r.turned}`);

await browser.close();
process.exit(failed ? 1 : 0);
