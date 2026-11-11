// Square each nail frame up with its finger (PLAN §3.3). Measures the sculpt under every frame
// with the game's own SkinHeight and corrects, a few rounds each:
//   yaw + x   the finger's centre line (midway between its side walls) runs straight up the frame,
//   roll      the skin either side of the nail is level (the nail faces the way the finger does),
//   pitch     the nail bed is level along its length.
// Usage (with `npm run serve` running): node tools/fit-frames.mjs [--only <finger>] [--write]
// A finger with "fitLock" in data/hand.json is skipped: its frame was set by eye against the finger's
// outline (the ring finger: its folds are centred on the nail but the finger bends away, see notes).
// Prints before/after numbers; --write saves origin/tipDir/normal into data/hand.json. Rerun
// tools/build-hand.mjs afterwards (it presses the sculpt's own free edges back using the frames).
import { webkit } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
const HAND = new URL('../data/hand.json', import.meta.url).pathname;
const browser = await webkit.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}?scene=hand`);
await page.evaluate(() => window.__salon.ready);
const onlyAt = process.argv.indexOf('--only');
if (onlyAt > 0) await page.evaluate((n) => { window.__only = n; }, Number(process.argv[onlyAt + 1]));
if (process.env.TRACE) { page.on('console', (m) => console.log(m.text())); await page.evaluate(() => { window.__trace = 1; }); }

const fitted = await page.evaluate(async () => {
  const THREE = await import('three');
  const { NailFrame } = await import('./src/hand/frame.js');
  const { SkinHeight } = await import('./src/hand/plate.js');
  const hand = await (await fetch('./data/hand.json')).json();
  const skin = window.__salon.three.scene.children.find((m) => m.isMesh && m.geometry.getAttribute('tone'));

  /** Side walls, centre line, tilt across and along, all in nail widths. */
  function measure(cfg) {
    const fr = new NailFrame(cfg, hand.maxFree);
    fr.update();
    const sh = new SkinHeight(fr, [skin]), bed = fr.bed, rows = [];
    for (let y = 0.2 * bed; y <= 0.85 * bed + 1e-9; y += 0.05 * bed) {
      // Smoothed skin and an interpolated crossing, so the walls move continuously as the
      // frame turns (a stepped search made the fit chatter).
      const top = sh.smooth(0, y), h = (x) => sh.smooth(x, y) - (top - 0.3);
      const wall = (dir) => {
        for (let x = 0; Math.abs(x) < 0.87; x += dir * 0.01) {
          const a = h(x), b = h(x + dir * 0.01);
          if (a > 0 && b <= 0) return x + dir * 0.01 * a / (a - b);
        }
        return NaN;
      };
      const l = wall(-1), r = wall(1);
      if (Number.isFinite(l) && Number.isFinite(r)) rows.push({ y, m: (l + r) / 2, half: (r - l) / 2 });
    }
    // Centre line m = a + b·y, least squares.
    const n = rows.length, sy = rows.reduce((s, q) => s + q.y, 0), sm = rows.reduce((s, q) => s + q.m, 0);
    const syy = rows.reduce((s, q) => s + q.y * q.y, 0), sym = rows.reduce((s, q) => s + q.y * q.m, 0);
    const b = (n * sym - sy * sm) / (n * syy - sy * sy), a = (sm - b * sy) / n;
    const half = rows.reduce((s, q) => s + q.half, 0) / n;
    // Across: skin height a little inside each wall, averaged along the bed.
    let roll = 0;
    for (const q of rows) roll += (sh.smooth(q.m + 0.3, q.y) - sh.smooth(q.m - 0.3, q.y)) / 0.6 / n;
    const pitch = (sh.smooth(a + b * 0.8 * bed, 0.8 * bed) - sh.smooth(a + b * 0.3 * bed, 0.3 * bed)) / (0.5 * bed);
    return { a, b, roll, pitch, half, z: sh.smooth(a + b * 0.5 * bed, 0.5 * bed) };
  }

  const r4 = (v) => Number(v.toFixed(4)), r5 = (v) => Number(v.toFixed(5));
  const out = [];
  for (const cfg0 of hand.fingers) {
    if (window.__only != null && cfg0.finger !== window.__only) continue;
    if (cfg0.fitLock) continue;
    let cfg = { ...cfg0 };
    const before = measure(cfg);
    // Four moves (sideways, yaw, pitch, roll) against four measures (centre offset, centre
    // slope, tilt along, tilt across). The measures are coupled (turning moves the walls), so
    // each round measures how every move changes every measure and solves for all four.
    const move = (c, [dx, yaw, pitch, roll]) => {
      const tip = new THREE.Vector3(...c.tipDir).normalize(), nrm = new THREE.Vector3(...c.normal);
      nrm.addScaledVector(tip, -nrm.dot(tip)).normalize();
      const side = new THREE.Vector3().crossVectors(tip, nrm), o = new THREE.Vector3(...c.origin).addScaledVector(side, dx * c.width);
      tip.applyAxisAngle(nrm, yaw); side.applyAxisAngle(nrm, yaw);
      tip.applyAxisAngle(side, pitch); nrm.applyAxisAngle(side, pitch);
      nrm.applyAxisAngle(tip, roll);
      return { ...c, origin: o.toArray(), tipDir: tip.toArray(), normal: nrm.toArray() };
    };
    const res = (m) => [m.a, m.b, m.pitch, m.roll];
    const EPS = [0.02, 0.02, 0.02, 0.02];
    for (let round = 0; round < 6; round++) {
      const r0 = res(measure(cfg));
      if (window.__trace) console.log(cfg.finger, round, r0.map((v) => v.toFixed(4)).join(' '));
      if (Math.max(...r0.map(Math.abs)) < 0.004) break;
      const J = EPS.map((e, k) => { const p = [0, 0, 0, 0]; p[k] = e; return res(measure(move(cfg, p))).map((v, i) => (v - r0[i]) / e); });
      // Solve J·p = −r0 (J[k][i] = ∂res_i/∂p_k), Gaussian elimination on the 4×4.
      const A = r0.map((_, i) => [...J.map((col) => col[i]), -r0[i]]);
      for (let c = 0; c < 4; c++) {
        let b = c; for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[b][c])) b = r;
        [A[c], A[b]] = [A[b], A[c]];
        for (let r = 0; r < 4; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= 4; k++) A[r][k] -= f * A[c][k]; }
      }
      const p = A.map((row, i) => row[4] / row[i]);
      const cap = Math.max(1, Math.max(...p.slice(1).map(Math.abs)) / 0.15);       // at most ~9° a round
      cfg = move(cfg, p.map((v) => v / cap));
    }
    cfg = { ...cfg, origin: cfg.origin.map(r5), tipDir: cfg.tipDir.map(r4), normal: cfg.normal.map(r4) };
    const after = measure(cfg);
    const t0 = new THREE.Vector3(...cfg0.tipDir).normalize(), t1 = new THREE.Vector3(...cfg.tipDir).normalize();
    const n0 = new THREE.Vector3(...cfg0.normal).normalize(), n1 = new THREE.Vector3(...cfg.normal).normalize();
    out.push({ finger: cfg.finger, origin: cfg.origin, tipDir: cfg.tipDir, normal: cfg.normal, before, after,
      turned: { tipDeg: t0.angleTo(t1) * 57.3, normalDeg: n0.angleTo(n1) * 57.3, movedMm: new THREE.Vector3(...cfg0.origin).distanceTo(new THREE.Vector3(...cfg.origin)) * 1000 } });
  }
  return out;
});
await browser.close();

const f2 = (v) => v.toFixed(3);
for (const f of fitted) {
  const s = (m) => `centre ${f2(m.a)} + ${f2(m.b)}·y  tilt across ${f2(m.roll)}  along ${f2(m.pitch)}  finger half-width ${f2(m.half)}`;
  console.log(`finger ${f.finger}: turned tip ${f.turned.tipDeg.toFixed(1)}°, normal ${f.turned.normalDeg.toFixed(1)}°, origin ${f.turned.movedMm.toFixed(2)} mm`);
  console.log(`  before ${s(f.before)}\n  after  ${s(f.after)}`);
}
if (process.argv.includes('--write')) {
  const text = readFileSync(HAND, 'utf8');
  let next = text;
  for (const f of fitted) {
    const re = new RegExp(`("finger": ${f.finger}, "bone": null, )"origin": \\[[^\\]]*\\], "tipDir": \\[[^\\]]*\\], "normal": \\[[^\\]]*\\]`);
    if (!re.test(next)) throw new Error(`finger ${f.finger}: entry not found in hand.json`);
    next = next.replace(re, `$1"origin": ${JSON.stringify(f.origin).replace(/,/g, ', ')}, "tipDir": ${JSON.stringify(f.tipDir).replace(/,/g, ', ')}, "normal": ${JSON.stringify(f.normal).replace(/,/g, ', ')}`);
  }
  writeFileSync(HAND, next);
  console.log('wrote data/hand.json');
}
