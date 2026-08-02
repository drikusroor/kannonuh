import {
  CANNONS,
  COL_W,
  HP,
  WORLD_W,
  type CannonId,
  type Material,
} from './constants.ts';
import { Rng } from './rng.ts';
import { generateTerrain, surfaceAt } from './terrain.ts';
import type { Entity, EntityKind, Owner, Side, WorldState } from './types.ts';

export const BLOCK = 30;

export function facing(side: Side): 1 | -1 {
  return side === 0 ? 1 : -1;
}

export function left(e: Entity): number {
  return e.x - e.w / 2;
}
export function right(e: Entity): number {
  return e.x + e.w / 2;
}
export function top(e: Entity): number {
  return e.y - e.h / 2;
}
export function bottom(e: Entity): number {
  return e.y + e.h / 2;
}

export function isSolid(e: Entity): boolean {
  return e.hp > 0;
}

/** Trees do not stop a cannonball; everything else does. */
export function blocksShot(e: Entity): boolean {
  return e.hp > 0 && e.kind !== 'tree';
}

export function pointInside(e: Entity, x: number, y: number, pad = 0): boolean {
  return x >= left(e) - pad && x <= right(e) + pad && y >= top(e) - pad && y <= bottom(e) + pad;
}

/** Shortest distance from a point to an entity's box (0 when inside). */
export function distToBox(e: Entity, x: number, y: number): number {
  const dx = Math.max(left(e) - x, 0, x - right(e));
  const dy = Math.max(top(e) - y, 0, y - bottom(e));
  return Math.hypot(dx, dy);
}

export function isFlammable(e: Entity): boolean {
  return e.mat === 'wood' || e.mat === 'powder';
}

export function findEntity(world: WorldState, id: number): Entity | undefined {
  return world.entities.find((e) => e.id === id);
}

export function kingOf(world: WorldState, side: Side): Entity | undefined {
  return world.entities.find((e) => e.kind === 'king' && e.owner === side && e.hp > 0);
}

