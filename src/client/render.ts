import { AMMO, CANNONS, COLS, COL_W, WORLD_H, WORLD_W, type AmmoId } from '../shared/constants.ts';
import { hash01 } from '../shared/rng.ts';
import { surfaceAt } from '../shared/terrain.ts';
import { facing } from '../shared/world.ts';
import type { Entity, Side, WorldState } from '../shared/types.ts';
import { camUpdate, viewCy, worldToScreen, type Camera, type Fx } from './fx.ts';

export interface LiveProjectile {
  x: number;
  y: number;
  ammo: AmmoId;
  trail: { x: number; y: number }[];
}

export interface Ghost {
  side: Side;
  pts: number[];
}

export interface Scene {
  world: Omit<WorldState, 'terrain'>;
  terrain: number[];
  entities: Entity[];
  you: Side | -1;
  turn: Side;
  selected: number;
  aim: { elevation: number; power: number; ammo: AmmoId } | null;
  aimSide: Side | -1;
  projectiles: LiveProjectile[];
  ghosts: Ghost[];
  /** Entities the client wants to draw as burning even before state catches up. */
  time: number;
  placing: { w: number; h: number; x: number; y: number; ok: boolean } | null;
}

interface Palette {
  sky: [string, string, string];
  sun: string;
  sunGlow: string;
  haze: string;
  far: string;
  near: string;
  grass: [string, string];
  dirt: [string, string];
  rock: string;
  ambient: string;
  cloud: string;
  star: number;
}

const PALETTES: Palette[] = [
  {
    // Dawn
    sky: ['#243a5e', '#c96f52', '#f0b073'],
    sun: '#ffe7b0',
    sunGlow: 'rgba(255,190,120,0.55)',
    haze: 'rgba(240,180,140,0.35)',
    far: '#4a4560',
    near: '#3a3550',
    grass: ['#6f8f4a', '#415a2c'],
    dirt: ['#6b5236', '#3d2f20'],
    rock: '#514639',
    ambient: 'rgba(255,190,140,0.10)',
    cloud: 'rgba(255,206,175,0.7)',
    star: 0.15,
  },
  {
    // Bright day
    sky: ['#2f6fb5', '#79b3e2', '#cfe3f2'],
    sun: '#fffbe8',
    sunGlow: 'rgba(255,248,210,0.5)',
    haze: 'rgba(210,232,246,0.4)',
    far: '#6e83a0',
    near: '#54687f',
    grass: ['#7fa64f', '#4a6b2e'],
    dirt: ['#7a5f3e', '#463523'],
    rock: '#5b5044',
    ambient: 'rgba(255,255,230,0.06)',
    cloud: 'rgba(255,255,255,0.85)',
    star: 0,
  },
  {
    // Dusk
    sky: ['#1d2447', '#7b3f6a', '#e07a4e'],
    sun: '#ffd08a',
    sunGlow: 'rgba(255,140,90,0.5)',
    haze: 'rgba(220,140,120,0.35)',
    far: '#463a55',
    near: '#332b42',
    grass: ['#5d7a45', '#334a27'],
    dirt: ['#5f4a32', '#33271b'],
    rock: '#463c33',
    ambient: 'rgba(255,150,110,0.10)',
    cloud: 'rgba(255,180,150,0.65)',
    star: 0.35,
  },
  {
    // Night
    sky: ['#080d1f', '#122043', '#26365f'],
    sun: '#e8f0ff',
    sunGlow: 'rgba(190,215,255,0.35)',
    haze: 'rgba(90,120,170,0.25)',
    far: '#1d2740',
    near: '#161d31',
    grass: ['#3d5533', '#22331e'],
    dirt: ['#3c3022', '#221a12'],
    rock: '#2e2a28',
    ambient: 'rgba(120,160,230,0.10)',
    cloud: 'rgba(150,170,210,0.35)',
    star: 1,
  },
];

const TEAM = ['#e0574a', '#5aa2e6'];
const TEAM_DARK = ['#8f2f26', '#2a5f92'];

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cam: Camera;
  fx: Fx;
  dpr = 1;

  constructor(canvas: HTMLCanvasElement, cam: Camera, fx: Fx) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.cam = cam;
    this.fx = fx;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.cam.w = w;
    this.cam.h = h;
  }

  draw(scene: Scene, dt: number): void {
    const { ctx, cam } = this;
    const pal = PALETTES[Math.min(3, Math.floor(scene.world.timeOfDay * 4))]!;

    camUpdate(cam, dt);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, cam.w, cam.h);

    drawSky(ctx, cam, pal, scene);
    drawParallax(ctx, cam, pal, scene);

    ctx.save();
    ctx.setTransform(
      this.dpr * cam.zoom,
      0,
      0,
      this.dpr * cam.zoom,
      this.dpr * (cam.w / 2 - cam.x * cam.zoom + cam.shakeX),
      this.dpr * (viewCy(cam) - cam.y * cam.zoom + cam.shakeY),
    );

    const view = visibleRange(cam);
    drawTerrain(ctx, pal, scene, view);
    drawEntities(ctx, pal, scene);
    drawGhosts(ctx, scene);
    drawParticles(ctx, this.fx);
    drawProjectiles(ctx, scene);
    drawAim(ctx, scene, cam);
    drawPlacing(ctx, scene);
    drawFloatText(ctx, this.fx, cam);
    ctx.restore();

    drawWindStreaks(ctx, cam, scene, pal);
    drawOffscreenMarkers(ctx, cam, scene);
    drawVignette(ctx, cam, pal, this.fx.flash);
  }
}

