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

const C = await (async () => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  return page.evaluate(() => ({ FLOOR_H: window.__hotel.config.FLOOR_H }));
})();

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

await page.evaluate(() => {
  const h = window.__hotel;
  h.grantRebirths(20);      // ca sa existe si etajele de sus
  h.give(5000000);
  h.unlockAll(3);
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
check('cabina circula intre etaje', trace.levels.length > 3 && Math.max(...trace.levels) >= 8,
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
  // Liftul serveste si alti pasageri, deci pana la final poate sa-l fi adus
  // inapoi jos. Ne intereseaza cel mai sus etaj la care a ajuns, nu unde e
  // fix in momentul masuratorii.
  let maxFloor = 0, maxY = 0, wasInCabin = false;
  const id = setInterval(() => {
    if (p.inCabin) wasInCabin = true;
    maxFloor = Math.max(maxFloor, p.floor);
    maxY = Math.max(maxY, p.y);
  }, 60);
  // Apasa butonul de etaj 2 din cabina de cate ori e nevoie.
  const press = setInterval(() => {
    if (p.inCabin) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit6', key: '6' }));
  }, 300);
  setTimeout(() => {
    clearInterval(id); clearInterval(press);
    res({ start, end: { floor: p.floor, y: +p.y.toFixed(2) },
          wasInCabin, maxFloor, maxY: +maxY.toFixed(2) });
  }, 14000);
}));
check('chelnerul e detectat in cabina', ride.wasInCabin, JSON.stringify(ride));
check('chelnerul urca cu liftul', ride.maxFloor > 0 && ride.maxY > C.FLOOR_H - 0.5,
      `a ajuns pana la etajul ${ride.maxFloor} (y max = ${ride.maxY}), a coborat la ${ride.end.floor}`);
await page.screenshot({ path: `${OUT}/31-chelner-in-lift.png` });

// --- 3. hotelul nu se sufoca -----------------------------------------------
// Il scoatem pe chelner din put ca sa nu tina cabina si masuram 40 de secunde.
await page.evaluate(() => { const p = window.__hotel.player; p.x = 20; p.z = 0; p.floor = 0; });
const sample = () => page.evaluate(() => {
  const h = window.__hotel;
  let occ = 0;
  for (let r = 0; r < h.config.TOTAL_ROOMS; r++) if (h.rooms.occupant[r] >= 0) occ++;
  return { occ, total: h.config.TOTAL_ROOMS,
           guests: +document.getElementById('st-guests').textContent, money: h.state.money };
});
const a = await sample();
await page.waitForTimeout(40000);
const b = await sample();
console.log('  dupa 40s:', JSON.stringify(a), '->', JSON.stringify(b));
check('camerele raman ocupate (liftul face fata)', b.occ >= b.total * 0.5, `${b.occ}/${b.total} ocupate`);
check('banii continua sa creasca', b.money > a.money, `$${Math.round(a.money)} -> $${Math.round(b.money)}`);
check('nu se aduna la infinit oaspeti blocati', b.guests < 260, `${b.guests} oaspeti in hotel`);
await page.screenshot({ path: `${OUT}/32-trafic.png` });

await browser.close();
if (errors.length) {
  console.error('\nERORI IN CONSOLA:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  failures++;
}
console.log(failures === 0 ? '\nToate verificarile au trecut.' : `\n${failures} verificari au picat.`);
process.exit(failures === 0 ? 0 : 1);
