// Screenshot fixed scenes in Playwright WebKit (matches Safari).
// Usage: node tests/shot.mjs name=query [name=query …]   e.g.  nail="scene=nail&debug"
// Needs `npm run serve` (port 8813). Shots go to tests/shots/ (gitignored).
import { webkit } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
const jobs = process.argv.slice(2).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; });
if (!jobs.length) jobs.push(['nail', 'scene=nail'], ['hand', 'scene=hand']);
mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const [name, query] of jobs) {
  await page.goto(`${BASE}?${query}`);
  await page.evaluate(() => window.__salon.ready);
  const paint = process.env.PAINT;
  if (paint) await page.evaluate(paint);
  await page.evaluate(() => window.__salon.nextFrame().then(() => window.__salon.nextFrame()));
  const clip = process.env.CLIP ? JSON.parse(process.env.CLIP) : undefined;
  await page.screenshot({ path: new URL(`./shots/${name}.png`, import.meta.url).pathname, clip });
  console.log(name, JSON.stringify(await page.evaluate(() => window.__salon.info())));
}
// SHEET=name COLS=5: tile this run's shots into tests/shots/name.png to look at them together.
if (process.env.SHEET) {
  const cols = Number(process.env.COLS || 5), w = 460, h = Math.round(w * 820 / 1180);
  const sheet = await browser.newPage({ viewport: { width: w * cols, height: h * Math.ceil(jobs.length / cols) } });
  await sheet.setContent(`<body style="margin:0;display:grid;grid-template-columns:repeat(${cols},${w}px);font:12px Helvetica">${jobs.map(([n]) => `<div style="position:relative;height:${h}px"><img src="${BASE}tests/shots/${n}.png?${Date.now()}" width="${w}"><b style="position:absolute;left:4px;top:2px">${n}</b></div>`).join('')}</body>`, { waitUntil: 'networkidle' });
  await sheet.screenshot({ path: new URL(`./shots/${process.env.SHEET}.png`, import.meta.url).pathname });
}
await browser.close();
