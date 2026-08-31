// Progression test: rebirth -> boosters, new floors at 10/15/20 rebirths, then
// prestige multiplying the boosters by 10.
//   node tools/rebirth.mjs [url]
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

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const snap = () => page.evaluate(() => {
  const h = window.__hotel;
  let unlocked = 0;
  for (let r = 0; r < h.config.TOTAL_ROOMS; r++) if (h.rooms.level[r] > 0) unlocked++;
  const avail = [];
  for (let f = 0; f < h.config.FLOORS; f++) if (h.floorAvailable(f)) avail.push(f);
  const tabs = [...document.querySelectorAll('#floors button')]
    .filter((b) => b.style.display !== 'none').length;
  return {
    boosters: h.state.boosters, rebirths: h.state.rebirths, prestige: h.state.prestige,
    money: Math.round(h.state.money), earned: Math.round(h.state.totalEarned),
    unlocked, avail, tabs,
    mult: +((1 + h.state.boosters * h.config.BOOST_BONUS)).toFixed(2),
    payout5: h.payout(5),
    guests: +document.getElementById('st-guests').textContent,
    rebirthBtn: document.getElementById('rebirth').textContent,
    rebirthOff: document.getElementById('rebirth').disabled,
    prestigeShown: document.getElementById('prestige').style.display !== 'none',
    nextFloor: document.getElementById('next-floor').textContent,
  };
});

/** Rebirth n times in a row, handing it the required earnings each time. */
const rebirthTimes = (n) => page.evaluate((count) => {
  const h = window.__hotel;
  for (let i = 0; i < count; i++) {
    h.state.totalEarned = h.config.REBIRTH_BASE * (1 + h.state.rebirths * h.config.REBIRTH_STEP);
    h.rebirth();
  }
}, n).then(() => page.waitForTimeout(400));   // let the HUD refresh

// --- 1. start ---------------------------------------------------------------
const start = await snap();
check('you cannot rebirth right away', start.rebirthOff && start.boosters === 0, JSON.stringify(start.rebirthBtn));
check('only 3 levels exist at the start', start.avail.join(',') === '0,1,2' && start.tabs === 3,
      `available: [${start.avail}], tabs: ${start.tabs}`);
check('prestige is hidden', !start.prestigeShown);
check('it says when floor 3 appears', /Floor 3 appears at 10/.test(start.nextFloor), start.nextFloor);
await page.screenshot({ path: `${OUT}/40-start.png` });

// --- 2. the first rebirth, through the HUD button ---------------------------
await page.evaluate(() => {
  const h = window.__hotel;
  h.give(500000);
  h.unlockAll(3);
  h.state.totalEarned = 20000;
});
await page.waitForTimeout(500);
const ready = await snap();
check('the button unlocks once you have earned enough',
      !ready.rebirthOff && /\+1 booster/.test(ready.rebirthBtn), ready.rebirthBtn);

await page.click('#rebirth');
await page.waitForTimeout(250);
const armedSnap = await snap();
check('the first click asks for confirmation', /Sure/.test(armedSnap.rebirthBtn) && armedSnap.boosters === 0,
      armedSnap.rebirthBtn);
await page.waitForTimeout(5000);
check('the confirmation expires by itself', !/Sure/.test((await snap()).rebirthBtn));

await page.click('#rebirth');
await page.waitForTimeout(250);
await page.click('#rebirth');
await page.waitForTimeout(1200);
const one = await snap();
check('a rebirth grants exactly one booster', one.boosters === 1 && one.rebirths === 1, JSON.stringify(one.boosters));
check('the hotel resets to 2 rooms', one.unlocked === 2, `${one.unlocked} rooms`);
check('the run earnings start from zero', one.earned === 0, `$${one.earned}`);
check('the bonus applies: level 5 pays $25 instead of $20', one.payout5 === 25, `$${one.payout5}`);

// --- 3. the new floors at 10 / 15 / 20 rebirths -----------------------------
await rebirthTimes(9);
const at10 = await snap();
check('floor 3 appears at 10 rebirths', at10.rebirths === 10 && at10.avail.includes(3),
      `rebirths ${at10.rebirths}, available [${at10.avail}]`);
check('floor 4 does not exist yet', !at10.avail.includes(4), `[${at10.avail}]`);

await rebirthTimes(5);
const at15 = await snap();
check('floor 4 appears at 15 rebirths', at15.avail.includes(4) && !at15.avail.includes(5),
      `rebirths ${at15.rebirths}, available [${at15.avail}]`);

await rebirthTimes(5);
const at20 = await snap();
check('floor 5 appears at 20 rebirths', at20.avail.includes(5) && at20.tabs === 6,
      `rebirths ${at20.rebirths}, tabs ${at20.tabs}`);
check('prestige unlocks at exactly that point', at20.prestigeShown, 'the prestige button is visible');
check('20 boosters = +500% income', at20.boosters === 20 && at20.mult === 6, `x${at20.mult}`);
await page.screenshot({ path: `${OUT}/41-20-rebirths.png` });

// --- 4. prestige ------------------------------------------------------------
await page.click('#prestige');
await page.waitForTimeout(250);
await page.click('#prestige');
await page.waitForTimeout(1200);
const pres = await snap();
check('prestige multiplies the boosters by 10', pres.boosters === 200 && pres.prestige === 1,
      `${at20.boosters} -> ${pres.boosters} boosters`);
check('the rebirth counter restarts', pres.rebirths === 0, `${pres.rebirths} rebirths`);
check('the floors you earned stay', pres.avail.length === 6, `available [${pres.avail}]`);
check('the huge multiplier applies', pres.payout5 === 20 * 51, `level 5 payout = $${pres.payout5}`);
check('the hotel starts over clean', pres.unlocked === 2 && pres.earned === 0,
      `${pres.unlocked} rooms, $${pres.earned} earned`);
await page.screenshot({ path: `${OUT}/42-prestige.png` });

// --- 5. the game keeps running ---------------------------------------------
await page.evaluate(() => window.__hotel.setSpeed(3));
const m0 = (await snap()).money;
await page.waitForTimeout(12000);
const later = await snap();
check('the game runs normally after prestige', later.money > m0 && later.guests > 0,
      `$${m0} -> $${later.money}, ${later.guests} guests`);
await page.screenshot({ path: `${OUT}/43-restarted.png` });

await browser.close();
if (errors.length) {
  console.error('\nCONSOLE ERRORS:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  failures++;
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
