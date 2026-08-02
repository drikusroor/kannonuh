/**
 * Drives the real client in Chromium: starts a practice battle, fires a shot and
 * captures screenshots. Used to eyeball the game without a human in the loop.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const shotDir = process.env.SHOT_DIR ?? '/tmp/kannonuh-shots';
const base = process.env.BASE_URL ?? 'http://localhost:3000';
await mkdir(shotDir, { recursive: true });

const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: (await Bun.file(exe).exists()) ? exe : undefined,
  args: ['--no-sandbox', '--use-gl=swiftshader'],
});
const [vw, vh] = (process.env.VIEWPORT ?? '1440x810').split('x').map(Number);
const page = await browser.newPage({
  viewport: { width: vw ?? 1440, height: vh ?? 810 },
  deviceScaleFactor: 1,
  isMobile: (vw ?? 1440) < 700,
  hasTouch: (vw ?? 1440) < 700,
});

const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Testwell');
await page.waitForTimeout(400);
await page.screenshot({ path: `${shotDir}/01-menu.png` });

await page.click('#menu-practice');
await page.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
await page.waitForTimeout(2600);
await page.screenshot({ path: `${shotDir}/02-battle.png` });

// Aim high and fire.
await page.fill('#elev-slider', '42');
await page.dispatchEvent('#elev-slider', 'input');
await page.fill('#power-slider', '92');
await page.dispatchEvent('#power-slider', 'input');
await page.waitForTimeout(200);
await page.screenshot({ path: `${shotDir}/03-aimed.png` });

await page.click('#fire-btn');
await page.waitForTimeout(900);
await page.screenshot({ path: `${shotDir}/04-flight.png` });
await page.waitForTimeout(1400);
await page.screenshot({ path: `${shotDir}/05-impact.png` });

// Open the shop.
await page.waitForTimeout(2500);
const shopEnabled = await page.isEnabled('#shop-btn');
if (shopEnabled) {
  await page.click('#shop-btn');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shotDir}/06-shop.png` });
  await page.click('[data-close="shop"]');
}

// Let the bot answer.
await page.waitForTimeout(9000);
await page.screenshot({ path: `${shotDir}/07-later.png` });

console.log('turn label:', await page.textContent('#turn-label'));
console.log('credits:', await page.textContent('#team-0 [data-credits]'));
console.log('king hp:', await page.textContent('#team-1 [data-kinghp]'));
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');

await browser.close();
