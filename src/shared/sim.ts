import {
  AMMO,
  BARREL_BLAST,
  BURN_TURNS,
  CANNONS,
  CREDITS_PER_DAMAGE,
  DRAG,
  DT,
  GRAVITY,
  KILL_REWARD,
  MAX_SHOT_TICKS,
  WIND_ACCEL,
  WORLD_H,
  WORLD_W,
  type AmmoDef,
  type AmmoId,
  type Material,
} from './constants.ts';
import { Rng } from './rng.ts';
import { applyCrater, surfaceAt, slopeAt } from './terrain.ts';
import {
  blocksShot,
  distToBox,
  facing,
  findEntity,
  isFlammable,
  pointInside,
  settle,
} from './world.ts';
import type { Entity, ShotResult, ShotTrack, SimEvent, Side, WorldState } from './types.ts';

export interface ShotOrder {
  side: Side;
  cannonId: number;
  elevation: number;
  power: number;
  ammo: AmmoId;
}

interface Proj {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ammo: AmmoDef;
  mass: number;
  radius: number;
  bounces: number;
  pierce: number;
  dmgMult: number;
  alive: boolean;
  ignore: number;
  splitDone: boolean;
  track: ShotTrack;
  originX: number;
  originY: number;
}

interface Pending {
  t: number;
  x: number;
  y: number;
  r: number;
  dmg: number;
  crater: number;
  kind: 'shell' | 'barrel' | 'fire';
  ammo: AmmoDef | null;
}

interface Ctx {
  world: WorldState;
  side: Side;
  events: SimEvent[];
  pending: Pending[];
  damage: number;
  selfDamage: number;
  credits: number;
  hits: number;
  kills: { cannons: number; structures: number; barrels: number };
  bestHit: number;
  kingHits: number;
  rng: Rng;
}

const MUZZLE_SPEED_BASE = 380;
const MUZZLE_SPEED_PER_POWER = 11;
/** A ball ignores its own battery for this far, so gun crews do not clip each other. */
const FRIENDLY_CLEARANCE = 110;

export function muzzleSpeed(cannon: Entity, power: number, ammo: AmmoId): number {
  const def = CANNONS[cannon.cannon ?? 'field'];
  const powder = cannon.upgrades?.powder ?? 0;
  return (
    (MUZZLE_SPEED_BASE + power * MUZZLE_SPEED_PER_POWER) *
    def.speed *
    AMMO[ammo].speed *
    (1 + 0.08 * powder)
  );
}

export function muzzlePoint(cannon: Entity, elevation: number): { x: number; y: number; a: number } {
  const def = CANNONS[cannon.cannon ?? 'field'];
  const dir = facing((cannon.owner === 1 ? 1 : 0) as Side);
  const a = (-elevation * Math.PI) / 180;
  const ux = Math.cos(a) * dir;
  const uy = Math.sin(a);
  const len = def.barrelLength;
  return { x: cannon.x + ux * len, y: cannon.y - def.height * 0.15 + uy * len, a };
}

export function clampAim(cannon: Entity, elevation: number, power: number): { elevation: number; power: number } {
  const def = CANNONS[cannon.cannon ?? 'field'];
  return {
    elevation: Math.max(def.minElevation, Math.min(def.maxElevation, elevation)),
    power: Math.max(5, Math.min(100, power)),
  };
}

/**
 * Runs a shot to completion against a mutable world and returns everything the
 * clients need to replay it frame for frame.
 */
