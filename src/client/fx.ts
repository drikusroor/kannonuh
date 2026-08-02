import { WORLD_H, WORLD_W } from '../shared/constants.ts';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  tx: number;
  ty: number;
  tzoom: number;
  shake: number;
  shakeX: number;
  shakeY: number;
  w: number;
  h: number;
  /** Screen pixels hidden behind the HUD at the top and bottom. */
  padTop: number;
  padBottom: number;
  /** The slab of world worth looking at, derived from the terrain. */
  bounds: { x0: number; x1: number; y0: number; y1: number };
}

/** Vertical centre of the part of the canvas the HUD is not covering. */
export function viewCy(cam: Camera): number {
  return cam.h / 2 + (cam.padTop - cam.padBottom) / 2;
}

/** Height of the part of the canvas the player can actually see the field in. */
export function viewH(cam: Camera): number {
  return Math.max(160, cam.h - cam.padTop - cam.padBottom);
}

export function makeCamera(): Camera {
  return {
    x: WORLD_W / 2,
    y: WORLD_H * 0.6,
    zoom: 0.5,
    tx: WORLD_W / 2,
    ty: WORLD_H * 0.6,
    tzoom: 0.5,
    shake: 0,
    shakeX: 0,
    shakeY: 0,
    w: 1280,
    h: 720,
    padTop: 0,
    padBottom: 0,
    bounds: { x0: 0, x1: WORLD_W, y0: WORLD_H * 0.25, y1: WORLD_H * 0.85 },
  };
}

/** Sky headroom above the highest ground; enough to watch a lobbed shell. */
const SKY_HEADROOM = 900;
const GROUND_MARGIN = 70;

export function camBounds(cam: Camera, terrain: number[]): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const y of terrain) {
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  cam.bounds = {
    x0: 0,
    x1: WORLD_W,
    y0: lo - SKY_HEADROOM,
    y1: hi + GROUND_MARGIN,
  };
}

/** Clamps an axis to the bounds, centring when the view is wider than the slab. */
function fence(value: number, half: number, lo: number, hi: number): number {
  if (hi - lo <= half * 2) return (lo + hi) / 2;
  return clamp(value, lo + half, hi - half);
}

/**
 * Vertical framing is not symmetric: the horizon wants to sit around three
 * quarters down the screen so there is sky to watch the shot arc through.
 */
function fenceY(value: number, halfH: number, lo: number, hi: number): number {
  const bottom = hi - halfH * 0.62;
  const top = lo + halfH * 0.5;
  if (bottom <= top) return bottom;
  return clamp(value, top, bottom);
}

export function camLookAt(cam: Camera, x: number, y: number, zoom?: number): void {
  cam.tx = x;
  cam.ty = y;
  if (zoom !== undefined) cam.tzoom = zoom;
}

export function camSnap(cam: Camera): void {
  cam.x = cam.tx;
  cam.y = cam.ty;
  cam.zoom = cam.tzoom;
}

/** Zoom so that a world-space span fits the viewport, with padding. */
export function camFit(cam: Camera, x0: number, x1: number, y0: number, y1: number, pad = 90): void {
  const w = Math.max(320, Math.abs(x1 - x0) + pad * 2);
  const h = Math.max(240, Math.abs(y1 - y0) + pad * 2);
  const zoom = Math.min(cam.w / w, viewH(cam) / h);
  cam.tzoom = clamp(zoom, 0.22, 1.9);
  cam.tx = (x0 + x1) / 2;
  cam.ty = (y0 + y1) / 2;
}

export function camUpdate(cam: Camera, dt: number, instant = false): void {
  const k = instant ? 1 : 1 - Math.pow(0.0016, dt);
  cam.x += (cam.tx - cam.x) * k;
  cam.y += (cam.ty - cam.y) * k;
  cam.zoom += (cam.tzoom - cam.zoom) * (instant ? 1 : 1 - Math.pow(0.004, dt));

  // Keep the battlefield on screen.
  const halfW = cam.w / 2 / cam.zoom;
  const halfH = viewH(cam) / 2 / cam.zoom;
  const b = cam.bounds;
  // Allow the view to hang over the edges so a corner castle can be centred.
  cam.x = fence(cam.x, halfW * 0.34, b.x0, b.x1);
  cam.y = fenceY(cam.y, halfH, b.y0, b.y1);

  if (cam.shake > 0.01) {
    cam.shake *= Math.pow(0.0009, dt);
    const a = Math.random() * Math.PI * 2;
    cam.shakeX = Math.cos(a) * cam.shake;
    cam.shakeY = Math.sin(a) * cam.shake;
  } else {
    cam.shake = 0;
    cam.shakeX = 0;
    cam.shakeY = 0;
  }
}

