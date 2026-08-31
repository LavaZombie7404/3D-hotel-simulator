// Waiter test: movement, wall collisions, the lift, room service tips and the
// faster check-in you get by standing at the desk.
//   node tools/waiter.mjs [url]
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

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const pos = () => page.evaluate(() => {
  const p = window.__hotel.player;
  return { x: +p.x.toFixed(2), z: +p.z.toFixed(2), floor: p.floor, atDesk: p.atDesk };
});
const stats = () => page.evaluate(() => ({
  tips: window.__hotel.state.tips,
  served: window.__hotel.state.servedRequests,
  missed: window.__hotel.state.missedRequests,
  checkins: window.__hotel.state.servedGuests,
  activeFloor: window.__hotel.state.activeFloor,
}));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// Unlock everything, so there are guests in rooms on every floor.
await page.evaluate(() => {
  const h = window.__hotel;
  h.grantRebirths(20);      // so the upper floors exist at all
  h.give(5000000);
  h.unlockAll(3);
  h.setSpeed(2);
});

// --- 1. movement ------------------------------------------------------------
const before = await pos();
await page.keyboard.down('d');
await page.waitForTimeout(700);
await page.keyboard.up('d');
await page.waitForTimeout(150);
const after = await pos();
check('the waiter moves with the keys', Math.hypot(after.x - before.x, after.z - before.z) > 1.5,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

// --- 2. wall collisions -----------------------------------------------------
// Put him next to the wall behind the rooms and push into it.
await page.evaluate(() => {
  const p = window.__hotel.player;
  p.x = 9; p.z = 7.5; p.floor = 0;
});
// The camera looks from +Z, so screen "down" means +Z: walk into the outer
// wall behind the rooms on the north side.
await page.keyboard.down('ArrowDown');
await page.waitForTimeout(1400);
await page.keyboard.up('ArrowDown');
await page.waitForTimeout(150);
const wall = await pos();
// BUILD_Z = 9, so he must not get past about 8.6
check('does not pass through the outer wall', wall.z > 7 && wall.z < 8.8, `z = ${wall.z}`);

// --- 3. the lift ------------------------------------------------------------
await page.evaluate(() => {
  const p = window.__hotel.player;
  p.x = -2.6; p.z = 0; p.floor = 0;      // inside the lift cabin
});
await page.waitForTimeout(150);
await page.keyboard.press('e');
await page.waitForTimeout(1500);
const lifted = await pos();
const st1 = await stats();
check('the lift goes up one floor', lifted.floor === 1, `floor = ${lifted.floor}`);
check('the view follows the waiter', st1.activeFloor === 1, `floor shown = ${st1.activeFloor}`);
await page.screenshot({ path: `${OUT}/20-lift.png` });

// --- 4. room service --------------------------------------------------------
// Walk the waiter through every room on floor 1, in a loop, for ~25 seconds.
const tipsBefore = (await stats()).tips;
await page.evaluate(async () => {
  const h = window.__hotel, p = h.player;
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 25000) {
    const n = h.config.ROOMS_PER_FLOOR;
    const r = n + (i++ % n);                       // rooms on floor 1
    p.x = h.rooms.cx[r]; p.z = h.rooms.cz[r]; p.floor = 1;
    await new Promise((res) => setTimeout(res, 260));
  }
});
const st2 = await stats();
check('the waiter collects tips', st2.tips > tipsBefore,
      `tips ${tipsBefore} -> ${st2.tips}, requests served ${st2.served}`);
await page.screenshot({ path: `${OUT}/21-roomservice.png` });

// --- 5. the reception boost -------------------------------------------------
// Count check-ins over 10 seconds away from the desk, then inside the circle.
const rate = async (atDesk) => {
  await page.evaluate((d) => {
    const h = window.__hotel, p = h.player;
    p.floor = 0;
    if (d) { p.x = -10; p.z = 4.2; } else { p.x = 20; p.z = 0; }
  }, atDesk);
  await page.waitForTimeout(600);
  const a = (await stats()).checkins;
  await page.waitForTimeout(10000);
  const b = (await stats()).checkins;
  return b - a;
};
const away = await rate(false);
const desk = await rate(true);
check('check-in is faster at the desk', desk > away, `${away} vs ${desk} check-ins / 10s`);
const deskPos = await pos();
check('the reception circle activates', deskPos.atDesk === true, JSON.stringify(deskPos));
await page.screenshot({ path: `${OUT}/22-reception.png` });

await browser.close();

if (errors.length) {
  console.error('\nCONSOLE ERRORS:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  failures++;
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
