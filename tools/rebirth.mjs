// Testul progresiei: renastere -> boostere, etaje noi la 10/15/20 renasteri,
// apoi prestigiu care inmulteste boosterii cu 10.
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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

/** Cate renasteri la rand, dandu-i de fiecare data castigul necesar. */
const rebirthTimes = (n) => page.evaluate((count) => {
  const h = window.__hotel;
  for (let i = 0; i < count; i++) {
    h.state.totalEarned = h.config.REBIRTH_BASE * (1 + h.state.rebirths * h.config.REBIRTH_STEP);
    h.rebirth();
  }
}, n).then(() => page.waitForTimeout(400));   // lasa HUD-ul sa se reimprospateze

// --- 1. start ---------------------------------------------------------------
const start = await snap();
check('nu poti renaste din prima', start.rebirthOff && start.boosters === 0, JSON.stringify(start.rebirthBtn));
check('la inceput sunt doar 3 niveluri', start.avail.join(',') === '0,1,2' && start.tabs === 3,
      `disponibile: [${start.avail}], taburi: ${start.tabs}`);
check('prestigiul e ascuns', !start.prestigeShown);
check('scrie cand apare etajul 3', /Etaj 3 apare la 10/.test(start.nextFloor), start.nextFloor);
await page.screenshot({ path: `${OUT}/40-start.png` });

// --- 2. prima renastere, prin butonul din HUD -------------------------------
await page.evaluate(() => {
  const h = window.__hotel;
  h.give(500000);
  h.unlockAll(3);
  h.state.totalEarned = 20000;
});
await page.waitForTimeout(500);
const ready = await snap();
check('butonul se deblocheaza cand ai castigat destul',
      !ready.rebirthOff && /\+1 booster/.test(ready.rebirthBtn), ready.rebirthBtn);

await page.click('#rebirth');
await page.waitForTimeout(250);
const armedSnap = await snap();
check('primul click cere confirmare', /Sigur/.test(armedSnap.rebirthBtn) && armedSnap.boosters === 0,
      armedSnap.rebirthBtn);
await page.waitForTimeout(5000);
check('confirmarea expira singura', !/Sigur/.test((await snap()).rebirthBtn));

await page.click('#rebirth');
await page.waitForTimeout(250);
await page.click('#rebirth');
await page.waitForTimeout(1200);
const one = await snap();
check('renasterea da exact un booster', one.boosters === 1 && one.rebirths === 1, JSON.stringify(one.boosters));
check('hotelul se reseteaza la 2 camere', one.unlocked === 2, `${one.unlocked} camere`);
check('castigul rularii porneste de la zero', one.earned === 0, `$${one.earned}`);
check('bonusul se aplica: nivel 5 da $25 in loc de $20', one.payout5 === 25, `$${one.payout5}`);

// --- 3. etajele noi la 10 / 15 / 20 renasteri -------------------------------
await rebirthTimes(9);
const at10 = await snap();
check('la 10 renasteri apare etajul 3', at10.rebirths === 10 && at10.avail.includes(3),
      `renasteri ${at10.rebirths}, disponibile [${at10.avail}]`);
check('etajul 4 inca nu exista', !at10.avail.includes(4), `[${at10.avail}]`);

await rebirthTimes(5);
const at15 = await snap();
check('la 15 renasteri apare etajul 4', at15.avail.includes(4) && !at15.avail.includes(5),
      `renasteri ${at15.rebirths}, disponibile [${at15.avail}]`);

await rebirthTimes(5);
const at20 = await snap();
check('la 20 renasteri apare etajul 5', at20.avail.includes(5) && at20.tabs === 6,
      `renasteri ${at20.rebirths}, taburi ${at20.tabs}`);
check('prestigiul se deblocheaza fix atunci', at20.prestigeShown, 'butonul de prestigiu e vizibil');
check('20 de boostere = +500% venit', at20.boosters === 20 && at20.mult === 6, `x${at20.mult}`);
await page.screenshot({ path: `${OUT}/41-20-renasteri.png` });

// --- 4. prestigiul ----------------------------------------------------------
await page.click('#prestige');
await page.waitForTimeout(250);
await page.click('#prestige');
await page.waitForTimeout(1200);
const pres = await snap();
check('prestigiul inmulteste boosterii cu 10', pres.boosters === 200 && pres.prestige === 1,
      `${at20.boosters} -> ${pres.boosters} boostere`);
check('renasterile o iau de la zero', pres.rebirths === 0, `${pres.rebirths} renasteri`);
check('etajele castigate raman', pres.avail.length === 6, `disponibile [${pres.avail}]`);
check('multiplicatorul urias se aplica', pres.payout5 === 20 * 51, `payout nivel 5 = $${pres.payout5}`);
check('hotelul reincepe curat', pres.unlocked === 2 && pres.earned === 0,
      `${pres.unlocked} camere, $${pres.earned} castigati`);
await page.screenshot({ path: `${OUT}/42-prestigiu.png` });

// --- 5. jocul merge mai departe --------------------------------------------
await page.evaluate(() => window.__hotel.setSpeed(3));
const m0 = (await snap()).money;
await page.waitForTimeout(12000);
const later = await snap();
check('jocul continua normal dupa prestigiu', later.money > m0 && later.guests > 0,
      `$${m0} -> $${later.money}, ${later.guests} oaspeti`);
await page.screenshot({ path: `${OUT}/43-repornit.png` });

await browser.close();
if (errors.length) {
  console.error('\nERORI IN CONSOLA:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  failures++;
}
console.log(failures === 0 ? '\nToate verificarile au trecut.' : `\n${failures} verificari au picat.`);
process.exit(failures === 0 ? 0 : 1);
