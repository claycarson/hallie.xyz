// Every nail runs along its finger (Clay, 2026-11-11, more than once): the centre line of the
// finger's outline seen down the nail — from 1.6 nail widths behind the cuticle to 60% along the
// bed, its own finger only — must be within 1° of the nail's axis and within 0.03 widths of its
// middle. tools/fit-frames.mjs fits to exactly this; the test stops anything drifting from it.
// Needs `npm run serve`. Part of `npm run robot`.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const browser = await webkit.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}?scene=hand`);
await page.evaluate(() => window.__salon.ready);
const res = await page.evaluate(async () => {
  const { NailFrame } = await import('./src/hand/frame.js');
  const { SkinHeight } = await import('./src/hand/plate.js');
  const hand = await (await fetch('./data/hand.json')).json();
  const skin = window.__salon.three.scene.children.find((m) => m.isMesh && m.geometry.getAttribute('tone'));
  return hand.fingers.map((cfg) => {
    const fr = new NailFrame(cfg, hand.maxFree);
    fr.update();
    const bed = fr.bed;
    fr.rect = { x0: -1.6, y0: -2.0, w: 3.2, h: 2.0 + bed };
    const so = new SkinHeight(fr, [skin]), R = fr.rect;
    const cover = (x, y) => {
      const u = (x - R.x0) / R.w * (so.nx - 1), v = (y - R.y0) / R.h * (so.ny - 1), i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const g = (ii, jj) => (ii < 0 || jj < 0 || ii >= so.nx || jj >= so.ny ? 0 : so.valid[jj * so.nx + ii]);
      return (g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fv) + (g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fv;
    };
    const rows = [];
    for (let y = -1.6; y <= 0.6 * bed + 1e-9; y += 0.05) {
      if (cover(0, y) < 0.5) continue;
      const edge = (dir) => {
        for (let x = 0; Math.abs(x) < 1.55; x += dir * 0.01) {
          const c0 = cover(x, y) - 0.5, c1 = cover(x + dir * 0.01, y) - 0.5;
          if (c0 > 0 && c1 <= 0) return x + dir * 0.01 * c0 / (c0 - c1);
        }
        return NaN;
      };
      const l = edge(-1), r = edge(1);
      if (Number.isFinite(l) && Number.isFinite(r)) rows.push({ y, m: (l + r) / 2 });
    }
    const n = rows.length, sy = rows.reduce((s, q) => s + q.y, 0), sm = rows.reduce((s, q) => s + q.m, 0);
    const syy = rows.reduce((s, q) => s + q.y * q.y, 0), sym = rows.reduce((s, q) => s + q.y * q.m, 0);
    const b = (n * sym - sy * sm) / (n * syy - sy * sy), a = (sm - b * sy) / n;
    return { finger: cfg.finger, deg: Math.atan(b) * 180 / Math.PI, off: a + b * 0.5 * bed };
  });
});
await browser.close();
for (const r of res) check(`nail ${r.finger} runs along its finger`, Math.abs(r.deg) <= 1 && Math.abs(r.off) <= 0.03, `${r.deg.toFixed(2)}° off, centre ${r.off.toFixed(3)} widths off`);
process.exit(failed ? 1 : 0);
