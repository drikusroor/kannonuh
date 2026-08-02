import { COLS, COL_W, WORLD_H, WORLD_W } from './constants.ts';
import { Rng, valueNoise } from './rng.ts';

export const GROUND_FLOOR = WORLD_H - 60;
export const SKY_CEILING = 240;

/** Surface height at an arbitrary world X, linearly interpolated between columns. */
export function surfaceAt(terrain: number[], x: number): number {
  const p = x / COL_W - 0.5;
  if (p <= 0) return terrain[0]!;
  if (p >= COLS - 1) return terrain[COLS - 1]!;
  const i = Math.floor(p);
  const f = p - i;
  return terrain[i]! * (1 - f) + terrain[i + 1]! * f;
}

/** Surface slope in radians (positive = ground rises to the right). */
export function slopeAt(terrain: number[], x: number): number {
  const a = surfaceAt(terrain, x - 8);
  const b = surfaceAt(terrain, x + 8);
  return Math.atan2(-(b - a), 16);
}

/** Blow a bowl-shaped crater out of the heightmap. */
export function carve(terrain: number[], cx: number, cy: number, r: number): void {
  if (r <= 0) return;
  const lo = Math.max(0, Math.floor((cx - r) / COL_W));
  const hi = Math.min(COLS - 1, Math.ceil((cx + r) / COL_W));
  for (let i = lo; i <= hi; i++) {
    const dx = i * COL_W + COL_W / 2 - cx;
    const inner = r * r - dx * dx;
    if (inner <= 0) continue;
    const h = Math.sqrt(inner);
    const top = cy - h;
    const bottom = cy + h;
    const surface = terrain[i]!;
    // Only bite in where the blast actually reaches down through the surface.
    if (top <= surface && bottom > surface) {
      terrain[i] = Math.min(GROUND_FLOOR, bottom);
    }
  }
}

/** Small piles of debris thrown up around a crater lip; keeps craters from looking stamped. */
export function mound(terrain: number[], cx: number, r: number, amount: number): void {
  const lo = Math.max(0, Math.floor((cx - r * 1.6) / COL_W));
  const hi = Math.min(COLS - 1, Math.ceil((cx + r * 1.6) / COL_W));
  for (let i = lo; i <= hi; i++) {
    const dx = Math.abs(i * COL_W + COL_W / 2 - cx);
    if (dx < r * 0.75 || dx > r * 1.6) continue;
    const t = 1 - (dx - r * 0.75) / (r * 0.85);
    terrain[i] = Math.max(SKY_CEILING, terrain[i]! - amount * t);
  }
}

/**
 * The one true way to modify the ground: a bowl plus a debris lip. Server and
 * client both call this for every `crater` event so the two never drift.
 */
export function applyCrater(terrain: number[], x: number, y: number, r: number): void {
  carve(terrain, x, y + r * 0.35, r);
  mound(terrain, x, r, r * 0.17);
}

export interface TerrainPlan {
  terrain: number[];
  /** Flat ground the two castles are built on. */
  bases: [{ x: number; y: number }, { x: number; y: number }];
}

const BASE_HALF_WIDTH = 230;

export function generateTerrain(rng: Rng): TerrainPlan {
  const rolling = valueNoise(rng.fork(11), COLS, 5, 0.52);
  const detail = valueNoise(rng.fork(29), COLS, 7, 0.42);

  const mid = WORLD_H * 0.66;
  const amplitude = rng.range(150, 250);
  const terrain = new Array<number>(COLS);
  for (let i = 0; i < COLS; i++) {
    terrain[i] = mid + (rolling[i]! - 0.5) * amplitude * 2 + (detail[i]! - 0.5) * 46;
  }

  // A central feature makes each map read differently at a glance.
  const feature = rng.int(0, 3);
  const centre = COLS / 2 + rng.range(-40, 40);
  if (feature === 0) {
    // Mountain ridge straight down the middle: you must lob over it.
    const width = rng.range(50, 84);
    const height = rng.range(230, 340);
    for (let i = 0; i < COLS; i++) {
      const d = Math.abs(i - centre) / width;
      if (d < 1.6) terrain[i]! -= height * Math.exp(-d * d * 1.6);
    }
  } else if (feature === 1) {
    // Deep gorge: overshoot and your shot disappears.
    const width = rng.range(30, 55);
    const depth = rng.range(170, 250);
    for (let i = 0; i < COLS; i++) {
      const d = Math.abs(i - centre) / width;
      if (d < 1.6) terrain[i] = Math.min(GROUND_FLOOR, terrain[i]! + depth * Math.exp(-d * d * 1.4));
    }
  } else if (feature === 2) {
    // Twin knolls with a saddle between them.
    for (const sign of [-1, 1]) {
      const c = centre + sign * rng.range(60, 90);
      const width = rng.range(28, 44);
      const height = rng.range(140, 210);
      for (let i = 0; i < COLS; i++) {
        const d = Math.abs(i - c) / width;
        if (d < 1.8) terrain[i]! -= height * Math.exp(-d * d * 1.5);
      }
    }
  }

  // Flatten the two building plots.
  const bases: TerrainPlan['bases'] = [
    { x: rng.range(230, 330), y: 0 },
    { x: WORLD_W - rng.range(230, 330), y: 0 },
  ];
  for (const base of bases) {
    const c = base.x / COL_W;
    const half = BASE_HALF_WIDTH / COL_W;
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, Math.floor(c - half)); i <= Math.min(COLS - 1, Math.ceil(c + half)); i++) {
      sum += terrain[i]!;
      n++;
    }
    const level = Math.max(SKY_CEILING + 260, Math.min(GROUND_FLOOR - 120, sum / n));
    base.y = level;
    for (let i = 0; i < COLS; i++) {
      const d = Math.abs(i - c);
      if (d <= half) {
        terrain[i] = level;
      } else if (d <= half * 2.1) {
        // Blend the plateau back into the wild ground.
        const f = (d - half) / (half * 1.1);
        const s = f * f * (3 - 2 * f);
        terrain[i] = level * (1 - s) + terrain[i]! * s;
      }
    }
  }

  for (let i = 0; i < COLS; i++) {
    terrain[i] = Math.max(SKY_CEILING + 120, Math.min(GROUND_FLOOR, terrain[i]!));
  }
  return { terrain, bases };
}
