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
await browser.close();
