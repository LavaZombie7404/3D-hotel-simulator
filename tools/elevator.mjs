// Testul liftului: cabina chiar circula, usile se misca, oaspetii urca si
// coboara, chelnerul poate merge cu el, iar hotelul nu se blocheaza.
//   node tools/elevator.mjs [url]
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

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

await page.evaluate(() => {
  const h = window.__hotel;
  h.give(500000);
  for (let f = 0; f < 3; f++) h.unlockFloor(f);
  for (let r = 0; r < h.rooms.level.length; r++) h.unlockRoom(r);
  for (let r = 0; r < 24; r++) for (let i = 0; i < 3; i++) h.upgradeRoom(r);
  h.setSpeed(3);
});

// --- 1. cabina se misca si usile lucreaza ----------------------------------
const trace = await page.evaluate(() => new Promise((res) => {
  const h = window.__hotel, ys = new Set(), modes = new Set(), doors = new Set();
  let peakRiders = 0;
  const id = setInterval(() => {
    ys.add(+h.lift.y.toFixed(1));
    modes.add(h.lift.mode);
    doors.add(+h.lift.doorT.toFixed(1));
    peakRiders = Math.max(peakRiders, h.lift.riders);
  }, 80);
  setTimeout(() => {
    clearInterval(id);
    res({ levels: [...ys].sort((a, b) => a - b), modes: [...modes].sort(), doors: doors.size, peakRiders });
  }, 18000);
}));
check('cabina circula intre etaje', trace.levels.length > 3 && Math.max(...trace.levels) >= 4,
      `inaltimi vazute: ${trace.levels.join(', ')}`);
check('trece prin toate starile (idle/inchide/merge/deschide)', trace.modes.length === 4,
      `stari: ${trace.modes.join(',')}`);
check('usile se deschid si se inchid gradual', trace.doors > 3, `${trace.doors} pozitii diferite`);
check('oaspetii urca in cabina', trace.peakRiders > 0, `maxim ${trace.peakRiders} pasageri simultan`);
await page.screenshot({ path: `${OUT}/30-lift.png` });

// --- 2. chelnerul merge cu liftul ------------------------------------------
const ride = await page.evaluate(() => new Promise((res) => {
  const h = window.__hotel, p = h.player;
  p.x = -2.6; p.z = 0; p.floor = 0;             // intra in put la parter
  const start = { floor: p.floor, y: p.y };
  let rodeUp = false, wasInCabin = false;
  const id = setInterval(() => {
    if (p.inCabin) {
      wasInCabin = true;
      if (h.lift.mode === 0 && h.lift.floor === 0) h.lift.__ = 0;   // no-op
    }
    if (p.floor > 0) rodeUp = true;
  }, 60);
  // Apasa butonul de etaj 2 din cabina de cate ori e nevoie.
  const press = setInterval(() => {
    if (p.inCabin) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', key: '3' }));
  }, 300);
  setTimeout(() => {
    clearInterval(id); clearInterval(press);
    res({ start, end: { floor: p.floor, y: +p.y.toFixed(2) }, wasInCabin, rodeUp });
  }, 14000);
}));
check('chelnerul e detectat in cabina', ride.wasInCabin, JSON.stringify(ride));
check('chelnerul urca cu liftul', ride.rodeUp && ride.end.floor > 0,
      `etaj ${ride.start.floor} -> ${ride.end.floor} (y = ${ride.end.y})`);
await page.screenshot({ path: `${OUT}/31-chelner-in-lift.png` });

// --- 3. hotelul nu se sufoca -----------------------------------------------
// Il scoatem pe chelner din put ca sa nu tina cabina si masuram 40 de secunde.
await page.evaluate(() => { const p = window.__hotel.player; p.x = 20; p.z = 0; p.floor = 0; });
const sample = () => page.evaluate(() => {
  const h = window.__hotel;
  let occ = 0;
  for (let r = 0; r < 24; r++) if (h.rooms.occupant[r] >= 0) occ++;
  return { occ, guests: +document.getElementById('st-guests').textContent, money: h.state.money };
});
const a = await sample();
await page.waitForTimeout(40000);
const b = await sample();
console.log('  dupa 40s:', JSON.stringify(a), '->', JSON.stringify(b));
check('camerele raman ocupate (liftul face fata)', b.occ >= 16, `${b.occ}/24 ocupate`);
check('banii continua sa creasca', b.money > a.money, `$${Math.round(a.money)} -> $${Math.round(b.money)}`);
check('nu se aduna la infinit oaspeti blocati', b.guests < 140, `${b.guests} oaspeti in hotel`);
await page.screenshot({ path: `${OUT}/32-trafic.png` });

await browser.close();
if (errors.length) {
  console.error('\nERORI IN CONSOLA:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  failures++;
}
console.log(failures === 0 ? '\nToate verificarile au trecut.' : `\n${failures} verificari au picat.`);
process.exit(failures === 0 ? 0 : 1);
