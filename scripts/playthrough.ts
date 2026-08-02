/**
 * Plays a whole practice battle in a real browser, ranging in on the enemy keep
 * the way a person would, and screenshots the interesting moments.
 */
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';

const shotDir = process.env.SHOT_DIR ?? '/tmp/kannonuh-play';
const base = process.env.BASE_URL ?? 'http://localhost:3000';
await mkdir(shotDir, { recursive: true });

const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: (await Bun.file(exe).exists()) ? exe : undefined,
  args: ['--no-sandbox', '--use-gl=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${base}/?debug=1`, { waitUntil: 'networkidle' });
await page.click('[data-diff="0"]');
await page.click('#menu-practice');
await page.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
await page.waitForTimeout(2200);

interface Snapshot {
  turn: number;
  you: number;
  phase: string;
  busy: boolean;
  shotsLeft: number;
  credits: number;
  gun: { id: number; x: number; y: number; fired: boolean } | null;
  target: { x: number; y: number } | null;
  lastLanding: { x: number; y: number } | null;
}

const read = (): Promise<Snapshot> =>
  page.evaluate(() => {
    const k = (window as any).__kannonuh;
    const st = k.app.state;
    const guns = st ? st.world.entities.filter((e: any) => e.kind === 'cannon' && e.owner === k.app.you) : [];
    const gun = guns.find((g: any) => !g.firedThisTurn) ?? guns[0] ?? null;
    const king = st ? st.world.entities.find((e: any) => e.kind === 'king' && e.owner !== k.app.you) : null;
    const ghosts = k.app.ghosts.filter((g: any) => g.side === k.app.you);
    const last = ghosts[ghosts.length - 1];
    return {
      turn: st?.turn ?? -1,
      you: k.app.you,
      phase: st?.phase ?? 'none',
      busy: !!k.app.replay,
      shotsLeft: st?.shotsLeft ?? 0,
      credits: st ? Math.round(st.players[k.app.you].credits) : 0,
      gun: gun ? { id: gun.id, x: gun.x, y: gun.y, fired: !!gun.firedThisTurn } : null,
      target: king ? { x: king.x, y: king.y } : null,
      lastLanding: last ? { x: last.pts[last.pts.length - 2], y: last.pts[last.pts.length - 1] } : null,
    };
  });

async function idle(page: Page): Promise<Snapshot> {
  for (let i = 0; i < 400; i++) {
    const s = await read();
    if (s.phase === 'over') return s;
    if (!s.busy && s.turn === s.you && s.shotsLeft > 0) return s;
    await page.waitForTimeout(150);
  }
  throw new Error('the game never came back to me');
}

// Ranging: start at a sensible arc, then correct the charge from where the last
// shot actually landed. This is exactly the loop a human runs.
let power = 78;
const elevation = 41;
let shots = 0;

for (let turn = 0; turn < 130; turn++) {
  const s = await idle(page);
  if (s.phase === 'over') break;
  if (!s.gun || !s.target) break;

  if (s.lastLanding) {
    const want = Math.abs(s.target.x - s.gun.x);
    const got = Math.abs(s.lastLanding.x - s.gun.x);
    if (got > 60) {
      const v = 380 + 11 * power;
      const corrected = (v * Math.sqrt(Math.max(0.35, Math.min(2.6, want / got))) - 380) / 11;
      power = Math.max(20, Math.min(100, corrected + (Math.random() - 0.5) * 2));
    }
  }

  // Load explosive shells when the magazine has them.
  await page.evaluate(() => {
    const k = (window as any).__kannonuh;
    const stock = k.app.state?.players[k.app.you]?.ammo ?? {};
    if ((stock.shell ?? 0) > 0) k.ui.hooks.chooseAmmo('shell');
    else k.ui.hooks.chooseAmmo('round');
  });
  await page.evaluate(([e, p]) => (window as any).__kannonuh.aim(e, p), [elevation, power] as const);
  await page.click('#fire-btn');
  shots++;
  await page.waitForTimeout(400);
  if (shots === 3) await page.screenshot({ path: `${shotDir}/a-ranging.png` });

  // Wait for the replay to finish.
  for (let i = 0; i < 200; i++) {
    const s2 = await read();
    if (!s2.busy) break;
    if (i === 4 && shots % 5 === 0) await page.screenshot({ path: `${shotDir}/b-flight.png` });
    await page.waitForTimeout(100);
  }
  const after = await read();
  if (after.phase === 'over') break;
  if (after.turn === after.you && after.shotsLeft === 0) {
    await page.click('#endturn-btn');
    await page.waitForTimeout(300);
  }
  if (shots === 6) await page.screenshot({ path: `${shotDir}/c-damage.png` });
  {
    // Spend some credits on the way through.
    const mine = await read();
    if (mine.credits > 220 && mine.turn === mine.you && mine.phase === 'playing') {
      await page.click('#shop-btn');
      await page.waitForTimeout(300);
      const buy = page.locator('#tab-ammo .shop-item button:not([disabled])').first();
      if (await buy.count()) await buy.click();
      await page.waitForTimeout(200);
      if (shots === 6) await page.screenshot({ path: `${shotDir}/d-shop.png` });
      await page.click('[data-close="shop"]');
    }
  }
}

await page.waitForTimeout(3200);
await page.screenshot({ path: `${shotDir}/e-final.png` });
const final = await read();
console.log('phase:', final.phase, 'shots fired:', shots);

if (final.phase === 'over') {
  await page.waitForSelector('#over:not(.hidden)', { timeout: 12000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shotDir}/f-scoreboard.png`, fullPage: false });
  console.log('title:', await page.textContent('#over-title'));
  console.log('sub:', await page.textContent('#over-sub'));
}

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
