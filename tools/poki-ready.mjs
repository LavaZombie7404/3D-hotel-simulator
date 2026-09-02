// Checks the things Poki requires before a game can be submitted:
// mobile/tablet controls, a HUD that survives 640x360, saved progress,
// pause/resume, and no debug tooling in a shipped build.
//   node tools/poki-ready.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:8080/';
const OUT = 'tools/shots';
mkdirSync(OUT, { recursive: true });

const IGNORE = /Cross-Origin-Opener-Policy|poki-sdk|poki\.com/i;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    // Lets us load the game under a non-localhost hostname, to prove the debug
    // hook really is gated out of a shipped build.
    '--host-resolver-rules=MAP game.test 127.0.0.1',
  ],
});

function watch(page, errors) {
  page.on('console', (m) => {
    // Some blocked third-party requests log only "net::ERR_FAILED", with the
    // real URL in the location, so check both.
    const url = (m.location() && m.location().url) || '';
    if (m.type() === 'error' && !IGNORE.test(m.text()) && !IGNORE.test(url)) {
      errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
}

// --- 1. small screen: Poki scales the canvas down to 640x360 ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const fits = await page.evaluate(() => {
    const ids = ['money-panel', 'top-right', 'stats', 'room-panel', 'staff-panel',
                 'objective', 'hint', 'lift-btn', 'stick'];
    const boxes = [];
    const outside = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el || el.offsetParent === null) continue;      // not currently shown
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 ||
          r.left < -1 || r.top < -1) {
        outside.push(`${id} at ${Math.round(r.left)},${Math.round(r.top)}`);
      }
      boxes.push({ id, r });
    }
    // Panels must not sit on top of each other either: fitting on screen is not
    // the same as being readable.
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 4 && h > 4) overlaps.push(`${boxes[i].id}/${boxes[j].id}`);
      }
    }
    return { outside, overlaps, checked: boxes.length };
  });
  check('the HUD fits inside 640x360', fits.outside.length === 0,
        fits.outside.join(' | ') || `${fits.checked} panels, all inside`);
  check('no HUD panel covers another', fits.overlaps.length === 0,
        fits.overlaps.join(' | ') || 'nothing overlaps');
  check('no console errors at 640x360', errors.length === 0, errors[0] || '');
  await page.screenshot({ path: `${OUT}/50-640x360.png` });
  await ctx.close();
}

// --- 2. touch device: the joystick actually drives the waiter ---------------
{
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const stickShown = await page.evaluate(() =>
    document.getElementById('stick').classList.contains('on'));
  check('the joystick appears on a touch device', stickShown);

  const before = await page.evaluate(() => {
    const p = window.__hotel.player;
    return { x: +p.x.toFixed(2), z: +p.z.toFixed(2) };
  });
  // Drag the stick fully to one side and hold.
  const box = await page.locator('#stick').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + box.width / 2, cy, { steps: 4 });
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const p = window.__hotel.player;
    return { x: +p.x.toFixed(2), z: +p.z.toFixed(2) };
  });
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  check('dragging the joystick moves the waiter', moved > 1.5,
        `${JSON.stringify(before)} -> ${JSON.stringify(after)} (${moved.toFixed(1)}m)`);

  check('no console errors on mobile', errors.length === 0, errors[0] || '');
  await page.screenshot({ path: `${OUT}/51-mobile.png` });
  await ctx.close();
}

// --- 3. progress survives a reload ------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    const h = window.__hotel;
    h.give(60000);
    h.unlockAll(2);
    h.state.boosters = 7;
    h.state.rebirths = 7;
    h.state.maxRebirths = 12;
    h.save();
  });
  const saved = await page.evaluate(() => {
    const h = window.__hotel;
    let n = 0;
    for (let r = 0; r < h.config.TOTAL_ROOMS; r++) if (h.rooms.level[r] > 0) n++;
    return { rooms: n, boosters: h.state.boosters, money: Math.round(h.state.money) };
  });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const restored = await page.evaluate(() => {
    const h = window.__hotel;
    let n = 0;
    for (let r = 0; r < h.config.TOTAL_ROOMS; r++) if (h.rooms.level[r] > 0) n++;
    return {
      rooms: n, boosters: h.state.boosters, money: Math.round(h.state.money),
      floor3: h.floorAvailable(3),
    };
  });
  check('rooms survive a reload', restored.rooms === saved.rooms,
        `${saved.rooms} -> ${restored.rooms}`);
  check('boosters survive a reload', restored.boosters === 7, `${restored.boosters} boosters`);
  check('earned floors survive a reload', restored.floor3 === true, 'floor 3 still available');
  check('money survives a reload', Math.abs(restored.money - saved.money) < 500,
        `$${saved.money} -> $${restored.money}`);

  // --- 4. pause freezes the simulation -------------------------------------
  await page.evaluate(() => window.__hotel.setSpeed(3));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const pausedOn = await page.evaluate(() =>
    document.getElementById('pause').classList.contains('on'));
  const simTime = () => page.evaluate(() => +window.__hotel.state.simTime.toFixed(2));
  const t0 = await simTime();
  await page.waitForTimeout(2000);
  const t1 = await simTime();
  check('Escape pauses and shows the overlay', pausedOn);
  check('nothing advances while paused', t1 === t0, `sim clock ${t0} -> ${t1}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);
  const t2 = await simTime();
  const overlayGone = await page.evaluate(() =>
    !document.getElementById('pause').classList.contains('on'));
  check('Escape resumes', overlayGone && t2 > t1 + 1, `sim clock ${t1} -> ${t2}`);
  check('no console errors on desktop', errors.length === 0, errors[0] || '');
  await page.screenshot({ path: `${OUT}/52-paused.png` });
  await ctx.close();
}

// --- 5. a portal SDK that never answers must not stop the game --------------
// This is the failure that actually bit us: the loop used to start only once
// the SDK's init() resolved, so an SDK that hung left the player on a blank
// screen with the HUD drawn over it.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  // Install a portal SDK whose init() never settles, before any game code runs.
  await page.addInitScript(() => {
    window.CrazyGames = {
      SDK: {
        init: () => new Promise(() => {}),      // never resolves, never rejects
        game: {
          gameplayStart() {}, gameplayStop() {},
          loadingStart() {}, loadingStop() {},
        },
        ad: { requestAd() {} },
        getEnvironment: () => 'local',
      },
    };
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  const alive = await page.evaluate(() => {
    const h = window.__hotel;
    return { canvas: !!document.querySelector('canvas'), t: h ? h.state.simTime : -1 };
  });
  await page.waitForTimeout(2500);
  const later = await page.evaluate(() => (window.__hotel ? window.__hotel.state.simTime : -1));

  check('the game starts even if the portal SDK hangs', alive.canvas && later > alive.t + 1,
        `sim clock ${alive.t.toFixed(2)} -> ${later.toFixed(2)}`);
  check('no console errors with a hanging SDK', errors.length === 0, errors[0] || '');
  await page.screenshot({ path: `${OUT}/53-hanging-sdk.png` });
  await ctx.close();
}

// --- 6. a shipped build carries no debug tooling ----------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto('http://game.test:8080/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const hook = await page.evaluate(() => typeof window.__hotel);
  const running = await page.evaluate(() => !!document.querySelector('canvas'));
  check('__hotel is absent on a non-localhost host', hook === 'undefined', `typeof = ${hook}`);
  check('the game still runs there', running);
  check('no console errors on a shipped host', errors.length === 0, errors[0] || '');
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
