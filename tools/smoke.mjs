// Smoke test: load the game in Chromium, let the simulation run fast-forward,
// check the economy and take screenshots.
//   node tools/smoke.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:8080/';
const OUT = 'tools/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const canvas = await page.$('canvas');
if (!canvas) throw new Error('canvas missing - WebGL did not start');

const snap = () => page.evaluate(() => ({
  money: document.getElementById('money').textContent,
  income: document.getElementById('income').textContent,
  guests: document.getElementById('st-guests').textContent,
  occ: document.getElementById('st-occ').textContent,
  queue: document.getElementById('st-queue').textContent,
  served: document.getElementById('st-served').textContent,
  lost: document.getElementById('st-lost').textContent,
  perf: document.getElementById('perf').textContent,
}));

console.log('start  ', await snap());
await page.screenshot({ path: `${OUT}/01-start.png` });

// Fast-forwarded through the debug hook (the UI has no speed control).
await page.evaluate(() => window.__hotel.setSpeed(4));
await page.waitForTimeout(12000);
console.log('sped up ', await snap());
await page.screenshot({ path: `${OUT}/02-running.png` });

// Unlock and upgrade by clicking rooms: scan points until we hit one.
const clicked = await page.evaluate(async () => {
  const cv = document.querySelector('canvas');
  const rect = cv.getBoundingClientRect();
  const hit = (fx, fy) => {
    const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
    for (const type of ['pointerdown', 'pointerup']) {
      cv.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
      }));
    }
  };
  for (let fy = 0.30; fy <= 0.62; fy += 0.04) {
    for (let fx = 0.45; fx <= 0.82; fx += 0.04) {
      hit(fx, fy);
      await new Promise((r) => setTimeout(r, 60));
      if (document.getElementById('room-info').style.display !== 'none') {
        return { title: document.getElementById('room-title').textContent,
                 sub: document.getElementById('room-sub').textContent,
                 at: [fx.toFixed(2), fy.toFixed(2)] };
      }
    }
  }
  return null;
});
console.log('room selected:', clicked);
await page.screenshot({ path: `${OUT}/03-selected.png` });

// Press the action button a few times (unlock / upgrade).
for (let i = 0; i < 6; i++) {
  const btn = await page.$('#room-action:not([disabled])');
  if (!btn || !(await btn.isVisible())) break;
  await btn.click();
  await page.waitForTimeout(120);
}
console.log('after actions', await snap());

// Floor 2 (probably still locked -> check the button does not blow up).
await page.keyboard.press('2');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/04-floor.png` });

await page.waitForTimeout(8000);
const final = await snap();
console.log('final   ', final);
await page.screenshot({ path: `${OUT}/05-final.png` });

await browser.close();

if (errors.length) {
  console.error('\nCONSOLE ERRORS:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK - no console errors.');
