// Lift test: the cabin really travels, the doors move, guests get on and off,
// the waiter can ride it, and the hotel does not gridlock.
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
// The Poki SDK is served from their CDN and logs a COOP warning over plain
// http on localhost. It is third-party and disappears on https / on Poki.
const IGNORE = /Cross-Origin-Opener-Policy|poki-sdk|poki\.com/i;
page.on('console', (m) => {
  // Some blocked third-party requests log only "net::ERR_FAILED", with the real
  // URL in the location, so check both.
  const url = (m.location() && m.location().url) || '';
  if (m.type() === 'error' && !IGNORE.test(m.text()) && !IGNORE.test(url)) {
    errors.push(m.text());
  }
});
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
  h.grantRebirths(20);      // so the upper floors exist at all
  h.give(5000000);
  h.unlockAll(3);
  h.setSpeed(3);
});

// --- 1. the cabin moves and the doors work ---------------------------------
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
// What matters is that it climbs at least a whole floor and is seen at many
// heights in between, which proves it travels rather than teleports. Demanding
// a specific top floor inside the sample window made this flaky: how far up it
// gets depends on where guests happen to be booked.
check('the cabin travels between floors',
      trace.levels.length > 6 && Math.max(...trace.levels) >= C.FLOOR_H,
      `heights seen: ${trace.levels.join(', ')}`);
check('it goes through every state (idle/closing/moving/opening)', trace.modes.length === 4,
      `states: ${trace.modes.join(',')}`);
check('the doors open and close gradually', trace.doors > 3, `${trace.doors} distinct positions`);
check('guests board the cabin', trace.peakRiders > 0, `peak of ${trace.peakRiders} passengers at once`);
await page.screenshot({ path: `${OUT}/30-lift.png` });

// --- 2. the waiter rides the lift ------------------------------------------
const ride = await page.evaluate(() => new Promise((res) => {
  const h = window.__hotel, p = h.player;
  p.x = -2.6; p.z = -5.5; p.floor = 0;             // step into the shaft on the ground floor
  const start = { floor: p.floor, y: p.y };
  // The lift serves other passengers too, so by the end it may have brought
  // him back down. What matters is the highest floor he reached, not where he
  // happens to be at the moment of measurement.
  let maxFloor = 0, maxY = 0, wasInCabin = false;
  const id = setInterval(() => {
    if (p.inCabin) wasInCabin = true;
    maxFloor = Math.max(maxFloor, p.floor);
    maxY = Math.max(maxY, p.y);
  }, 60);
  // Press the top floor button inside the cabin as often as needed.
  const press = setInterval(() => {
    if (p.inCabin) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit6', key: '6' }));
  }, 300);
  setTimeout(() => {
    clearInterval(id); clearInterval(press);
    res({ start, end: { floor: p.floor, y: +p.y.toFixed(2) },
          wasInCabin, maxFloor, maxY: +maxY.toFixed(2) });
  }, 14000);
}));
check('the waiter is detected inside the cabin', ride.wasInCabin, JSON.stringify(ride));
check('the waiter rides up', ride.maxFloor > 0 && ride.maxY > C.FLOOR_H - 0.5,
      `reached floor ${ride.maxFloor} (max y = ${ride.maxY}), came back down to ${ride.end.floor}`);
await page.screenshot({ path: `${OUT}/31-waiter-in-lift.png` });

// --- 3. the hotel does not choke --------------------------------------------
// Move the waiter out of the shaft so he does not hold the cabin, then watch
// for 40 seconds.
await page.evaluate(() => { const p = window.__hotel.player; p.x = 20; p.z = 0; p.floor = 0; });
const sample = () => page.evaluate(() => {
  const h = window.__hotel;
  let occ = 0;
  for (let r = 0; r < h.config.TOTAL_ROOMS; r++) if (h.rooms.occupant[r] >= 0) occ++;
  return { occ, total: h.config.TOTAL_ROOMS,
           guests: +document.getElementById('st-guests').textContent, money: h.state.money };
});
const a = await sample();
// Occupancy swings from moment to moment now that rooms go dirty between
// guests, so watch the whole window and judge on the peak rather than on
// whichever instant the sample happens to land in.
const peak = await page.evaluate(() => new Promise((res) => {
  const h = window.__hotel;
  let best = 0;
  const id = setInterval(() => {
    let occ = 0;
    for (let r = 0; r < h.config.TOTAL_ROOMS; r++) if (h.rooms.occupant[r] >= 0) occ++;
    if (occ > best) best = occ;
  }, 400);
  setTimeout(() => { clearInterval(id); res(best); }, 40000);
}));
const b = await sample();
console.log('  after 40s:', JSON.stringify(a), '->', JSON.stringify(b));
check('rooms stay occupied (the lift keeps up)', peak >= b.total * 0.5,
      `peak ${peak}/${b.total} occupied, ${b.occ} at the end`);
check('money keeps going up', b.money > a.money, `$${Math.round(a.money)} -> $${Math.round(b.money)}`);
check('stuck guests do not pile up forever', b.guests < 260, `${b.guests} guests in the hotel`);
await page.screenshot({ path: `${OUT}/32-traffic.png` });

await browser.close();
if (errors.length) {
  console.error('\nCONSOLE ERRORS:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  failures++;
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