export function worldToScreen(cam: Camera, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - cam.x) * cam.zoom + cam.w / 2 + cam.shakeX,
    y: (y - cam.y) * cam.zoom + viewCy(cam) + cam.shakeY,
  };
}

export function screenToWorld(cam: Camera, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - cam.w / 2 - cam.shakeX) / cam.zoom + cam.x,
    y: (y - viewCy(cam) - cam.shakeY) / cam.zoom + cam.y,
  };
}

export function shake(cam: Camera, amount: number): void {
  cam.shake = Math.min(46, cam.shake + amount);
}

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

export type ParticleKind = 'smoke' | 'spark' | 'debris' | 'fire' | 'dust' | 'ember';

export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  hue: string;
  rot: number;
  vrot: number;
  grav: number;
  drag: number;
  ground: number;
}

export interface Ring {
  x: number;
  y: number;
  r: number;
  max: number;
  life: number;
  maxLife: number;
  colour: string;
}

export interface FloatText {
  x: number;
  y: number;
  text: string;
  colour: string;
  life: number;
  size: number;
}

export class Fx {
  particles: Particle[] = [];
  rings: Ring[] = [];
  texts: FloatText[] = [];
  flash = 0;

  clear(): void {
    this.particles.length = 0;
    this.rings.length = 0;
    this.texts.length = 0;
    this.flash = 0;
  }

  private push(p: Particle): void {
    if (this.particles.length > 1400) this.particles.shift();
    this.particles.push(p);
  }

  smoke(x: number, y: number, count: number, spread = 26, tint = '#8c8378'): void {
    for (let i = 0; i < count; i++) {
      this.push({
        kind: 'smoke',
        x: x + rand(-spread, spread),
        y: y + rand(-spread, spread),
        vx: rand(-24, 24),
        vy: rand(-46, -12),
        life: rand(0.9, 2.1),
        max: 2.1,
        size: rand(9, 26),
        hue: tint,
        rot: 0,
        vrot: 0,
        grav: -6,
        drag: 0.8,
        ground: Infinity,
      });
    }
  }

  /** Small puff shed by a shell in flight. */
  trailPuff(x: number, y: number, tint = '#cdc6ba'): void {
    this.push({
      kind: 'smoke',
      x: x + rand(-2, 2),
      y: y + rand(-2, 2),
      vx: rand(-8, 8),
      vy: rand(-16, -4),
      life: rand(0.35, 0.8),
      max: 0.8,
      size: rand(1.6, 4.2),
      hue: tint,
      rot: 0,
      vrot: 0,
      grav: -8,
      drag: 1.4,
      ground: Infinity,
    });
  }

  muzzleSmoke(x: number, y: number, dx: number, dy: number): void {
    for (let i = 0; i < 16; i++) {
      const s = rand(30, 190);
      this.push({
        kind: 'smoke',
        x,
        y,
        vx: dx * s + rand(-40, 40),
        vy: dy * s + rand(-40, 20),
        life: rand(0.5, 1.4),
        max: 1.4,
        size: rand(6, 18),
        hue: '#d8cfc0',
        rot: 0,
        vrot: 0,
        grav: -14,
        drag: 1.6,
        ground: Infinity,
      });
    }
    for (let i = 0; i < 10; i++) {
      const s = rand(120, 460);
      this.push({
        kind: 'spark',
        x,
        y,
        vx: dx * s + rand(-60, 60),
        vy: dy * s + rand(-60, 60),
        life: rand(0.12, 0.4),
        max: 0.4,
        size: rand(1.4, 3.4),
        hue: '#ffd27a',
        rot: 0,
        vrot: 0,
        grav: 320,
        drag: 1.2,
        ground: Infinity,
      });
    }
  }

