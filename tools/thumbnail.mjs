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
  // Staff on the floor and a full restaurant, so the shot shows the whole game.
  for (let f = 0; f < 3; f++) { h.hire(f, 0); h.hire(f, 1); }
});
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(350);
  await page.click('#restaurant');
}
await page.waitForTimeout(25000);

// The ground floor is the shot: it has the lobby crowd, the reception, the
// restaurant and the sign. Upper floors are just corridors.
const shown = await page.evaluate(() => {
  const h = window.__hotel;
  h.focusFloor(0);
  let occ = 0;
  for (let r = 0; r < h.config.ROOMS_PER_FLOOR; r++) if (h.rooms.occupant[r] >= 0) occ++;
  return { occupied: occ };
});
// Frame the ground floor: restaurant at the top, lobby and sign on the left.
await page.evaluate(() => window.__hotel.setCamera(2, 46, 34, 3, 1, -7));
await page.waitForTimeout(2500);

// Hide the interface so only the hotel is in frame.
await page.addStyleTag({ content: `
  #money-panel, #top-right, #stats, #right-column, #perf, #hint, #stick,
  #objective, #popups, #pause { display: none !important; }
` });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/thumbnail-1280x720.png` });
console.log('thumbnail written, ground floor,', shown.occupied, 'rooms occupied');

await browser.close();