export function cannonsOf(world: WorldState, side: Side): Entity[] {
  return world.entities.filter((e) => e.kind === 'cannon' && e.owner === side && e.hp > 0);
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

let entitySeedCounter = 1;

export function makeEntity(
  world: WorldState,
  kind: EntityKind,
  owner: Owner,
  x: number,
  y: number,
  w: number,
  h: number,
  hp: number,
  mat: Material,
  extra: Partial<Entity> = {},
): Entity {
  const e: Entity = {
    id: world.nextId++,
    kind,
    owner,
    x,
    y,
    w,
    h,
    hp,
    maxHp: hp,
    mat,
    seed: (Math.imul(world.seed ^ world.nextId, 0x9e3779b1) >>> 0) % 100000 || entitySeedCounter++,
    ...extra,
  };
  world.entities.push(e);
  return e;
}

export function placeCannon(world: WorldState, side: Side, cannon: CannonId, x: number): Entity {
  const def = CANNONS[cannon];
  const groundY = surfaceAt(world.terrain, x);
  return makeEntity(world, 'cannon', side, x, groundY - def.height / 2, def.width, def.height, def.hp, 'metal', {
    cannon,
    elevation: 45,
    power: 62,
    ammo: 'round',
    upgrades: {},
    firedThisTurn: false,
  });
}

// ---------------------------------------------------------------------------
// World generation
// ---------------------------------------------------------------------------

export function createWorld(seed: number): WorldState {
  const rng = new Rng(seed);
  const { terrain, bases } = generateTerrain(rng);
  const world: WorldState = {
    seed,
    terrain,
    entities: [],
    nextId: 1,
    wind: 0,
    timeOfDay: rng.next(),
    theme: rng.int(0, 3),
  };

  for (const side of [0, 1] as Side[]) {
    buildCastle(world, side, bases[side].x, bases[side].y, rng);
  }
  scatterScenery(world, rng, bases[0].x, bases[1].x);
  world.wind = rollWind(rng);
  return world;
}

/**
 * Castle layout, mirrored per side. Offsets are "towards the enemy = positive"
 * so the same numbers describe both keeps.
 */
function buildCastle(world: WorldState, side: Side, bx: number, groundY: number, rng: Rng): void {
  const dir = facing(side);
  const put = (rel: number, row: number, kind: 'block' | 'timber' = 'block') => {
    const x = bx + rel * dir;
    const y = groundY - BLOCK / 2 - row * BLOCK;
    return makeEntity(
      world,
      kind,
      side,
      x,
      y,
      BLOCK,
      BLOCK,
      kind === 'block' ? HP.stoneBlock : HP.timber,
      kind === 'block' ? 'stone' : 'wood',
      { variant: rng.int(0, 3) },
    );
  };

  // Keep: back wall, front wall, roof — the king sits in the chamber between.
  for (let row = 0; row < 5; row++) {
    put(-165, row);
    put(-135, row);
    put(-45, row);
  }
  for (let rel = -165; rel <= -45; rel += BLOCK) put(rel, 5);
  // Battlement teeth on the keep.
  for (let rel = -165; rel <= -45; rel += BLOCK * 2) put(rel, 6);

  // Curtain wall out front with a tower.
  for (let row = 0; row < 4; row++) put(45, row);
  put(45, 4);

  // King in the chamber.
  const kingX = bx - 100 * dir;
  makeEntity(world, 'king', side, kingX, groundY - 24, 28, 48, HP.king, 'flesh', { variant: side });

  // One powder barrel tucked behind the curtain wall — a hazard for both sides.
  makeEntity(world, 'barrel', side, bx + 15 * dir, groundY - 16, 22, 32, HP.barrel, 'powder', {
    variant: rng.int(0, 2),
  });

  // Two starting guns, one forward and exposed, one further back.
  placeCannon(world, side, 'field', bx + 125 * dir);
  placeCannon(world, side, 'field', bx + 200 * dir);
}

function scatterScenery(world: WorldState, rng: Rng, baseA: number, baseB: number): void {
  const clear = 300;
  const lo = Math.min(baseA, baseB) + clear;
  const hi = Math.max(baseA, baseB) - clear;

  const treeCount = rng.int(9, 16);
  for (let i = 0; i < treeCount; i++) {
    const x = rng.range(lo, hi);
    const y = surfaceAt(world.terrain, x);
    makeEntity(world, 'tree', -1, x, y - 34, 26, 68, HP.tree, 'wood', { variant: rng.int(0, 3) });
  }

  const rockCount = rng.int(3, 6);
  for (let i = 0; i < rockCount; i++) {
    const x = rng.range(lo, hi);
    const y = surfaceAt(world.terrain, x);
    const w = rng.range(46, 92);
    const h = w * rng.range(0.55, 0.9);
    makeEntity(world, 'rock', -1, x, y - h / 2, w, h, HP.rock, 'stone', { variant: rng.int(0, 3) });
  }

  const barrelCount = rng.int(2, 4);
  for (let i = 0; i < barrelCount; i++) {
    const x = rng.range(lo, hi);
    const y = surfaceAt(world.terrain, x);
    makeEntity(world, 'barrel', -1, x, y - 16, 22, 32, HP.barrel, 'powder', { variant: rng.int(0, 2) });
  }
}

export function rollWind(rng: Rng): number {
  const w = rng.gauss() * 0.45;
  return Math.max(-1, Math.min(1, Math.round(w * 100) / 100));
}

// ---------------------------------------------------------------------------
// Settling — knock the ground out from under a wall and it comes down.
// ---------------------------------------------------------------------------

const FALLERS: EntityKind[] = ['block', 'timber', 'barrel', 'cannon', 'king', 'tree'];

export interface Fall {
  id: number;
  from: number;
  to: number;
  damage: number;
}

/** Drops unsupported entities onto whatever is below. Returns what moved. */
export function settle(world: WorldState): Fall[] {
  const falls = new Map<number, Fall>();
  const movable = world.entities.filter((e) => e.hp > 0 && FALLERS.includes(e.kind));

  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    // Lowest first so towers collapse from the bottom up.
    movable.sort((a, b) => b.y - a.y);
    for (const e of movable) {
      if (e.hp <= 0) continue;
      let supportY = groundUnder(world, e);
      for (const other of world.entities) {
        if (other === e || other.hp <= 0 || other.kind === 'tree') continue;
        if (right(other) <= left(e) + 3 || left(other) >= right(e) - 3) continue;
        const otherTop = top(other);
        if (otherTop >= bottom(e) - 2 && otherTop < supportY) supportY = otherTop;
      }
      const drop = supportY - bottom(e);
      if (drop > 1.5) {
        const from = e.y;
        e.y += drop;
        moved = true;
        const prev = falls.get(e.id);
        falls.set(e.id, { id: e.id, from: prev ? prev.from : from, to: e.y, damage: 0 });
      }
    }
    if (!moved) break;
  }

  for (const f of falls.values()) {
    const dist = f.to - f.from;
    if (dist > 45) {
      const e = findEntity(world, f.id);
      if (e && e.kind !== 'king') {
        f.damage = Math.min(e.maxHp * 0.6, (dist - 45) * 0.22);
        e.hp = Math.max(0, e.hp - f.damage);
      }
    }
  }
  return [...falls.values()];
}

/** Highest terrain point under an entity's footprint. */
export function groundUnder(world: WorldState, e: Entity): number {
  let best = Infinity;
  const x0 = left(e) + 2;
  const x1 = right(e) - 2;
  for (let x = x0; x <= x1; x += COL_W) best = Math.min(best, surfaceAt(world.terrain, x));
  best = Math.min(best, surfaceAt(world.terrain, x1));
  return best;
}

/** Where a newly bought structure would come to rest at this X. */
export function dropPoint(world: WorldState, x: number, w: number, h: number): number {
  let surface = Infinity;
  for (let sx = x - w / 2 + 2; sx <= x + w / 2 - 2; sx += COL_W) {
    surface = Math.min(surface, surfaceAt(world.terrain, sx));
  }
  surface = Math.min(surface, surfaceAt(world.terrain, x + w / 2 - 2));
  for (const other of world.entities) {
    if (other.hp <= 0 || other.kind === 'tree') continue;
    if (right(other) <= x - w / 2 + 3 || left(other) >= x + w / 2 - 3) continue;
    surface = Math.min(surface, top(other));
  }
  return surface - h / 2;
}

/** Half of the map a side is allowed to build on. */
export function canBuildAt(side: Side, x: number): boolean {
  const half = WORLD_W / 2;
  return side === 0 ? x < half - 40 : x > half + 40;
}