export function simulateShot(world: WorldState, order: ShotOrder, seed: number): ShotResult {
  const cannon = findEntity(world, order.cannonId)!;
  const def = CANNONS[cannon.cannon ?? 'field'];
  const ammo = AMMO[order.ammo];
  const rng = new Rng(seed);

  const { elevation, power } = clampAim(cannon, order.elevation, order.power);
  const spread = def.spread / Math.pow(2, cannon.upgrades?.sights ?? 0);
  const jitter = (rng.gauss() * spread * Math.PI) / 180;
  const dmgMult = (1 + 0.12 * (cannon.upgrades?.rifling ?? 0)) * (def.ammoBonus?.[order.ammo] ?? 1);

  const dir = facing(order.side);
  const m = muzzlePoint(cannon, elevation);
  const angle = -(elevation * Math.PI) / 180 + jitter * dir;
  const speed = muzzleSpeed(cannon, power, order.ammo);

  const ctx: Ctx = {
    world,
    side: order.side,
    events: [],
    pending: [],
    damage: 0,
    selfDamage: 0,
    credits: 0,
    hits: 0,
    kills: { cannons: 0, structures: 0, barrels: 0 },
    bestHit: 0,
    kingHits: 0,
    rng,
  };

  const tracks: ShotTrack[] = [];
  const projs: Proj[] = [];
  let projId = 1;

  const spawn = (
    x: number,
    y: number,
    vx: number,
    vy: number,
    a: AmmoDef,
    birth: number,
    mult: number,
  ): Proj => {
    const track: ShotTrack = { id: projId++, ammo: a.id, birth, pts: [], end: 'air' };
    tracks.push(track);
    const p: Proj = {
      x,
      y,
      vx,
      vy,
      ammo: a,
      mass: a.mass,
      radius: a.radius,
      bounces: a.bounces,
      pierce: a.blast === 0 ? 3 : 0,
      dmgMult: mult,
      alive: true,
      ignore: birth === 0 ? 2 : 0,
      splitDone: !a.cluster,
      track,
      originX: x,
      originY: y,
    };
    projs.push(p);
    return p;
  };

  spawn(m.x, m.y, Math.cos(angle) * speed * dir, Math.sin(angle) * speed, ammo, 0, dmgMult);
  ctx.events.push({ k: 'muzzle', t: 0, x: m.x, y: m.y, a: angle * dir, power });

  const startX = m.x;
  const startY = m.y;
  let impactX = m.x;
  let impactY = m.y;
  let sawImpact = false;
  let t = 0;

  for (; t < MAX_SHOT_TICKS; t++) {
    // Chained detonations scheduled by earlier hits.
    for (let i = ctx.pending.length - 1; i >= 0; i--) {
      const p = ctx.pending[i]!;
      if (p.t <= t) {
        ctx.pending.splice(i, 1);
        detonate(ctx, p.x, p.y, p.r, p.dmg, p.crater, p.kind, p.ammo, t);
      }
    }

    let anyAlive = false;
    for (const p of projs) {
      if (!p.alive) continue;
      anyAlive = true;
      const before = { x: p.x, y: p.y };
      stepProjectile(ctx, p, t, projs, spawn);
      if (!p.alive && !sawImpact) {
        sawImpact = true;
        impactX = p.x;
        impactY = p.y;
      }
      void before;
      p.track.pts.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
    }

    if (!anyAlive && ctx.pending.length === 0) {
      // Let the last explosion breathe before the replay ends.
      t += 1;
      break;
    }
  }

  // Anything still in the air when the clock runs out simply leaves the field.
  for (const p of projs) {
    if (p.alive) {
      p.alive = false;
      p.track.end = 'air';
    }
  }

  const falls = settle(world);
  for (const f of falls) {
    const e = findEntity(world, f.id);
    if (e && e.hp <= 0) {
      ctx.events.push({ k: 'gone', t, x: e.x, y: e.y, id: e.id, kind: e.kind, mat: e.mat });
      reward(ctx, e);
    }
  }
  world.entities = world.entities.filter((e) => e.hp > 0);

  const distance = sawImpact ? Math.hypot(impactX - startX, impactY - startY) : 0;
  ctx.credits = Math.round(ctx.credits);

  return {
    by: order.side,
    cannonId: order.cannonId,
    ammo: order.ammo,
    elevation,
    power,
    tracks,
    events: ctx.events,
    ticks: t + 1,
    damage: Math.round(ctx.damage),
    selfDamage: Math.round(ctx.selfDamage),
    hits: ctx.hits,
    credits: ctx.credits,
    distance: Math.round(distance),
  };
}

type SpawnFn = (
  x: number,
  y: number,
  vx: number,
  vy: number,
  a: AmmoDef,
  birth: number,
  mult: number,
) => Proj;

function stepProjectile(ctx: Ctx, p: Proj, t: number, _all: Proj[], spawn: SpawnFn): void {
  const { world } = ctx;
  const wasRising = p.vy < 0;

  // Integrate. Heavier shot shrugs off drag and wind.
  p.vy += GRAVITY * DT;
  p.vx += ((ctx.world.wind * WIND_ACCEL) / p.mass) * DT;
  const dragK = (DRAG / p.mass) * DT;
  p.vx -= p.vx * dragK;
  p.vy -= p.vy * dragK;

  // Grapeshot bursts at the top of its arc.
  if (!p.splitDone && p.ammo.cluster && wasRising && p.vy >= 0) {
    p.splitDone = true;
    if (p.ammo.cluster.atApex) {
      burst(ctx, p, t, spawn);
      return;
    }
  }

  const speed = Math.hypot(p.vx, p.vy);
  const steps = Math.max(1, Math.ceil((speed * DT) / 4));
  const sdt = DT / steps;

  for (let s = 0; s < steps; s++) {
    const nx = p.x + p.vx * sdt;
    const ny = p.y + p.vy * sdt;
    if (p.ignore > 0) {
      p.x = nx;
      p.y = ny;
      continue;
    }

    if (nx < -40 || nx > WORLD_W + 40 || ny > WORLD_H + 200) {
      p.x = Math.max(-40, Math.min(WORLD_W + 40, nx));
      p.y = ny;
      p.alive = false;
      p.track.end = 'edge';
      return;
    }

    // Entities first: a wall in front of the hill stops the ball.
    const hit = entityAt(ctx, p, nx, ny);
    if (hit) {
      p.x = nx;
      p.y = ny;
      impactEntity(ctx, p, hit, t);
      if (!p.alive) return;
      continue;
    }

    const ground = surfaceAt(world.terrain, nx);
    if (ny + p.radius * 0.5 >= ground) {
      p.x = nx;
      p.y = Math.min(ny, ground - p.radius * 0.5);
      if (tryBounce(ctx, p, t)) continue;
      impactTerrain(ctx, p, t);
      return;
    }

    p.x = nx;
    p.y = ny;
  }
  if (p.ignore > 0) p.ignore--;
}

