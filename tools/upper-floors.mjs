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
  h.give(500000);
  for (let f = 0; f < 3; f++) h.unlockFloor(f);
  let unlocked = 0;
  for (let r = 0; r < h.rooms.level.length; r++) if (h.unlockRoom(r)) unlocked++;
  for (let r = 0; r < 8; r++) for (let i = 0; i < 5; i++) h.upgradeRoom(r);
  h.setSpeed(4);
  return { unlocked, floors: h.state.floorUnlocked.slice(), lvl0: h.rooms.level[0] };
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
  const h = window.__hotel, out = [];
  for (let f = 0; f < 3; f++) {
    let occ = 0, tot = 0;
    for (let r = f * 8; r < f * 8 + 8; r++) { if (h.rooms.level[r] > 0) tot++; if (h.rooms.occupant[r] >= 0) occ++; }
    out.push(`etaj ${f}: ${occ}/${tot} ocupate`);
  }
  return out;
});
console.log(perFloor.join('  |  '));

await page.evaluate(() => window.__hotel.focusFloor(1));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/11-etaj1.png` });

await page.evaluate(() => window.__hotel.focusFloor(2));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/12-etaj2.png` });

await page.waitForTimeout(12000);
console.log('final  :', await stats());
console.log((await page.evaluate(() => {
  const h = window.__hotel, out = [];
  for (let f = 0; f < 3; f++) {
    let occ = 0;
    for (let r = f * 8; r < f * 8 + 8; r++) if (h.rooms.occupant[r] >= 0) occ++;
    out.push(`etaj ${f}: ${occ}/8`);
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
