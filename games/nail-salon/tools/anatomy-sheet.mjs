// The anatomy sheet (PLAN §3.2, M0.8): our nail, bare and in one coat of red cream, beside real
// photos. Clay signs this off at Gate M0.
// Usage (with `npm run serve` running): node tools/anatomy-sheet.mjs <output dir>
// <output dir>/refs/ holds the reference photos; they never go in this repo. The page is built
// from the design-kit's no-build starter and opens as a local file.
import { webkit } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const out = resolve(process.argv[2] || '.');
const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
const STARTER = join(homedir(), 'Documents/Repositories/design-kit/starters/no-build/index.html');
mkdirSync(join(out, 'ours'), { recursive: true });

const fingers = [[0, 'Thumb'], [1, 'Pointer finger'], [2, 'Middle finger']];
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const clip = { x: 240, y: 30, width: 700, height: 760 };

for (const [finger] of fingers) {
  await page.goto(`${BASE}?scene=nail&finger=${finger}&flip=1`);
  await page.addStyleTag({ content: '#bottle, #turn { display: none !important; }' });
  await page.evaluate(() => window.__salon.ready);
  await page.evaluate(() => window.__salon.nextFrame());
  await page.screenshot({ path: join(out, `ours/bare-${finger}.png`), clip });
  const st = await page.evaluate(async () => {
    const S = window.__salon, L = S.info().length;
    await S.clear(); S.setPolish('cream-red'); S.setRequest('cream-red');
    for (const x of [-0.36, -0.12, 0.12, 0.36]) await S.stroke([[x, 0.03], [x, L - 0.02]], { speed: 1.0 });
    await S.advance(20);
    await S.nextFrame();
    return S.stats();
  });
  await page.screenshot({ path: join(out, `ours/red-${finger}.png`), clip });
  console.log(`finger ${finger}: coverage ${st.coverage.toFixed(3)} spill ${st.spill.toFixed(3)}`);
}

const refs = [
  ['bare-label.jpg', 'Real thumb, labelled. Fingernail label, by Kipton, Wikimedia Commons, public domain.'],
  ['bare-thumb.jpg', 'Real thumb. Nail(thumb), by F.G. comm, Wikimedia Commons, CC BY-SA 4.0.'],
  ['bare-fingers.jpg', 'Real fingers. Fingernails, Wikimedia Commons, public domain.'],
  ['red-neon.jpg', 'Real polish, one bright cream coat. Neon nail polish, by Maria Morri, Wikimedia Commons, CC BY-SA 2.0.'],
];
const checks = [
  'The skin overlaps the nail at the cuticle and both sides, by a hair.',
  'The skin darkens slightly going into the grooves.',
  'A soft U at the cuticle, with a thin see-through rim.',
  'The half-moon is paler and clearest on the thumb.',
  'Pink bed, then a whitish band, then a paler free edge.',
  'One coat of red looks like polish, sitting inside the same folds.',
];
const figure = (src, caption) => `<figure class="overflow-hidden rounded-xl bg-surface-raised">
  <img src="${src}" alt="${caption}" class="block aspect-[7/7.6] w-full object-cover object-right">
  <figcaption class="px-3 py-2 text-sm text-ink-muted">${caption}</figcaption>
</figure>`;
const body = `<body class="min-h-dvh bg-surface text-ink">
  <main class="mx-auto max-w-5xl px-6 py-12">
    <h1 class="text-3xl font-semibold tracking-tight">Nail anatomy sheet</h1>
    <p class="mt-3 max-w-2xl text-ink-muted">Our nail beside real ones, for sign-off at Gate M0. The renders are fingertips-up so they sit the same way as the photos, one coat of cream red, dried.</p>
    <h2 class="mt-10 text-xl font-semibold">Ours</h2>
    <div class="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3">
      ${fingers.map(([f, n]) => figure(`ours/bare-${f}.png`, `${n}, bare`)).join('\n')}
      ${fingers.map(([f, n]) => figure(`ours/red-${f}.png`, `${n}, red cream`)).join('\n')}
    </div>
    <h2 class="mt-10 text-xl font-semibold">Real nails</h2>
    <div class="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
      ${refs.map(([src, c]) => figure(`refs/${src}`, c)).join('\n')}
    </div>
    <h2 class="mt-10 text-xl font-semibold">What to judge</h2>
    <ul class="mt-3 list-disc space-y-1 pl-5 text-ink-muted">
      ${checks.map((c) => `<li>${c}</li>`).join('\n')}
    </ul>
  </main>
</body>`;

const page2 = readFileSync(STARTER, 'utf8').replace(/<title>.*?<\/title>/, '<title>Nail Anatomy Sheet</title>').replace(/<body[\s\S]*<\/body>/, body);
writeFileSync(join(out, 'index.html'), page2);

const check = await browser.newPage({ viewport: { width: 1180, height: 900 } });
await check.goto(`file://${join(out, 'index.html')}`, { waitUntil: 'networkidle' });
await check.screenshot({ path: join(out, 'sheet.png'), fullPage: true });
await browser.close();
console.log(`wrote ${join(out, 'index.html')}`);