function burst(ctx: Ctx, p: Proj, t: number, spawn: SpawnFn): void {
  const c = p.ammo.cluster!;
  ctx.events.push({ k: 'split', t, x: p.x, y: p.y });
  const base = Math.atan2(p.vy, p.vx);
  const speed = Math.hypot(p.vx, p.vy);
  const pellet: AmmoDef = { ...p.ammo, cluster: undefined, impact: p.ammo.impact };
  for (let i = 0; i < c.count; i++) {
    const spreadT = c.count === 1 ? 0 : (i / (c.count - 1)) * 2 - 1;
    const a = base + spreadT * c.spread + ctx.rng.gauss() * 0.02;
    const s = speed * (0.86 + ctx.rng.next() * 0.28);
    const q = spawn(p.x, p.y, Math.cos(a) * s, Math.sin(a) * s, pellet, t, p.dmgMult);
    q.pierce = 1;
    q.bounces = 0;
    q.splitDone = true;
  }
  p.alive = false;
  p.track.end = 'air';
}

function entityAt(ctx: Ctx, p: Proj, x: number, y: number): Entity | null {
  const nearMuzzle = Math.hypot(x - p.originX, y - p.originY) < FRIENDLY_CLEARANCE;
  for (const e of ctx.world.entities) {
    if (!blocksShot(e)) continue;
    // Your own guns standing in the same battery do not eat your shot.
    if (nearMuzzle && e.kind === 'cannon' && e.owner === ctx.side) continue;
    if (pointInside(e, x, y, p.radius * 0.4)) return e;
  }
  return null;
}

function tryBounce(ctx: Ctx, p: Proj, t: number): boolean {
  if (p.bounces <= 0) return false;
  const speed = Math.hypot(p.vx, p.vy);
  if (speed < 260) return false;
  const slope = slopeAt(ctx.world.terrain, p.x);
  // Surface normal for a heightmap slope (y grows downward).
  const nx = Math.sin(slope);
  const ny = -Math.cos(slope);
  const vn = p.vx * nx + p.vy * ny;
  if (vn >= 0) return false;
  const incidence = Math.abs(vn) / speed;
  if (incidence > 0.55) return false; // too steep — it digs in instead

  p.vx -= 2 * vn * nx;
  p.vy -= 2 * vn * ny;
  p.vx *= 0.62;
  p.vy *= 0.62;
  p.bounces--;
  p.dmgMult *= 0.8;
  p.y -= 3;
  crater(ctx, p.x, p.y + 6, p.ammo.crater * 0.35, t);
  ctx.events.push({ k: 'bounce', t, x: p.x, y: p.y, speed });
  return true;
}

function impactTerrain(ctx: Ctx, p: Proj, t: number): void {
  p.alive = false;
  p.track.end = 'terrain';
  const a = p.ammo;
  ctx.events.push({ k: 'thud', t, x: p.x, y: p.y });
  if (a.blast > 0) {
    detonate(ctx, p.x, p.y, a.blast, a.blastDamage * p.dmgMult, a.crater, blastKind(a), a, t);
  } else {
    crater(ctx, p.x, p.y + p.radius * 0.5, a.crater, t);
  }
}

function blastKind(a: AmmoDef): 'shell' | 'fire' {
  return a.incendiary ? 'fire' : 'shell';
}

function impactEntity(ctx: Ctx, p: Proj, e: Entity, t: number): void {
  const a = p.ammo;
  const before = e.hp;
  const dmg = a.impact * p.dmgMult * matMult(a, e.mat);
  applyDamage(ctx, e, dmg, t, p.x, p.y);

  if (a.blast > 0) {
    p.alive = false;
    p.track.end = 'entity';
    detonate(ctx, p.x, p.y, a.blast, a.blastDamage * p.dmgMult, a.crater, blastKind(a), a, t);
    return;
  }

  // Solid shot punches on through anything it shatters.
  const destroyed = before > 0 && e.hp <= 0;
  if (destroyed && p.pierce > 0) {
    p.pierce--;
    p.vx *= 0.62;
    p.vy *= 0.62;
    p.dmgMult *= 0.72;
    return;
  }
  p.alive = false;
  p.track.end = 'entity';
  crater(ctx, p.x, p.y + p.radius, a.crater * 0.5, t);
}

