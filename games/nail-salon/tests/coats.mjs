// M1.4: base and top coats with the flood rule and auto-advance; jelly. One stroke over half a
// nail fills the coat (touched → 1.0) and sets topCoat; a short stroke does not; the camera then
// moves to the next nail that still needs the coat; the remover takes coats off; Oops puts them
// back; jelly counts as covered from a thinner film than cream.
// Needs `npm run serve`. Part of `npm run robot`.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const f2 = (v) => v.toFixed(2);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}?scene=nail&finger=1`);
await page.evaluate(() => window.__salon.ready);

const r = await page.evaluate(async () => {
  const S = window.__salon, out = {};
  const L = () => S.info().length;
  await S.clear();

  // A short gloss stroke: touched but not flooded, no auto-advance.
  S.setTool('gloss');
  await S.stroke([[0, 0.2], [0, 0.5]]);
  out.short = { share: S.touchShare(), top: S.coats()[1].top };
  await S.settle();
  out.shortStayed = S.info().finger === 1;

  // One stroke down the middle, over half the nail: the coat fills it and the camera moves on.
  await S.stroke([[0, 0.02], [0, L() - 0.02]]);
  out.flood = { share: S.touchShare(), top: S.coats()[1].top };
  const order = S.order();
  await S.settle();
  out.advancedTo = S.info().finger;
  out.expected = order[order.indexOf(1) + 1];

  // Base coat on this nail too, then the remover takes both coats off.
  S.setTool('base');
  await S.stroke([[0, 0.02], [0, L() - 0.02]]);
  out.base = S.coats()[out.advancedTo].base;
  await S.settle();
  const baseOn = out.advancedTo;                 // the base coat went on here; the camera has moved on
  await S.goTo('nail', baseOn);
  S.setTool('gloss'); await S.stroke([[0, 0.02], [0, L() - 0.02]]);
  out.both = { ...S.coats()[baseOn] };
  await S.settle();
  await S.goTo('nail', baseOn);
  S.setTool('remover');
  await S.stroke([[0, -0.1], [0, L() + 0.1]]);
  out.removed = { ...S.coats()[baseOn] };
  out.undid = await S.undo();
  out.restored = { ...S.coats()[baseOn] };

  // Matte sets matte.
  S.setTool('matte');
  await S.stroke([[0, 0.02], [0, L() - 0.02]]);
  out.matte = S.coats()[S.info().finger].top;
  await S.settle();

  // Every nail glossed: the last flood has nowhere to go and stays.
  S.setTool('gloss');
  await S.clear();
  for (const id of [0, 1, 2, 3, 4]) { await S.goTo('nail', id); await S.stroke([[0, 0.02], [0, L() - 0.02]]); await S.settle(); }
  out.allGloss = S.coats().every((c) => c.top === 'gloss');

  // Jelly vs cream: the same single fast pass.
  const pass = async (polish) => {
    await S.clear(); S.setTool('polish'); S.setPolish(polish); S.setRequest(polish);
    for (const x of [-0.36, -0.12, 0.12, 0.36]) await S.stroke([[x, 0.03], [x, L() - 0.02]], { speed: 6 });
    return (await S.stats()).coverage;
  };
  out.cream = await pass('cream-pink');
  out.jelly = await pass('jelly-pink');
  return out;
});
await browser.close();

check('a short coat stroke does not flood', r.short.share < 0.5 && r.short.top === null && r.shortStayed, `touched ${f2(r.short.share)}, top ${r.short.top}`);
check('one stroke over half the nail: coat fills, topCoat set', r.flood.share >= 0.5 && r.flood.top === 'gloss', `touched ${f2(r.flood.share)} → coat 1.0, top ${r.flood.top}`);
check('after a flood the camera moves to the next nail', r.advancedTo === r.expected, `went to ${r.advancedTo}, expected ${r.expected}`);
check('base coat floods too', r.base === true, `base ${r.base}`);
check('a nail holds base and top coat together', r.both.base && r.both.top === 'gloss', JSON.stringify(r.both));
check('the remover takes the coats off; Oops puts them back', !r.removed.base && r.removed.top === null && r.undid && r.restored.base && r.restored.top === 'gloss', `${JSON.stringify(r.removed)} → ${JSON.stringify(r.restored)}`);
check('matte top coat', r.matte === 'matte', `${r.matte}`);
check('every nail glossed, ending on the last', r.allGloss, `${r.allGloss}`);
check('jelly counts as covered from a thinner film than cream', r.jelly > r.cream + 0.3, `one fast pass: cream ${f2(r.cream)}, jelly ${f2(r.jelly)}`);
process.exit(failed ? 1 : 0);
