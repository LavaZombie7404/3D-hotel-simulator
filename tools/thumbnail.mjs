// Generates a clean 16:9 promo shot: a busy, upgraded hotel with the HUD
// hidden. Poki asks for a static thumbnail at the global release stage.
//   node tools/thumbnail.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:8080/?debug';
const OUT = 'tools/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// A hotel worth looking at: every room open and upgraded, and busy.
await page.evaluate(() => {
  const h = window.__hotel;
  h.grantRebirths(20);
  h.give(50000000);
  h.unlockAll(5);
  h.state.boosters = 40;
  h.setSpeed(4);
});
await page.waitForTimeout(25000);

const busiest = await page.evaluate(() => {
  const h = window.__hotel, n = h.config.ROOMS_PER_FLOOR;
  let best = 0, bestOcc = -1;
  for (let f = 0; f < h.config.FLOORS; f++) {
    let occ = 0;
    for (let r = f * n; r < f * n + n; r++) if (h.rooms.occupant[r] >= 0) occ++;
    if (occ > bestOcc) { bestOcc = occ; best = f; }
  }
  h.focusFloor(best);
  return { floor: best, occupied: bestOcc };
});
// Pull back and drop the angle so the river, the treeline and the sky are all
// in frame, not just the floor plan.
await page.evaluate(() => window.__hotel.setCamera(-4, 30, 56, 8, 2, -6));
await page.waitForTimeout(2500);

// Hide the interface so only the hotel is in frame.
await page.addStyleTag({ content: `
  #money-panel, #top-right, #stats, #room-panel, #perf, #hint, #stick,
  #lift-btn, #popups { display: none !important; }
` });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/thumbnail-1280x720.png` });
console.log('thumbnail written, showing floor', busiest.floor,
            'with', busiest.occupied, 'rooms occupied');

await browser.close();
