// Test pentru etajele superioare: deblocheaza etajul 1 si 2, umple camerele
// si verifica faptul ca oaspetii chiar ajung sus cu liftul si se cazeaza.
//   node tools/upper-floors.mjs [url]
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
await page.waitForTimeout(1200);

// Bani + toate etajele si camerele deblocate, cateva urcate la nivel mare.
const setup = await page.evaluate(() => {
  const h = window.__hotel;
  h.grantRebirths(20);      // ca sa existe si etajele de sus
  h.give(5000000);
  h.unlockAll(3);
  h.setSpeed(4);
  let unlocked = 0;
  for (let r = 0; r < h.config.TOTAL_ROOMS; r++) if (h.rooms.level[r] > 0) unlocked++;
  return { unlocked, etaje: h.config.FLOORS, floors: h.state.floorUnlocked.slice() };
});
console.log('setup:', setup);

const stats = () => page.evaluate(() => ({
  money: document.getElementById('money').textContent,
  income: document.getElementById('income').textContent,
  occ: document.getElementById('st-occ').textContent,
  guests: document.getElementById('st-guests').textContent,
  lost: document.getElementById('st-lost').textContent,
  perf: document.getElementById('perf').textContent,
}));

await page.waitForTimeout(20000);
console.log('parter :', await stats());
await page.screenshot({ path: `${OUT}/10-parter.png` });

// Ocuparea pe etaje, citita direct din starea simularii.
const perFloor = await page.evaluate(() => {
  const h = window.__hotel, n = h.config.ROOMS_PER_FLOOR, out = [];
  for (let f = 0; f < h.config.FLOORS; f++) {
    let occ = 0, tot = 0;
    for (let r = f * n; r < f * n + n; r++) { if (h.rooms.level[r] > 0) tot++; if (h.rooms.occupant[r] >= 0) occ++; }
    out.push(`E${f}: ${occ}/${tot}`);
  }
  return out;
});
console.log(perFloor.join('  |  '));

await page.evaluate(() => window.__hotel.focusFloor(3));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/11-etaj3.png` });

await page.evaluate(() => window.__hotel.focusFloor(5));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/12-etaj5.png` });

await page.waitForTimeout(12000);
console.log('final  :', await stats());
console.log((await page.evaluate(() => {
  const h = window.__hotel, n = h.config.ROOMS_PER_FLOOR, out = [];
  for (let f = 0; f < h.config.FLOORS; f++) {
    let occ = 0;
    for (let r = f * n; r < f * n + n; r++) if (h.rooms.occupant[r] >= 0) occ++;
    out.push(`E${f}: ${occ}/${n}`);
  }
  return out;
})).join('  |  '));
await page.screenshot({ path: `${OUT}/13-final.png` });

await browser.close();
if (errors.length) {
  console.error('\nERORI:'); for (const e of errors.slice(0, 20)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK — fara erori in consola.');
