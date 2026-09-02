// Checks the two automation features: hired staff doing the rounds without the
// player, and the restaurant feeding departing guests.
//   node tools/staff-restaurant.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:8080/?debug';
const OUT = 'tools/shots';
mkdirSync(OUT, { recursive: true });

const IGNORE = /Cross-Origin-Opener-Policy|poki-sdk|poki\.com/i;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 850 } });
const errors = [];
page.on('console', (m) => {
  const url = (m.location() && m.location().url) || '';
  if (m.type() === 'error' && !IGNORE.test(m.text()) && !IGNORE.test(url)) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const snap = () => page.evaluate(() => {
  const h = window.__hotel;
  return {
    cleaned: h.state.roomsCleaned,
    served: h.state.servedRequests,
    meals: h.state.meansServed,
    restLevel: h.state.restaurantLevel,
    money: Math.round(h.state.money),
    porters: h.staffOnFloor(0, 0),
    cleaners: h.staffOnFloor(0, 1),
    dirty: +document.getElementById('st-dirty').textContent,
  };
});

// --- 1. staff cannot be hired without the money ------------------------------
const broke = await page.evaluate(() => {
  const before = window.__hotel.staffOnFloor(0, 0);
  window.__hotel.hire(0, 0);
  return { before, after: window.__hotel.staffOnFloor(0, 0), money: window.__hotel.state.money };
});
check('you cannot hire with an empty till', broke.after === broke.before,
      `$${Math.round(broke.money)}, ${broke.after} porters`);

// --- 2. build the hotel up ---------------------------------------------------
await page.evaluate(() => {
  const h = window.__hotel;
  h.give(500000);
  h.unlockAll(4);
  h.setSpeed(3);
  // The waiter is parked far away so anything that gets done is the staff.
  h.player.x = 20; h.player.z = 0; h.player.floor = 0;
});
await page.waitForTimeout(20000);

// --- 3. staff work a floor on their own --------------------------------------
const beforeStaff = await snap();
await page.evaluate(() => {
  const h = window.__hotel;
  h.hire(0, 0); h.hire(0, 0);
  h.hire(0, 1); h.hire(0, 1);
});
const hired = await snap();
check('porters and cleaners get hired', hired.porters === 2 && hired.cleaners === 2,
      `${hired.porters} porters, ${hired.cleaners} cleaners`);

await page.waitForTimeout(25000);
const afterStaff = await snap();
check('cleaners clear rooms with no player help', afterStaff.cleaned > beforeStaff.cleaned,
      `${beforeStaff.cleaned} -> ${afterStaff.cleaned} rooms cleaned`);
check('porters answer room service on their own', afterStaff.served > beforeStaff.served,
      `${beforeStaff.served} -> ${afterStaff.served} requests served`);
await page.screenshot({ path: `${OUT}/70-staff.png` });

// --- 4. the restaurant feeds departing guests --------------------------------
check('no meals before it is built', afterStaff.meals === 0 && afterStaff.restLevel === 0,
      `level ${afterStaff.restLevel}, ${afterStaff.meals} meals`);

// Click until it reaches level 4 rather than assuming every click of exactly
// four lands. Whether a click is swallowed by a HUD repaint is a timing detail
// of the test harness, not something the game promises.
const TARGET_LEVEL = 4;
for (let i = 0; i < 20; i++) {
  if ((await snap()).restLevel >= TARGET_LEVEL) break;
  await page.waitForTimeout(300);
  await page.click('#restaurant');
}
const built = await snap();
check(`the restaurant reaches level ${TARGET_LEVEL}`, built.restLevel === TARGET_LEVEL,
      `level ${built.restLevel}`);

// The instanced tables are rebuilt on the frame after the purchase, not inside
// the click, so give the renderer a moment before reading the count.
const tables = await page.evaluate(async () => {
  const m = await import('/src/build.js');
  const want = 8;
  for (let i = 0; i < 40; i++) {
    if (m.gfx.tables.count === want) break;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return m.gfx.tables.count;
});
check('tables appear with the level', tables === 8, `${tables} tables drawn`);

await page.waitForTimeout(30000);
const dined = await snap();
check('guests eat and pay on the way out', dined.meals > 0, `${dined.meals} meals served`);
check('the restaurant adds income', dined.money > built.money,
      `$${built.money} -> $${dined.money}`);
await page.screenshot({ path: `${OUT}/71-restaurant.png` });

// --- 5. all of it survives a reload ------------------------------------------
await page.evaluate(() => window.__hotel.save());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const reloaded = await snap();
check('staff survive a reload', reloaded.porters === 2 && reloaded.cleaners === 2,
      `${reloaded.porters} porters, ${reloaded.cleaners} cleaners`);
check('the restaurant survives a reload', reloaded.restLevel === 4, `level ${reloaded.restLevel}`);

await browser.close();
if (errors.length) {
  console.error('\nCONSOLE ERRORS:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  failures++;
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
