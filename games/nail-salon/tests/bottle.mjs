// The bottle: the brush runs low as it paints, the bottle shows it, and a tap refills it.
// Needs `npm run serve`.
import { webkit } from 'playwright';
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto((process.env.BASE || 'http://127.0.0.1:8813/') + '?scene=nail');
await page.evaluate(() => window.__salon.ready);
const read = () => page.evaluate(async () => {
  await window.__salon.nextFrame(); await window.__salon.nextFrame();
  const b = document.getElementById('bottle');
  return { load: window.__salon.info().load, low: b.classList.contains('low'), level: b.querySelector('.level').style.transform };
});
let failed = 0;
const check = (name, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(d)}`); if (!ok) failed++; };
await page.evaluate(async () => {
  const S = window.__salon, L = S.info().length;
  for (let i = 0; i < 9; i++) await S.stroke([[0, 0.06], [0, L - 0.03]], { speed: 0.8, dip: false });
});
let r = await read();
check('nine lengths of stroke empty the brush and the bottle pulses', r.load === 0 && r.low, r);
await page.locator('#bottle').tap().catch(() => page.locator('#bottle').click());
r = await read();
check('a tap on the bottle refills the brush', r.load === 1 && !r.low, r);
await browser.close();
process.exit(failed ? 1 : 0);
