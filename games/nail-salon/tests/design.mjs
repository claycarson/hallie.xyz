// M1.2: applyDesign (PLAN §4.7). test-red on all five nails reads as fully covered, the right
// colour and finish, with no spill; a design replaces what was painted; old polish is chipped;
// the accent nail gets its own polish; the shape comes with the design; the nail is dry.
// Needs `npm run serve`. Part of `npm run robot`.
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const f2 = (v) => v.toFixed(2);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${BASE}?scene=hand&design=test-red`);
await page.evaluate(() => window.__salon.ready);
const r = await page.evaluate(async () => {
  const S = window.__salon, out = {};
  out.red = await S.statsAll();
  out.wet = S.wetLeft();
  out.records = S.records();

  // A design replaces paint: scribble on a nail, then apply again.
  await S.goTo('nail', 2);
  S.setPolish('cream-black');
  await S.stroke([[0, 0.5], [0.9, 0.6]]);                        // from the nail out onto the skin
  out.scribbled = (await S.statsAll())[2];
  await S.applyDesign('test-red');
  out.again = (await S.statsAll())[2];

  // Old polish: the same design, chipped.
  await S.applyDesign('test-red', { chipped: 0.6 });
  out.chipped = await S.statsAll();
  out.chippedRec = S.records()[0].oldPolish;

  // Accent: lilac everywhere, gold glitter on finger 3.
  S.setRequest('glitter-gold');
  await S.applyDesign('test-accent');
  out.accent = await S.statsAll();

  // Shape comes with the design.
  S.setRequest('chrome-silver');
  await S.applyDesign('test-chrome');
  out.shape = S.info().shape;
  out.chrome = await S.statsAll();

  // Bare clears every nail.
  await S.applyDesign('test-bare');
  out.bare = await S.statsAll();
  return out;
});
await browser.close();

const all = (arr, fn) => arr.every(fn);
check('test-red: five nails fully covered', all(r.red, (s) => s.coverage >= 0.99), `coverage ${r.red.map((s) => f2(s.coverage)).join(' ')}`);
check('test-red: no spill', all(r.red, (s) => s.spill < 0.005), `spill ${r.red.map((s) => s.spill.toFixed(3)).join(' ')}`);
check('test-red: colour and finish match red cream', all(r.red, (s) => s.colorMatch >= 0.99 && s.finishMatch >= 0.99), `colour ${r.red.map((s) => f2(s.colorMatch)).join(' ')} finish ${r.red.map((s) => f2(s.finishMatch)).join(' ')}`);
check('test-red: perfectly even and dry', all(r.red, (s) => s.evenness >= 0.98) && r.wet === 0, `even ${r.red.map((s) => f2(s.evenness)).join(' ')} wet ${r.wet}`);
check('each nail keeps a record', r.records.every((x, i) => x && x.finger === i && x.polish === 'cream-red' && x.dry), JSON.stringify(r.records[0]));
check('a design replaces what was painted (spill and black gone)', r.scribbled.spill > 0.01 && r.scribbled.colorMatch < 0.9 && r.again.spill < 0.005 && r.again.colorMatch >= 0.99, `spill ${r.scribbled.spill.toFixed(3)} → ${r.again.spill.toFixed(3)}, colour ${f2(r.scribbled.colorMatch)} → ${f2(r.again.colorMatch)}`);
check('old polish is chipped, not gone', all(r.chipped, (s) => s.coverage > 0.6 && s.coverage < 0.97) && r.chippedRec, `coverage ${r.chipped.map((s) => f2(s.coverage)).join(' ')}`);
check('accent: only finger 3 is gold glitter', r.accent[3].colorMatch >= 0.99 && r.accent[3].finishMatch >= 0.99 && [0, 1, 2, 4].every((i) => r.accent[i].colorMatch < 0.01), `colour ${r.accent.map((s) => f2(s.colorMatch)).join(' ')}`);
check('the design sets the shape (almond) and covers it', r.shape === 'almond' && all(r.chrome, (s) => s.coverage >= 0.99 && s.finishMatch >= 0.99 && s.spill < 0.005), `shape ${r.shape}, coverage ${r.chrome.map((s) => f2(s.coverage)).join(' ')}`);
check('a bare design clears every nail', all(r.bare, (s) => s.coverage === 0 && s.spill === 0), `coverage ${r.bare.map((s) => f2(s.coverage)).join(' ')}`);
process.exit(failed ? 1 : 0);