  explosion(x: number, y: number, radius: number, tint: 'shell' | 'barrel' | 'fire'): void {
    const n = Math.round(10 + radius * 0.34);
    const colours =
      tint === 'fire'
        ? ['#ff7a2a', '#ffb347', '#ffe08a']
        : tint === 'barrel'
          ? ['#ffd166', '#ff9a3c', '#e8613c']
          : ['#ffcf8a', '#ff9b4a', '#c9552f'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(40, radius * 4.6);
      this.push({
        kind: 'fire',
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 40,
        life: rand(0.22, 0.6),
        max: 0.6,
        size: rand(radius * 0.16, radius * 0.46),
        hue: colours[i % colours.length]!,
        rot: 0,
        vrot: 0,
        grav: -60,
        drag: 2.4,
        ground: Infinity,
      });
    }
    this.smoke(x, y, Math.round(6 + radius * 0.18), radius * 0.35, '#6f6862');
    for (let i = 0; i < Math.round(6 + radius * 0.16); i++) {
      const a = rand(-Math.PI, 0);
      const s = rand(120, 460);
      this.push({
        kind: 'debris',
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: rand(0.8, 2),
        max: 2,
        size: rand(2.5, 7),
        hue: '#5b4b3a',
        rot: Math.random() * 6,
        vrot: rand(-9, 9),
        grav: 780,
        drag: 0.12,
        ground: y + 8,
      });
    }
    this.rings.push({
      x,
      y,
      r: radius * 0.25,
      max: radius * 1.5,
      life: 0.42,
      maxLife: 0.42,
      colour: tint === 'fire' ? 'rgba(255,170,90,' : 'rgba(255,225,190,',
    });
    this.flash = Math.min(1, this.flash + radius / 420);
  }

  debris(x: number, y: number, count: number, colour: string, groundY: number): void {
    for (let i = 0; i < count; i++) {
      const a = rand(-Math.PI * 0.95, -Math.PI * 0.05);
      const s = rand(60, 300);
      this.push({
        kind: 'debris',
        x: x + rand(-10, 10),
        y: y + rand(-10, 10),
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: rand(0.9, 2.4),
        max: 2.4,
        size: rand(2.5, 8),
        hue: colour,
        rot: Math.random() * 6,
        vrot: rand(-10, 10),
        grav: 820,
        drag: 0.1,
        ground: groundY,
      });
    }
  }

  dust(x: number, y: number, count: number): void {
    for (let i = 0; i < count; i++) {
      this.push({
        kind: 'dust',
        x: x + rand(-18, 18),
        y,
        vx: rand(-70, 70),
        vy: rand(-90, -20),
        life: rand(0.5, 1.4),
        max: 1.4,
        size: rand(5, 16),
        hue: '#9c8a72',
        rot: 0,
        vrot: 0,
        grav: 120,
        drag: 1.1,
        ground: Infinity,
      });
    }
  }

  ember(x: number, y: number, count = 3): void {
    for (let i = 0; i < count; i++) {
      this.push({
        kind: 'ember',
        x: x + rand(-8, 8),
        y: y + rand(-10, 6),
        vx: rand(-14, 14),
        vy: rand(-48, -18),
        life: rand(0.4, 1.1),
        max: 1.1,
        size: rand(1.5, 3.6),
        hue: Math.random() < 0.5 ? '#ffb03a' : '#ff6a2a',
        rot: 0,
        vrot: 0,
        grav: -30,
        drag: 1,
        ground: Infinity,
      });
    }
  }

  text(x: number, y: number, text: string, colour: string, size = 18): void {
    if (this.texts.length > 40) this.texts.shift();
    this.texts.push({ x, y, text, colour, life: 1.3, size });
  }

  update(dt: number): void {
    this.flash = Math.max(0, this.flash - dt * 3.4);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.grav * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      if (p.y > p.ground) {
        p.y = p.ground;
        p.vy *= -0.28;
        p.vx *= 0.6;
        p.vrot *= 0.5;
        if (Math.abs(p.vy) < 24) {
          p.vy = 0;
          p.vx *= 0.7;
          p.grav = 0;
        }
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      r.life -= dt;
      if (r.life <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      const t = 1 - r.life / r.maxLife;
      r.r = r.max * (1 - Math.pow(1 - t, 2.2));
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i]!;
      t.life -= dt;
      t.y -= dt * 34;
      if (t.life <= 0) this.texts.splice(i, 1);
    }
  }
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