/** Digs a hole and tells the clients to dig the same one. */
function crater(ctx: Ctx, x: number, y: number, r: number, t: number): void {
  if (r <= 0) return;
  applyCrater(ctx.world.terrain, x, y, r);
  ctx.events.push({ k: 'crater', t, x, y, r });
}

function matMult(a: AmmoDef, m: Material): number {
  return a.vs[m] ?? 1;
}

function detonate(
  ctx: Ctx,
  x: number,
  y: number,
  radius: number,
  damage: number,
  craterRadius: number,
  kind: 'shell' | 'barrel' | 'fire',
  ammo: AmmoDef | null,
  t: number,
): void {
  ctx.events.push({ k: 'boom', t, x, y, r: radius, kind });
  crater(ctx, x, y, craterRadius, t);

  for (const e of ctx.world.entities) {
    if (e.hp <= 0) continue;
    const d = distToBox(e, x, y);
    if (d > radius) continue;
    const falloff = Math.pow(1 - d / radius, 1.35);
    const dmg = damage * falloff * (ammo ? matMult(ammo, e.mat) : e.mat === 'stone' ? 0.9 : 1.15);
    if (dmg < 0.5) continue;
    applyDamage(ctx, e, dmg, t, x, y);
    if ((ammo?.incendiary || kind === 'fire') && isFlammable(e) && e.hp > 0) {
      e.burning = BURN_TURNS;
      ctx.events.push({ k: 'ignite', t, id: e.id });
    }
  }
}

function applyDamage(ctx: Ctx, e: Entity, dmg: number, t: number, x: number, y: number): void {
  if (e.hp <= 0) return;
  const actual = Math.min(e.hp, dmg);
  e.hp -= actual;
  ctx.events.push({ k: 'hit', t, x, y, id: e.id, dmg: Math.round(actual), mat: e.mat });

  if (e.owner === ctx.side) {
    ctx.selfDamage += actual;
  } else if (e.owner !== -1) {
    ctx.damage += actual;
    ctx.credits += actual * CREDITS_PER_DAMAGE;
    ctx.hits++;
    ctx.bestHit = Math.max(ctx.bestHit, actual);
  }

  if (e.kind === 'king' && e.owner !== ctx.side) {
    ctx.kingHits++;
    ctx.events.push({ k: 'king', t, x: e.x, y: e.y, dmg: Math.round(actual), hp: Math.round(e.hp) });
  }

  if (e.hp <= 0) {
    ctx.events.push({ k: 'gone', t, x: e.x, y: e.y, id: e.id, kind: e.kind, mat: e.mat });
    reward(ctx, e);
    if (e.kind === 'barrel') {
      // Chain reaction, a few ticks later so the ripple reads on screen.
      ctx.pending.push({
        t: t + 7,
        x: e.x,
        y: e.y,
        r: BARREL_BLAST.radius,
        dmg: BARREL_BLAST.damage,
        crater: BARREL_BLAST.crater,
        kind: 'barrel',
        ammo: null,
      });
      if (e.owner !== ctx.side) ctx.kills.barrels++;
    }
  }
}

function reward(ctx: Ctx, e: Entity): void {
  if (e.owner === ctx.side) return;
  const key =
    e.kind === 'block' ? 'block' : e.kind === 'timber' ? 'timber' : (e.kind as string);
  const value = KILL_REWARD[key] ?? 10;
  ctx.credits += e.owner === -1 ? value * 0.4 : value;
  if (e.owner === -1) return;
  if (e.kind === 'cannon') ctx.kills.cannons++;
  else if (e.kind === 'block' || e.kind === 'timber') ctx.kills.structures++;
}

/** Kill counters and best-hit, pulled out for the match layer. */
export function shotTally(result: ShotResult): {
  cannons: number;
  structures: number;
  barrels: number;
  bestHit: number;
  kingHits: number;
} {
  let cannons = 0;
  let structures = 0;
  let barrels = 0;
  let bestHit = 0;
  let kingHits = 0;
  for (const ev of result.events) {
    if (ev.k === 'gone') {
      if (ev.kind === 'cannon') cannons++;
      else if (ev.kind === 'block' || ev.kind === 'timber') structures++;
      else if (ev.kind === 'barrel') barrels++;
    } else if (ev.k === 'hit') {
      bestHit = Math.max(bestHit, ev.dmg);
    } else if (ev.k === 'king') {
      kingHits++;
    }
  }
  return { cannons, structures, barrels, bestHit, kingHits };
}