function visibleRange(cam: Camera): { x0: number; x1: number; y0: number; y1: number } {
  const halfW = cam.w / 2 / cam.zoom + 60;
  const halfH = cam.h / cam.zoom + 60;
  return { x0: cam.x - halfW, x1: cam.x + halfW, y0: cam.y - halfH, y1: cam.y + halfH };
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

function drawSky(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, scene: Scene): void {
  const g = ctx.createLinearGradient(0, 0, 0, cam.h);
  g.addColorStop(0, pal.sky[0]);
  g.addColorStop(0.55, pal.sky[1]);
  g.addColorStop(1, pal.sky[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cam.w, cam.h);

  if (pal.star > 0) {
    ctx.save();
    for (let i = 0; i < 90; i++) {
      const sx = hash01(i, 7) * cam.w;
      const sy = hash01(i, 13) * cam.h * 0.55;
      const tw = 0.5 + 0.5 * Math.sin(scene.time * 1.6 + i);
      ctx.globalAlpha = pal.star * (0.25 + tw * 0.6);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(sx, sy, 1.6, 1.6);
    }
    ctx.restore();
  }

  // Sun or moon, parked relative to the world so panning feels grounded.
  const sunX = cam.w * 0.5 + (WORLD_W * 0.35 - cam.x) * 0.06 * cam.zoom;
  const sunY = cam.h * 0.24 + (WORLD_H * 0.2 - cam.y) * 0.03 * cam.zoom;
  const r = 34;
  const glow = ctx.createRadialGradient(sunX, sunY, r * 0.3, sunX, sunY, r * 6);
  glow.addColorStop(0, pal.sunGlow);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sunX - r * 6, sunY - r * 6, r * 12, r * 12);
  ctx.fillStyle = pal.sun;
  ctx.beginPath();
  ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
  ctx.fill();

  drawClouds(ctx, cam, pal, scene);
}

function drawClouds(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, scene: Scene): void {
  ctx.save();
  const drift = scene.time * scene.world.wind * 14;
  for (let i = 0; i < 9; i++) {
    const base = hash01(i, 3) * WORLD_W * 1.4;
    const wy = 120 + hash01(i, 5) * 300;
    const scale = 0.6 + hash01(i, 9) * 1.1;
    const par = 0.22 + hash01(i, 11) * 0.12;
    const sx = ((base + drift - cam.x * par) % (WORLD_W * 1.6)) * cam.zoom + cam.w * 0.2;
    const sy = (wy - cam.y * par * 0.4) * cam.zoom + cam.h * 0.32;
    if (sx < -300 || sx > cam.w + 300) continue;
    ctx.globalAlpha = 0.5 + hash01(i, 17) * 0.35;
    ctx.fillStyle = pal.cloud;
    const s = 30 * scale * Math.max(0.5, cam.zoom);
    ctx.beginPath();
    ctx.ellipse(sx, sy, s * 2.4, s * 0.72, 0, 0, Math.PI * 2);
    ctx.ellipse(sx - s * 1.1, sy + s * 0.16, s * 1.2, s * 0.55, 0, 0, Math.PI * 2);
    ctx.ellipse(sx + s * 1.0, sy + s * 0.2, s * 1.4, s * 0.6, 0, 0, Math.PI * 2);
    ctx.ellipse(sx + s * 0.2, sy - s * 0.42, s * 1.3, s * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Two ridgelines of distant hills, generated straight from the map seed. */
function drawParallax(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, scene: Scene): void {
  const layers = [
    { par: 0.28, colour: pal.far, amp: 90, base: 0.62, freq: 0.0016, salt: 21 },
    { par: 0.46, colour: pal.near, amp: 130, base: 0.72, freq: 0.0011, salt: 47 },
  ];
  for (const L of layers) {
    ctx.fillStyle = L.colour;
    ctx.beginPath();
    ctx.moveTo(0, cam.h);
    const step = 14;
    for (let sx = 0; sx <= cam.w + step; sx += step) {
      const wx = (sx - cam.w / 2) / cam.zoom + cam.x * L.par + scene.world.seed * 0.01;
      const n =
        Math.sin(wx * L.freq + L.salt) * 0.5 +
        Math.sin(wx * L.freq * 2.3 + L.salt * 1.7) * 0.3 +
        Math.sin(wx * L.freq * 4.7 + L.salt * 2.9) * 0.2;
      const wy = WORLD_H * L.base + n * L.amp;
      const sy = (wy - cam.y) * cam.zoom + viewCy(cam);
      ctx.lineTo(sx, sy);
    }
    ctx.lineTo(cam.w, cam.h);
    ctx.closePath();
    ctx.fill();
  }
  // Atmospheric haze where the hills meet the ground.
  const hz = ctx.createLinearGradient(0, cam.h * 0.45, 0, cam.h);
  hz.addColorStop(0, 'rgba(0,0,0,0)');
  hz.addColorStop(1, pal.haze);
  ctx.fillStyle = hz;
  ctx.fillRect(0, cam.h * 0.45, cam.w, cam.h * 0.55);
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function drawTerrain(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  scene: Scene,
  view: { x0: number; x1: number },
): void {
  const terrain = scene.terrain;
  const i0 = Math.max(0, Math.floor(view.x0 / COL_W) - 1);
  const i1 = Math.min(COLS - 1, Math.ceil(view.x1 / COL_W) + 1);

  // Run the ground past the map edges so panning never reveals a seam.
  const left = Math.min(view.x0 - 400, 0);
  const right = Math.max(view.x1 + 400, WORLD_W);
  ctx.beginPath();
  ctx.moveTo(left, WORLD_H + 400);
  ctx.lineTo(left, terrain[i0]!);
  for (let i = i0; i <= i1; i++) ctx.lineTo(i * COL_W + COL_W / 2, terrain[i]!);
  ctx.lineTo(right, terrain[i1]!);
  ctx.lineTo(right, WORLD_H + 400);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, WORLD_H * 0.4, 0, WORLD_H);
  g.addColorStop(0, pal.dirt[0]);
  g.addColorStop(0.45, pal.dirt[1]);
  g.addColorStop(1, pal.rock);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  ctx.clip();
  // Rock strata bands give the cliff faces some read.
  ctx.globalAlpha = 0.14;
  for (let band = 0; band < 9; band++) {
    const y = WORLD_H * 0.5 + band * 46 + Math.sin(band * 2.3) * 8;
    ctx.fillStyle = band % 2 ? '#000000' : '#c9b48c';
    ctx.fillRect(view.x0, y, view.x1 - view.x0, 12);
  }
  ctx.globalAlpha = 1;

  // Topsoil band hugging the surface.
  ctx.beginPath();
  ctx.moveTo(left, terrain[i0]! + 30);
  ctx.lineTo(left, terrain[i0]!);
  for (let i = i0; i <= i1; i++) ctx.lineTo(i * COL_W + COL_W / 2, terrain[i]!);
  ctx.lineTo(right, terrain[i1]!);
  ctx.lineTo(right, terrain[i1]! + 30);
  ctx.closePath();
  ctx.fillStyle = pal.grass[1];
  ctx.fill();

  // Bright rim along the very top of the ground.
  ctx.beginPath();
  ctx.moveTo(left, terrain[i0]!);
  for (let i = i0; i <= i1; i++) ctx.lineTo(i * COL_W + COL_W / 2, terrain[i]!);
  ctx.lineTo(right, terrain[i1]!);
  ctx.strokeStyle = pal.grass[0];
  ctx.lineWidth = 7;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Grass tufts leaning with the wind.
  ctx.save();
  ctx.strokeStyle = pal.grass[0];
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = i0; i <= i1; i += 3) {
    const h = hash01(i, 91);
    if (h > 0.45) continue;
    const x = i * COL_W + h * 10;
    const y = terrain[i]!;
    const lean = Math.sin(scene.time * 1.4 + i) * 1.6 + scene.world.wind * 4;
    ctx.moveTo(x, y);
    ctx.lineTo(x + lean, y - 5 - h * 12);
  }
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const ORDER: Record<string, number> = {
  tree: 0,
  rock: 1,
  king: 2,
  block: 3,
  timber: 4,
  barrel: 5,
  cannon: 6,
};

function drawEntities(ctx: CanvasRenderingContext2D, pal: Palette, scene: Scene): void {
  const list = [...scene.entities].sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
  for (const e of list) {
    switch (e.kind) {
      case 'tree':
        drawTree(ctx, e, scene, pal);
        break;
      case 'rock':
        drawRock(ctx, e, pal);
        break;
      case 'block':
        drawBlock(ctx, e, pal);
        break;
      case 'timber':
        drawTimber(ctx, e);
        break;
      case 'barrel':
        drawBarrel(ctx, e);
        break;
      case 'king':
        drawKing(ctx, e, scene);
        break;
      case 'cannon':
        drawCannon(ctx, e, scene);
        break;
    }
    if (e.burning && e.burning > 0) drawFlames(ctx, e, scene.time);
  }
}

function drawBlock(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  const x = e.x - e.w / 2;
  const y = e.y - e.h / 2;
  const dmg = 1 - e.hp / e.maxHp;
  const tint = e.owner >= 0 ? TEAM_DARK[e.owner]! : '#5c5347';
  const shade = 0.26 + hash01(e.seed, 2) * 0.12;

  ctx.fillStyle = mix('#8d8171', tint, 0.18);
  ctx.fillRect(x, y, e.w, e.h);
  // Bevel.
  ctx.fillStyle = `rgba(255,246,220,${0.16 - dmg * 0.1})`;
  ctx.fillRect(x, y, e.w, 3);
  ctx.fillRect(x, y, 3, e.h);
  ctx.fillStyle = `rgba(0,0,0,${shade})`;
  ctx.fillRect(x, y + e.h - 4, e.w, 4);
  ctx.fillRect(x + e.w - 4, y, 4, e.h);
  // Mortar joint.
  ctx.strokeStyle = 'rgba(20,16,12,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, e.w - 1, e.h - 1);
  // Stone speckle.
  ctx.fillStyle = `rgba(0,0,0,0.12)`;
  for (let i = 0; i < 5; i++) {
    const px = x + hash01(e.seed, i * 3) * e.w;
    const py = y + hash01(e.seed, i * 3 + 1) * e.h;
    ctx.fillRect(px, py, 2.5, 2);
  }
  if (dmg > 0.15) drawCracks(ctx, e, dmg);
  void pal;
}

function drawCracks(ctx: CanvasRenderingContext2D, e: Entity, dmg: number): void {
  ctx.save();
  ctx.strokeStyle = `rgba(12,9,6,${0.35 + dmg * 0.5})`;
  ctx.lineWidth = 1 + dmg;
  const n = Math.ceil(dmg * 3.4);
  for (let c = 0; c < n; c++) {
    ctx.beginPath();
    let px = e.x - e.w / 2 + hash01(e.seed, c * 7) * e.w;
    let py = e.y - e.h / 2;
    ctx.moveTo(px, py);
    for (let s = 1; s <= 4; s++) {
      px += (hash01(e.seed, c * 7 + s) - 0.5) * e.w * 0.5;
      py += e.h / 4;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawTimber(ctx: CanvasRenderingContext2D, e: Entity): void {
  const x = e.x - e.w / 2;
  const y = e.y - e.h / 2;
  const dmg = 1 - e.hp / e.maxHp;
  ctx.fillStyle = '#6b4a2a';
  ctx.fillRect(x, y, e.w, e.h);
  ctx.strokeStyle = 'rgba(40,26,14,0.75)';
  ctx.lineWidth = 1.2;
  const planks = Math.max(2, Math.round(e.h / 10));
  for (let i = 1; i < planks; i++) {
    const py = y + (e.h / planks) * i;
    ctx.beginPath();
    ctx.moveTo(x, py);
    ctx.lineTo(x + e.w, py);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,220,170,0.12)';
  ctx.fillRect(x, y, e.w, 2);
  if (dmg > 0.2) {
    ctx.strokeStyle = `rgba(20,12,6,${0.4 + dmg * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(x + e.w * 0.2, y);
    ctx.lineTo(x + e.w * 0.45, y + e.h);
    ctx.stroke();
  }
}

function drawBarrel(ctx: CanvasRenderingContext2D, e: Entity): void {
  const x = e.x - e.w / 2;
  const y = e.y - e.h / 2;
  ctx.save();
  const g = ctx.createLinearGradient(x, 0, x + e.w, 0);
  g.addColorStop(0, '#4d3218');
  g.addColorStop(0.4, '#8a5c2c');
  g.addColorStop(1, '#3f2a13');
  ctx.fillStyle = g;
  roundRect(ctx, x, y, e.w, e.h, 5);
  ctx.fill();
  ctx.fillStyle = '#2b2b2f';
  ctx.fillRect(x - 1, y + e.h * 0.18, e.w + 2, 3.5);
  ctx.fillRect(x - 1, y + e.h * 0.68, e.w + 2, 3.5);
  // Fuse.
  ctx.strokeStyle = '#d8c9a8';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(e.x, y);
  ctx.quadraticCurveTo(e.x + 5, y - 8, e.x + 1, y - 12);
  ctx.stroke();
  // Danger mark.
  ctx.fillStyle = 'rgba(230,120,60,0.85)';
  ctx.font = '11px serif';
  ctx.textAlign = 'center';
  ctx.fillText('☠', e.x, e.y + 4);
  ctx.restore();
}

function drawTree(ctx: CanvasRenderingContext2D, e: Entity, scene: Scene, pal: Palette): void {
  const sway = Math.sin(scene.time * 1.1 + e.seed) * (2 + Math.abs(scene.world.wind) * 5) + scene.world.wind * 6;
  const baseY = e.y + e.h / 2;
  ctx.save();
  ctx.strokeStyle = '#4a3520';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(e.x, baseY);
  ctx.quadraticCurveTo(e.x + sway * 0.3, baseY - e.h * 0.5, e.x + sway, baseY - e.h * 0.72);
  ctx.stroke();

  const greens = [pal.grass[0], pal.grass[1], mix(pal.grass[0], '#2e4a1e', 0.4)];
  const top = baseY - e.h * 0.7;
  const variant = e.variant ?? 0;
  ctx.fillStyle = greens[variant % greens.length]!;
  if (variant === 3) {
    // Conifer.
    for (let i = 0; i < 3; i++) {
      const w = e.w * (1.1 - i * 0.25);
      const y = top + 12 - i * 13;
      ctx.beginPath();
      ctx.moveTo(e.x + sway, y - 22);
      ctx.lineTo(e.x + sway - w, y + 6);
      ctx.lineTo(e.x + sway + w, y + 6);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + e.seed;
      const rx = Math.cos(a) * e.w * 0.5;
      const ry = Math.sin(a) * e.w * 0.32;
      ctx.beginPath();
      ctx.arc(e.x + sway + rx, top + ry, e.w * 0.62, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(e.x + sway - e.w * 0.3, top - e.w * 0.32, e.w * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawRock(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  ctx.save();
  ctx.beginPath();
  const pts = 9;
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const r = 0.62 + hash01(e.seed, i) * 0.38;
    const px = e.x + Math.cos(a) * e.w * 0.5 * r;
    const py = e.y + Math.sin(a) * e.h * 0.55 * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(0, e.y - e.h / 2, 0, e.y + e.h / 2);
  g.addColorStop(0, mix(pal.rock, '#ffffff', 0.28));
  g.addColorStop(1, mix(pal.rock, '#000000', 0.35));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawKing(ctx: CanvasRenderingContext2D, e: Entity, scene: Scene): void {
  const side = (e.owner === 1 ? 1 : 0) as Side;
  const bob = Math.sin(scene.time * 2 + e.seed) * 1.4;
  const x = e.x;
  const y = e.y + bob;
  const dir = facing(side);
  ctx.save();
  // Cloak.
  ctx.fillStyle = TEAM[side]!;
  ctx.beginPath();
  ctx.moveTo(x - 11, y + 24);
  ctx.quadraticCurveTo(x - 13, y - 6, x, y - 12);
  ctx.quadraticCurveTo(x + 13, y - 6, x + 11, y + 24);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x - 11, y + 20, 22, 4);
  // Head.
  ctx.fillStyle = '#e8c39a';
  ctx.beginPath();
  ctx.arc(x + dir * 1.5, y - 17, 6.5, 0, Math.PI * 2);
  ctx.fill();
  // Beard.
  ctx.fillStyle = '#e6e1d6';
  ctx.beginPath();
  ctx.ellipse(x + dir * 2, y - 13, 5, 5.5, 0, 0, Math.PI);
  ctx.fill();
  // Crown.
  ctx.fillStyle = '#f0c14b';
  ctx.beginPath();
  ctx.moveTo(x - 6, y - 22);
  ctx.lineTo(x - 6, y - 27);
  ctx.lineTo(x - 3, y - 24);
  ctx.lineTo(x, y - 29);
  ctx.lineTo(x + 3, y - 24);
  ctx.lineTo(x + 6, y - 27);
  ctx.lineTo(x + 6, y - 22);
  ctx.closePath();
  ctx.fill();
  const shine = 0.4 + 0.6 * Math.abs(Math.sin(scene.time * 1.3 + e.seed));
  ctx.fillStyle = `rgba(255,255,220,${shine * 0.5})`;
  ctx.fillRect(x - 2, y - 27, 2, 3);
  // Sceptre.
  ctx.strokeStyle = '#c9a34a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + dir * 10, y + 22);
  ctx.lineTo(x + dir * 12, y - 18);
  ctx.stroke();
  ctx.restore();

  drawHealthBar(ctx, e, e.y - e.h / 2 - 14, 42, TEAM[side]!);
}

function drawCannon(ctx: CanvasRenderingContext2D, e: Entity, scene: Scene): void {
  const side = (e.owner === 1 ? 1 : 0) as Side;
  const def = CANNONS[e.cannon ?? 'field'];
  const dir = facing(side);
  const isMine = scene.you === side;
  const selected = isMine && e.id === scene.selected;
  const elevation = e.elevation ?? 45;
  const a = (-elevation * Math.PI) / 180;

  ctx.save();
  if (e.firedThisTurn) ctx.globalAlpha = 0.72;

  if (selected) {
    const pulse = 0.5 + 0.5 * Math.sin(scene.time * 4);
    ctx.save();
    ctx.strokeStyle = `rgba(255,214,120,${0.35 + pulse * 0.45})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(e.x, e.y + e.h * 0.35, e.w * 0.9, e.h * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Wheels.
  const wheelY = e.y + e.h / 2 - 5;
  for (const wx of [e.x - dir * 10, e.x + dir * 8]) {
    ctx.fillStyle = '#4a3520';
    ctx.beginPath();
    ctx.arc(wx, wheelY, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2c1f11';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.save();
    ctx.translate(wx, wheelY);
    ctx.rotate(e.seed);
    ctx.strokeStyle = 'rgba(20,14,8,0.8)';
    ctx.lineWidth = 1.4;
    for (let s = 0; s < 4; s++) {
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(8, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Carriage.
  ctx.fillStyle = '#6b4a2a';
  ctx.beginPath();
  ctx.moveTo(e.x - dir * e.w * 0.5, e.y + e.h * 0.4);
  ctx.lineTo(e.x + dir * e.w * 0.45, e.y + e.h * 0.15);
  ctx.lineTo(e.x + dir * e.w * 0.4, e.y - e.h * 0.1);
  ctx.lineTo(e.x - dir * e.w * 0.5, e.y + e.h * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(30,20,10,0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Barrel.
  ctx.save();
  ctx.translate(e.x, e.y - e.h * 0.15);
  ctx.rotate(dir === 1 ? a : Math.PI - a);
  const len = def.barrelLength;
  const bh = e.cannon === 'mortar' ? 15 : 11;
  const bg = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
  bg.addColorStop(0, '#8d8c93');
  bg.addColorStop(0.35, '#4a4952');
  bg.addColorStop(1, '#25242a');
  ctx.fillStyle = bg;
  roundRect(ctx, -8, -bh / 2, len + 8, bh, 3);
  ctx.fill();
  ctx.fillStyle = '#6a6870';
  ctx.fillRect(len - 6, -bh / 2 - 1.6, 6, bh + 3.2);
  ctx.fillStyle = '#2f2e34';
  ctx.beginPath();
  ctx.arc(-6, 0, bh * 0.62, 0, Math.PI * 2);
  ctx.fill();
  // Upgrade bands.
  const powder = e.upgrades?.powder ?? 0;
  for (let i = 0; i < powder; i++) {
    ctx.fillStyle = '#d8a94a';
    ctx.fillRect(6 + i * 7, -bh / 2 - 1, 3, bh + 2);
  }
  ctx.restore();

  // Pennant.
  const poleX = e.x - dir * e.w * 0.42;
  const poleTop = e.y - e.h * 0.5 - 22;
  ctx.strokeStyle = '#3a2b1a';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(poleX, e.y + e.h * 0.2);
  ctx.lineTo(poleX, poleTop);
  ctx.stroke();
  const wave = Math.sin(scene.time * 3 + e.seed) * 3 + scene.world.wind * 5;
  ctx.fillStyle = TEAM[side]!;
  ctx.beginPath();
  ctx.moveTo(poleX, poleTop);
  ctx.lineTo(poleX + dir * 15 + wave, poleTop + 4);
  ctx.lineTo(poleX, poleTop + 10);
  ctx.closePath();
  ctx.fill();

  // Sights upgrade marker.
  if ((e.upgrades?.sights ?? 0) > 0) {
    ctx.fillStyle = 'rgba(216,169,74,0.9)';
    ctx.beginPath();
    ctx.arc(e.x + dir * 4, e.y - e.h * 0.45, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  drawHealthBar(ctx, e, e.y - e.h / 2 - 11, 38, TEAM[side]!);
}

function drawFlames(ctx: CanvasRenderingContext2D, e: Entity, time: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    const t = time * 5 + i * 1.7 + e.seed;
    const fx = e.x + Math.sin(t) * e.w * 0.3 + (hash01(e.seed, i) - 0.5) * e.w * 0.5;
    const fy = e.y - e.h / 2 - 2 + Math.sin(t * 1.3) * 3;
    const h = 12 + Math.abs(Math.sin(t * 0.9)) * 14;
    const g = ctx.createRadialGradient(fx, fy - h * 0.3, 1, fx, fy - h * 0.3, h * 0.7);
    g.addColorStop(0, 'rgba(255,230,150,0.85)');
    g.addColorStop(0.5, 'rgba(255,140,40,0.5)');
    g.addColorStop(1, 'rgba(180,40,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(fx, fy - h * 0.35, h * 0.36, h * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  e: Entity,
  y: number,
  width: number,
  colour: string,
): void {
  const pct = Math.max(0, e.hp / e.maxHp);
  if (pct >= 0.999) return;
  const x = e.x - width / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  roundRect(ctx, x - 1, y - 1, width + 2, 6, 3);
  ctx.fill();
  ctx.fillStyle = pct > 0.5 ? colour : pct > 0.25 ? '#e8b34a' : '#e0574a';
  roundRect(ctx, x, y, width * pct, 4, 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

function drawGhosts(ctx: CanvasRenderingContext2D, scene: Scene): void {
  ctx.save();
  ctx.setLineDash([6, 9]);
  ctx.lineWidth = 1.4;
  for (const g of scene.ghosts) {
    ctx.strokeStyle = g.side === 0 ? 'rgba(224,87,74,0.30)' : 'rgba(90,162,230,0.30)';
    ctx.beginPath();
    for (let i = 0; i < g.pts.length; i += 2) {
      if (i === 0) ctx.moveTo(g.pts[0]!, g.pts[1]!);
      else ctx.lineTo(g.pts[i]!, g.pts[i + 1]!);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawProjectiles(ctx: CanvasRenderingContext2D, scene: Scene): void {
  for (const p of scene.projectiles) {
    const def = AMMO[p.ammo];
    ctx.save();
    // Trail.
    if (p.trail.length > 1) {
      ctx.lineCap = 'round';
      for (let i = 1; i < p.trail.length; i++) {
        const t = i / p.trail.length;
        ctx.strokeStyle = withAlpha(def.trail, t * 0.5);
        ctx.lineWidth = 1 + t * def.radius * 0.7;
        ctx.beginPath();
        ctx.moveTo(p.trail[i - 1]!.x, p.trail[i - 1]!.y);
        ctx.lineTo(p.trail[i]!.x, p.trail[i]!.y);
        ctx.stroke();
      }
    }
    const r = def.radius;
    const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.2, p.x, p.y, r * 1.6);
    g.addColorStop(0, def.id === 'round' || def.id === 'chain' ? '#8b8b93' : def.trail);
    g.addColorStop(0.6, def.id === 'round' || def.id === 'chain' ? '#3a3940' : mix(def.trail, '#7a2a10', 0.5));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 1.6, 0, Math.PI * 2);
    ctx.fill();
    if (def.incendiary || def.blast > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = withAlpha(def.trail, 0.5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawAim(ctx: CanvasRenderingContext2D, scene: Scene, cam: Camera): void {
  if (!scene.aim || scene.aimSide === -1) return;
  const gun = scene.entities.find((e) => e.id === scene.selected && e.kind === 'cannon');
  if (!gun) return;
  const side = (gun.owner === 1 ? 1 : 0) as Side;
  const dir = facing(side);
  const def = CANNONS[gun.cannon ?? 'field'];
  const a = (-scene.aim.elevation * Math.PI) / 180;
  const ox = gun.x + Math.cos(a) * dir * def.barrelLength;
  const oy = gun.y - def.height * 0.15 + Math.sin(a) * def.barrelLength;
  const reach = 60 + scene.aim.power * 2.6;

  ctx.save();
  ctx.setLineDash([7, 7]);
  ctx.lineWidth = 2 / cam.zoom;
  ctx.strokeStyle = side === scene.you ? 'rgba(255,214,120,0.75)' : 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ox + Math.cos(a) * dir * reach, oy + Math.sin(a) * reach);
  ctx.stroke();
  ctx.setLineDash([]);
  // Arrow head.
  const hx = ox + Math.cos(a) * dir * reach;
  const hy = oy + Math.sin(a) * reach;
  ctx.fillStyle = side === scene.you ? 'rgba(255,214,120,0.9)' : 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.arc(hx, hy, 4 / cam.zoom + 2, 0, Math.PI * 2);
  ctx.fill();
  // Elevation arc.
  ctx.strokeStyle = 'rgba(255,214,120,0.35)';
  ctx.lineWidth = 1.5 / cam.zoom;
  ctx.beginPath();
  ctx.arc(gun.x, gun.y - def.height * 0.15, 34, dir === 1 ? a : Math.PI - a, dir === 1 ? 0 : Math.PI, dir !== 1);
  ctx.stroke();
  ctx.restore();
}

function drawPlacing(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const p = scene.placing;
  if (!p) return;
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = p.ok ? 'rgba(140,220,130,0.35)' : 'rgba(230,90,70,0.35)';
  ctx.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
  ctx.strokeStyle = p.ok ? '#8fd67f' : '#e0574a';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Effects layers
// ---------------------------------------------------------------------------

function drawParticles(ctx: CanvasRenderingContext2D, fx: Fx): void {
  ctx.save();
  for (const p of fx.particles) {
    const t = p.life / p.max;
    switch (p.kind) {
      case 'smoke':
      case 'dust': {
        const size = p.size * (2.4 - t * 1.2);
        ctx.globalAlpha = Math.min(0.5, t * 0.6);
        ctx.fillStyle = p.hue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'fire': {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, t * 1.5);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * (1.8 - t));
        g.addColorStop(0, p.hue);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1.8 - t), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      case 'spark':
      case 'ember': {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, t * 1.6);
        ctx.fillStyle = p.hue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      case 'debris': {
        ctx.globalAlpha = Math.min(1, t * 2);
        ctx.fillStyle = p.hue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.75);
        ctx.restore();
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
  for (const r of fx.rings) {
    const t = r.life / r.maxLife;
    ctx.strokeStyle = `${r.colour}${(t * 0.75).toFixed(3)})`;
    ctx.lineWidth = 2 + t * 6;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFloatText(ctx: CanvasRenderingContext2D, fx: Fx, cam: Camera): void {
  ctx.save();
  ctx.textAlign = 'center';
  for (const t of fx.texts) {
    const alpha = Math.min(1, t.life * 1.6);
    ctx.globalAlpha = alpha;
    const size = t.size / cam.zoom;
    ctx.font = `700 ${size}px ui-monospace, Menlo, monospace`;
    ctx.lineWidth = 3 / cam.zoom;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(t.text, t.x, t.y);
    ctx.fillStyle = t.colour;
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.restore();
}

function drawWindStreaks(ctx: CanvasRenderingContext2D, cam: Camera, scene: Scene, pal: Palette): void {
  const w = scene.world.wind;
  if (Math.abs(w) < 0.12) return;
  ctx.save();
  ctx.strokeStyle = withAlpha(pal.cloud, Math.min(0.22, Math.abs(w) * 0.3));
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 26; i++) {
    const speed = 90 + hash01(i, 31) * 220;
    const y = (hash01(i, 37) * cam.h * 0.75) | 0;
    const x = ((scene.time * speed * w + hash01(i, 41) * cam.w * 2) % (cam.w + 260)) - 130;
    const len = 22 + hash01(i, 43) * 46;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len * Math.sign(w), y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Arrows at the screen edge pointing at things you cannot currently see. */
function drawOffscreenMarkers(ctx: CanvasRenderingContext2D, cam: Camera, scene: Scene): void {
  const marks = scene.entities.filter((e) => e.kind === 'king' || (e.kind === 'cannon' && e.owner === scene.you));
  ctx.save();
  for (const e of marks) {
    const s = worldToScreen(cam, e.x, e.y);
    if (s.x > 30 && s.x < cam.w - 30) continue;
    const side = (e.owner === 1 ? 1 : 0) as Side;
    const edge = s.x <= 30 ? 18 : cam.w - 18;
    const y = Math.max(90, Math.min(cam.h - 130, s.y));
    ctx.fillStyle = TEAM[side]!;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    const d = s.x <= 30 ? -1 : 1;
    ctx.moveTo(edge + d * 8, y);
    ctx.lineTo(edge - d * 6, y - 8);
    ctx.lineTo(edge - d * 6, y + 8);
    ctx.closePath();
    ctx.fill();
    if (e.kind === 'king') {
      ctx.font = '12px serif';
      ctx.textAlign = 'center';
      ctx.fillText('♔', edge - d * 2, y - 12);
    }
  }
  ctx.restore();
}

function drawVignette(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, flash: number): void {
  if (flash > 0.01) {
    ctx.fillStyle = `rgba(255,238,208,${Math.min(0.45, flash * 0.4)})`;
    ctx.fillRect(0, 0, cam.w, cam.h);
  }
  const g = ctx.createRadialGradient(
    cam.w / 2,
    cam.h / 2,
    Math.min(cam.w, cam.h) * 0.35,
    cam.w / 2,
    cam.h / 2,
    Math.max(cam.w, cam.h) * 0.75,
  );
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cam.w, cam.h);
  ctx.fillStyle = pal.ambient;
  ctx.fillRect(0, 0, cam.w, cam.h);
}

// ---------------------------------------------------------------------------

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(h: string): [number, number, number] {
  if (h.startsWith('rgb')) {
    const m = h.match(/\d+/g);
    if (m) return [Number(m[0]), Number(m[1]), Number(m[2])];
  }
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function withAlpha(colour: string, alpha: number): string {
  const [r, g, b] = parseHex(colour);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function terrainY(terrain: number[], x: number): number {
  return surfaceAt(terrain, Math.max(0, Math.min(WORLD_W - 1, x)));
}
