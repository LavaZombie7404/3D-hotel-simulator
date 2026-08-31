// Testul chelnerului: miscare, coliziune cu peretii, lift, bacsis din room
// service si accelerarea check-in-ului cand stai la receptie.
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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

// Deblocam tot, ca sa avem clienti in camere pe toate etajele.
await page.evaluate(() => {
  const h = window.__hotel;
  h.grantRebirths(20);      // ca sa existe si etajele de sus
  h.give(5000000);
  h.unlockAll(3);
  h.setSpeed(2);
});

// --- 1. miscarea ------------------------------------------------------------
const before = await pos();
await page.keyboard.down('d');
await page.waitForTimeout(700);
await page.keyboard.up('d');
await page.waitForTimeout(150);
const after = await pos();
check('chelnerul se misca cu tastele', Math.hypot(after.x - before.x, after.z - before.z) > 1.5,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

// --- 2. coliziunea cu peretii ----------------------------------------------
// Il punem langa peretele din spatele camerelor si impingem in el.
await page.evaluate(() => {
  const p = window.__hotel.player;
  p.x = 9; p.z = 7.5; p.floor = 0;
});
// Camera priveste dinspre +Z, deci "jos" pe ecran inseamna +Z: intra in
// peretele exterior din spatele camerelor de pe latura nordica.
await page.keyboard.down('ArrowDown');
await page.waitForTimeout(1400);
await page.keyboard.up('ArrowDown');
await page.waitForTimeout(150);
const wall = await pos();
// BUILD_Z = 9, deci nu trebuie sa treaca dincolo de ~8.6
check('nu trece prin peretele exterior', wall.z > 7 && wall.z < 8.8, `z = ${wall.z}`);

// --- 3. liftul --------------------------------------------------------------
await page.evaluate(() => {
  const p = window.__hotel.player;
  p.x = -2.6; p.z = 0; p.floor = 0;      // in cabina liftului
});
await page.waitForTimeout(150);
await page.keyboard.press('e');
await page.waitForTimeout(1500);
const lifted = await pos();
const st1 = await stats();
check('liftul urca un etaj', lifted.floor === 1, `etaj = ${lifted.floor}`);
check('vizualizarea urmeaza chelnerul', st1.activeFloor === 1, `etaj afisat = ${st1.activeFloor}`);
await page.screenshot({ path: `${OUT}/20-lift.png` });

// --- 4. room service --------------------------------------------------------
// Plimbam chelnerul prin toate camerele etajului 1, ciclic, ~25 de secunde.
const tipsBefore = (await stats()).tips;
await page.evaluate(async () => {
  const h = window.__hotel, p = h.player;
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 25000) {
    const n = h.config.ROOMS_PER_FLOOR;
    const r = n + (i++ % n);                       // camerele etajului 1
    p.x = h.rooms.cx[r]; p.z = h.rooms.cz[r]; p.floor = 1;
    await new Promise((res) => setTimeout(res, 260));
  }
});
const st2 = await stats();
check('chelnerul incaseaza bacsis', st2.tips > tipsBefore,
      `bacsis ${tipsBefore} -> ${st2.tips}, cereri servite ${st2.served}`);
await page.screenshot({ path: `${OUT}/21-roomservice.png` });

// --- 5. boostul de la receptie ---------------------------------------------
// Numaram check-in-urile in 10 secunde departe de birou, apoi in cerc.
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
check('la receptie check-in-ul e mai rapid', desk > away, `${away} vs ${desk} check-in-uri / 10s`);
const deskPos = await pos();
check('cercul receptiei se activeaza', deskPos.atDesk === true, JSON.stringify(deskPos));
await page.screenshot({ path: `${OUT}/22-receptie.png` });

await browser.close();

if (errors.length) {
  console.error('\nERORI IN CONSOLA:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  failures++;
}
console.log(failures === 0 ? '\nToate verificarile au trecut.' : `\n${failures} verificari au picat.`);
process.exit(failures === 0 ? 0 : 1);
