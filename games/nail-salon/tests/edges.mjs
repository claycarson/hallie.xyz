// The nail's edge on screen must be its own outline, never a line where skin cuts through the
// plate: the skin height is a grid, so every such crossing renders jagged (Clay found them at the
// side walls, then at the cuticle corners). For every finger, shape and length this rebuilds the
// plate and checks that no skin rises above it, anywhere inside the outline or along it, against
// a skin heightfield twice as fine as the one the plate is built from.
// Needs `npm run serve`. Part of `npm run robot`.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
const browser = await webkit.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}?scene=hand`);
await page.evaluate(() => window.__salon.ready);

const rows = await page.evaluate(async () => {
  const { NailFrame } = await import('./src/hand/frame.js');
  const { SkinHeight, makePlateZ } = await import('./src/hand/plate.js');
  const { outline, sdPolygon, SHAPES } = await import('./src/hand/outline.js');
  const hand = await (await fetch('./data/hand.json')).json();
  const skin = window.__salon.three.scene.children.find((m) => m.isMesh && m.geometry.getAttribute('tone'));
  const out = [];
  for (const cfg of hand.fingers) {
    const fr = new NailFrame(cfg, hand.maxFree); fr.update();
    const sh = new SkinHeight(fr, [skin]), fine = new SkinHeight(fr, [skin], 257, 385);
    for (const shape of SHAPES) for (const free of [0, 0.25, 1]) {
      const info = outline(shape, fr.lengthFor(free)), z = makePlateZ(fr, info.points, sh, hand.fold, cfg);
      let worst = Infinity, at = null;
      const test = (x, y) => {
        if (!fine.valid[Math.round((y - fr.rect.y0) / fr.rect.h * (fine.ny - 1)) * fine.nx + Math.round((x - fr.rect.x0) / fr.rect.w * (fine.nx - 1))]) return;
        const gap = z(x, y) - fine.at(x, y);
        if (gap < worst) { worst = gap; at = [x, y]; }
      };
      // Along the outline (just inside it), then a grid over the whole plate.
      for (let i = 0; i < info.points.length / 2; i++) {
        const x = info.points[2 * i], y = info.points[2 * i + 1], cx = 0, cy = info.length / 2;
        const l = Math.hypot(cx - x, cy - y);
        for (const d of [0.001, 0.005, 0.01]) test(x + (cx - x) / l * d, y + (cy - y) / l * d);
      }
      for (let y = 0; y <= info.length; y += 0.01) for (let x = -0.5; x <= 0.5; x += 0.01) if (sdPolygon(info.points, x, y) < 0) test(x, y);
      out.push({ finger: cfg.finger, shape, free, worst, at });
    }
  }
  return out;
});
await browser.close();

// Skin must stay at least this far under the plate (nail widths); the fine grid still misses
// a little of the real mesh between its samples.
const MARGIN = 0.002;
let failed = 0;
for (const finger of [0, 1, 2, 3, 4]) {
  const mine = rows.filter((r) => r.finger === finger), worst = mine.reduce((a, b) => (b.worst < a.worst ? b : a));
  const ok = worst.worst >= MARGIN;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  edges finger ${finger}: skin stays under the plate on all ${mine.length} shapes/lengths  closest ${worst.worst.toFixed(4)} (${worst.shape}, free ${worst.free}, at ${worst.at.map((v) => v.toFixed(2)).join(', ')})`);
}
process.exit(failed ? 1 : 0);
