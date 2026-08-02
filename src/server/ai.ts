import { AMMO, CANNONS, type AmmoId } from '../shared/constants.ts';
import { simulateShot } from '../shared/sim.ts';
import type { Entity, Side, WorldState } from '../shared/types.ts';
import { cannonsOf, kingOf } from '../shared/world.ts';
import { buyAmmo, buyCannon, buyUpgrade } from '../shared/shop.ts';
import type { Match } from './match.ts';
import { other } from './match.ts';

export interface BotPlan {
  cannonId: number;
  elevation: number;
  power: number;
  ammo: AmmoId;
}

/** 0 = recruit, 1 = gunner, 2 = master gunner. */
export type Difficulty = 0 | 1 | 2;

const ELEVATIONS = [24, 34, 44, 54, 64, 74];
const POWERS = [34, 44, 54, 62, 70, 78, 86, 94, 100];

export function botShop(match: Match, side: Side, difficulty: Difficulty): void {
  const player = match.player(side);
  if (difficulty === 0) return;

  const guns = cannonsOf(match.world, side);
  // Keep a couple of shells in the locker.
  if (player.credits > 200 && (player.ammo.shell ?? 0) < 2) buyAmmo(player, 'shell');
  if (difficulty === 2 && player.credits > 260 && (player.ammo.mortar ?? 0) < 1) buyAmmo(player, 'mortar');
  if (difficulty === 2 && player.credits > 260 && (player.ammo.chain ?? 0) < 2) buyAmmo(player, 'chain');

  if (guns.length < 3 && player.credits > 520) {
    const king = kingOf(match.world, side);
    if (king) {
      const dir = side === 0 ? 1 : -1;
      buyCannon(match.state, side, difficulty === 2 ? 'longgun' : 'field', king.x + dir * (150 + guns.length * 55));
    }
  }

  if (difficulty === 2 && guns.length > 0 && player.credits > 400) {
    const gun = guns[0]!;
    buyUpgrade(match.state, side, gun.id, (gun.upgrades?.sights ?? 0) < 2 ? 'sights' : 'powder');
  }
}

export function planShot(match: Match, side: Side, difficulty: Difficulty): BotPlan | null {
  const guns = cannonsOf(match.world, side).filter((c) => !c.firedThisTurn);
  if (guns.length === 0) return null;

  const player = match.player(side);
  const ammo = pickAmmo(match.world, side, player.ammo, difficulty);
  const target = pickTarget(match.world, side);
  if (!target) return null;

  let best: (BotPlan & { score: number }) | null = null;
  const consider = (gun: Entity, elevation: number, power: number) => {
    const score = trial(match.world, side, gun, elevation, power, ammo, target);
    if (!best || score > best.score) best = { cannonId: gun.id, elevation, power, ammo, score };
  };

  // Coarse sweep: find the arc that lands nearest the target.
  for (const gun of guns) {
    const def = CANNONS[gun.cannon ?? 'field'];
    for (const elevation of ELEVATIONS) {
      if (elevation < def.minElevation || elevation > def.maxElevation) continue;
      for (const power of POWERS) consider(gun, elevation, power);
    }
  }
  if (!best) return null;

  // Walk the shot in: two rounds of tightening around the current best.
  for (const step of [5, 2]) {
    const anchor = best as BotPlan & { score: number };
    const gun = guns.find((g) => g.id === anchor.cannonId)!;
    const def = CANNONS[gun.cannon ?? 'field'];
    for (let de = -1; de <= 1; de++) {
      for (let dp = -1; dp <= 1; dp++) {
        if (de === 0 && dp === 0) continue;
        consider(
          gun,
          clamp(anchor.elevation + de * step, def.minElevation, def.maxElevation),
          clamp(anchor.power + dp * step, 5, 100),
        );
      }
    }
  }

  const chosen = best as BotPlan & { score: number };
  const gun = guns.find((g) => g.id === chosen.cannonId)!;
  const def = CANNONS[gun.cannon ?? 'field'];
  // Weaker bots wobble. A recruit is genuinely bad at this.
  const wobble = difficulty === 0 ? 6 : difficulty === 1 ? 2 : 0.4;
  return {
    cannonId: chosen.cannonId,
    elevation: clamp(chosen.elevation + (Math.random() - 0.5) * wobble * 2, def.minElevation, def.maxElevation),
    power: clamp(chosen.power + (Math.random() - 0.5) * wobble * 3, 5, 100),
    ammo: chosen.ammo,
  };
}

/** What the bot is trying to knock down right now. */
function pickTarget(world: WorldState, side: Side): Entity | null {
  const foe = other(side);
  const king = kingOf(world, foe);
  const guns = world.entities.filter((e) => e.hp > 0 && e.kind === 'cannon' && e.owner === foe);
  // Silence the battery first, then dig for the king.
  if (guns.length > 0) {
    return guns.reduce((a, b) => (a.hp <= b.hp ? a : b));
  }
  return king ?? null;
}

function trial(
  world: WorldState,
  side: Side,
  gun: Entity,
  elevation: number,
  power: number,
  ammo: AmmoId,
  target: Entity,
): number {
  const copy = cloneWorld(world);
  const before = scoreWorld(copy, side);
  const result = simulateShot(copy, { side, cannonId: gun.id, elevation, power, ammo }, 0x1234);
  const after = scoreWorld(copy, side);

  // How close did the shot land? Gives the search a gradient even when it misses.
  let miss = Infinity;
  for (const track of result.tracks) {
    const n = track.pts.length;
    if (n < 2) continue;
    miss = Math.min(miss, Math.hypot(track.pts[n - 2]! - target.x, track.pts[n - 1]! - target.y));
  }
  const proximity = Number.isFinite(miss) ? 500 * Math.exp(-miss / 140) : 0;
  return after - before + proximity;
}

function scoreWorld(world: WorldState, side: Side): number {
  let score = 0;
  for (const e of world.entities) {
    if (e.hp <= 0) continue;
    const mine = e.owner === side;
    const weight =
      e.kind === 'king' ? 14 : e.kind === 'cannon' ? 4 : e.kind === 'block' ? 0.7 : 0.4;
    if (e.owner === -1) continue;
    score += (mine ? 1 : -1) * e.hp * weight;
  }
  const foeKing = world.entities.find((e) => e.kind === 'king' && e.owner !== side);
  if (!foeKing) score += 40000;
  return score;
}

function cloneWorld(world: WorldState): WorldState {
  return {
    ...world,
    terrain: world.terrain.slice(),
    entities: world.entities.map((e) => ({ ...e, upgrades: e.upgrades ? { ...e.upgrades } : undefined })),
  };
}

function pickAmmo(
  world: WorldState,
  side: Side,
  stock: Record<AmmoId, number>,
  difficulty: Difficulty,
): AmmoId {
  if (difficulty === 0) return 'round';
  const foeKing = kingOf(world, other(side));
  const shielded =
    foeKing &&
    world.entities.some(
      (e) =>
        e.hp > 0 &&
        e.kind === 'block' &&
        Math.abs(e.x - foeKing.x) < 120 &&
        e.y < foeKing.y,
    );
  const order: AmmoId[] = shielded
    ? ['mortar', 'chain', 'shell', 'round']
    : ['shell', 'mortar', 'chain', 'round'];
  for (const a of order) {
    if (AMMO[a].cost === 0 || (stock[a] ?? 0) > 0) return a;
  }
  return 'round';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
