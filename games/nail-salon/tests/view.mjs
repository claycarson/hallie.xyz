// Screenshot tools/hand-view.html. Usage: node tests/view.mjs name="dir=0,0,1&span=0.25" …
// Needs `npm run serve`. Shots go to tests/shots/.
import { webkit } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8813/';
const size = Number(process.env.SIZE || 800);
mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const arg of process.argv.slice(2)) {
  const i = arg.indexOf('='), name = arg.slice(0, i);
  await page.goto(`${BASE}tools/hand-view.html?${arg.slice(i + 1)}`);
  await page.waitForFunction(() => window.__done);
  await page.screenshot({ path: new URL(`./shots/${name}.png`, import.meta.url).pathname });
  console.log(name, JSON.stringify(await page.evaluate(() => window.__done.box)));
}
await browser.close();
