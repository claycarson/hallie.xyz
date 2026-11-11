// M1.3: mess and mistakes. Spill, then the swab cleans the skin and leaves the nail alone; Oops
// restores the exact pre-stroke stats (on whichever nail the stroke was on); the remover pad takes
// polish off in 3–4 rubs and its finish with it; spill on fingers that aren't being painted shows
// in hand view. Needs `npm run serve`. Part of `npm run robot`.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const f3 = (v) => v.toFixed(3);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}?scene=nail&finger=2&polish=cream-red`);
await page.evaluate(() => window.__salon.ready);

const r = await page.evaluate(async () => {
  const S = window.__salon, out = {};
  const same = (a, b) => ['coverage', 'evenness', 'colorMatch', 'finishMatch', 'spill'].every((k) => Math.abs(a[k] - b[k]) < 1e-9);
  const paintNail = async () => { const L = S.info().length; for (const x of [-0.36, -0.12, 0.12, 0.36]) await S.stroke([[x, 0.03], [x, L - 0.02]], { speed: 1.0 }); };
  const meanFilm = async () => { await S.stats(); let s = 0, n = 0; const L = S.info().length; for (let x = -0.4; x <= 0.4; x += 0.1) for (let y = 0.1; y <= L - 0.1; y += 0.1) { s += S.filmAt(x, y); n++; } return s / n; };
  await S.clear();
  out.noUndoAtStart = !S.canUndo();

  // Paint the nail, then spill off both sides onto the skin.
  await paintNail();
  await S.stroke([[0, 0.6], [0.95, 0.65]]);
  await S.stroke([[0, 0.9], [-0.95, 0.95]]);
  const painted = await S.stats();
  out.painted = { ...painted };

  // Swab from the middle of the nail out over each side: skin comes clean, the nail doesn't move.
  // (Strokes start on the hand: a press on empty background is a swipe, never a stroke.)
  S.setTool('swab');
  for (const y of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1]) for (const x of [-1.0, 1.0]) await S.stroke([[0, y], [x, y]], { dip: false });
  out.swabbed = { ...(await S.stats()) };

  // Oops undoes the last swab stroke only; a fresh scribble is undone exactly.
  S.setTool('polish');
  const before = { ...(await S.stats()) };
  await S.stroke([[0, 0.4], [1.0, 0.2]]);                         // a new spill
  out.scribbled = { ...(await S.stats()) };
  out.undid = await S.undo();
  out.afterUndo = { ...(await S.stats()) };
  out.exact = same(before, out.afterUndo);
  out.secondUndo = await S.undo();

  // Remover pad: rubs along the nail. Film falls by about half a rub; 4 rubs clear it.
  S.setTool('remover');
  const L = S.info().length, rub = () => S.stroke([[0, -0.1], [0, L + 0.1]], { dip: false });
  out.films = [await meanFilm()];
  for (let i = 0; i < 4; i++) { await rub(); out.films.push(await meanFilm()); }
  out.removed = { ...(await S.stats()) };
  S.setRequest('cream-red');
  out.finishGone = (await S.stats()).finishMatch;

  // Undo across a nail change: paint finger 2, move to finger 3, Oops puts finger 2 back.
  S.setTool('polish');
  await S.clear();
  await paintNail();
  const f2before = (await S.statsAll())[2];
  await S.stroke([[0, 0.5], [1.0, 0.6]]);
  const f2spilled = (await S.statsAll())[2];
  await S.goTo('nail', 3);
  await S.undo();
  out.backOn = S.info().finger;
  out.crossNail = { before: f2before, spilled: f2spilled, after: (await S.statsAll())[2] };
  out.crossExact = same(f2before, out.crossNail.after);
  out.bytes = S.paintBytes();
  return out;
});

check('Oops starts disabled', r.noUndoAtStart, `${r.noUndoAtStart}`);
check('painting off the nail spills', r.painted.spill > 0.01 && r.painted.coverage > 0.95, `coverage ${f3(r.painted.coverage)} spill ${f3(r.painted.spill)}`);
check('swab: spill < 0.01', r.swabbed.spill < 0.01, `spill ${f3(r.painted.spill)} → ${f3(r.swabbed.spill)}`);
check('swab: the nail is untouched', Math.abs(r.swabbed.coverage - r.painted.coverage) < 0.003 && Math.abs(r.swabbed.colorMatch - r.painted.colorMatch) < 0.003, `coverage ${f3(r.painted.coverage)} → ${f3(r.swabbed.coverage)}`);
check('Oops restores the pre-stroke stats exactly', r.undid && r.exact && r.scribbled.spill > 0.01, `spill ${f3(r.scribbled.spill)} → ${f3(r.afterUndo.spill)}, exact ${r.exact}`);
check('Oops is one level', r.secondUndo === false, `second undo ${r.secondUndo}`);
const fm = r.films.map(f3).join(' → ');
check('remover: one rub leaves polish, 3–4 rubs clear it', r.films[1] > 0.2 && r.films[2] > 0.05 && r.films[4] < 0.05, `mean film ${fm}`);
check('remover: coverage gone and the finish with it', r.removed.coverage < 0.01 && r.finishGone === 0, `coverage ${f3(r.removed.coverage)} finish ${r.finishGone}`);
check('Oops after moving to another nail goes back and restores it exactly', r.backOn === 2 && r.crossExact && r.crossNail.spilled.spill > 0.01, `spill ${f3(r.crossNail.spilled.spill)} → ${f3(r.crossNail.after.spill)}, exact ${r.crossExact}`);
check('paint memory (with undo and spill atlas) within 100 MB', r.bytes <= 100 * 1048576, `${(r.bytes / 1048576).toFixed(1)} MB`);

// Spill on a finger that isn't being painted shows on its skin in hand view.
const hv = await page.evaluate(async () => {
  const S = window.__salon, { renderer, scene, camera } = S.three, gl = renderer.getContext();
  const sample = (id) => {
    const [cx, cy] = S.nailOnScreen(id), dpr = renderer.getPixelRatio(), H = gl.drawingBufferHeight;
    renderer.render(scene, camera);
    const px = new Uint8Array(4 * 60 * 60);
    gl.readPixels(Math.round(cx * dpr) - 30, H - Math.round(cy * dpr) - 30, 60, 60, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  await S.clear();
  await S.goTo('nail', 1);
  await S.stroke([[0, 0.6], [1.1, 0.6]]); await S.stroke([[0, 0.7], [-1.1, 0.7]]);   // spill on finger 1
  await S.goTo('nail', 3);                                                              // now finger 1 is not active
  await S.goTo('hand');
  const withSpill = sample(1);
  await S.clear();
  const clean = sample(1);
  let diff = 0; for (let i = 0; i < withSpill.length; i += 4) diff += Math.abs(withSpill[i + 1] - clean[i + 1]) > 25 ? 1 : 0;
  return { changed: diff, active: S.info().finger };
});
check('spill on a finger that is not being painted shows in hand view', hv.changed > 60 && hv.active === 3, `${hv.changed} pixels round nail 1 changed (active ${hv.active})`);

await browser.close();
process.exit(failed ? 1 : 0);
