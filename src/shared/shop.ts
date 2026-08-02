import {
  AMMO,
  BUILDS,
  CANNONS,
  HP,
  UPGRADES,
  WORLD_W,
  type AmmoId,
  type BuildId,
  type CannonId,
  type UpgradeId,
} from './constants.ts';
import {
  BLOCK,
  canBuildAt,
  cannonsOf,
  dropPoint,
  findEntity,
  makeEntity,
  placeCannon,
} from './world.ts';
import type { MatchState, PlayerState, Side } from './types.ts';

export interface ShopResult {
  ok: boolean;
  error?: string;
  spent?: number;
  note?: string;
}

const fail = (error: string): ShopResult => ({ ok: false, error });

export function ammoPrice(ammo: AmmoId): { price: number; count: number } {
  const def = AMMO[ammo];
  return { price: Math.round(def.cost * def.bundle * 0.92), count: def.bundle };
}

export function upgradePrice(upgrade: UpgradeId, level: number): number {
  return Math.round(UPGRADES[upgrade].cost * (1 + level * 0.6));
}

export function cannonPrice(cannon: CannonId, owned: number): number {
  // Each extra gun of the same type costs more — you cannot just spam them.
  return Math.round(CANNONS[cannon].cost * (1 + owned * 0.35));
}

function spend(player: PlayerState, amount: number): boolean {
  if (player.credits < amount) return false;
  player.credits -= amount;
  player.stats.creditsSpent += amount;
  return true;
}

export function buyAmmo(player: PlayerState, ammo: AmmoId): ShopResult {
  const def = AMMO[ammo];
  if (def.cost <= 0) return fail('Round shot is free — you always have it.');
  const { price, count } = ammoPrice(ammo);
  if (!spend(player, price)) return fail('Not enough credits.');
  player.ammo[ammo] = (player.ammo[ammo] ?? 0) + count;
  return { ok: true, spent: price, note: `+${count} ${def.name}` };
}

export function buyCannon(match: MatchState, side: Side, cannon: CannonId, x: number): ShopResult {
  const player = match.players[side];
  const owned = cannonsOf(match.world, side);
  if (owned.length >= 5) return fail('Five guns is all a battery can serve.');
  const price = cannonPrice(cannon, owned.filter((c) => c.cannon === cannon).length);
  if (player.credits < price) return fail('Not enough credits.');
  const clamped = Math.max(60, Math.min(WORLD_W - 60, x));
  if (!canBuildAt(side, clamped)) return fail('You can only deploy on your own half.');
  const def = CANNONS[cannon];
  if (!isClear(match, clamped, def.width + 12, def.height)) return fail('Not enough room there.');
  if (!spend(player, price)) return fail('Not enough credits.');
  const e = placeCannon(match.world, side, cannon, clamped);
  e.firedThisTurn = match.turn === side && match.shotsLeft <= 0;
  return { ok: true, spent: price, note: `${def.name} deployed` };
}

export function buyUpgrade(
  match: MatchState,
  side: Side,
  cannonId: number,
  upgrade: UpgradeId,
): ShopResult {
  const player = match.players[side];
  const cannon = findEntity(match.world, cannonId);
  if (!cannon || cannon.kind !== 'cannon' || cannon.owner !== side) return fail('That is not your gun.');
  const def = UPGRADES[upgrade];
  const level = cannon.upgrades?.[upgrade] ?? 0;
  if (level >= def.maxLevel) return fail(`${def.name} is already maxed.`);
  const price = upgradePrice(upgrade, level);
  if (!spend(player, price)) return fail('Not enough credits.');
  cannon.upgrades = { ...(cannon.upgrades ?? {}), [upgrade]: level + 1 };
  if (upgrade === 'plating') {
    cannon.maxHp += 45;
    cannon.hp = cannon.maxHp;
  }
  return { ok: true, spent: price, note: `${def.name} ${level + 1}` };
}

export function build(match: MatchState, side: Side, id: BuildId, x: number, _y: number): ShopResult {
  const player = match.players[side];
  const def = BUILDS[id];
  if (player.credits < def.cost) return fail('Not enough credits.');

  if (id === 'repair') {
    const mine = match.world.entities.filter(
      (e) => e.owner === side && e.hp > 0 && e.hp < e.maxHp && e.kind !== 'cannon',
    );
    if (mine.length === 0) return fail('Nothing of yours needs repairing.');
    if (!spend(player, def.cost)) return fail('Not enough credits.');
    for (const e of mine) {
      e.hp = Math.min(e.maxHp, e.hp + 40);
      e.burning = 0;
    }
    return { ok: true, spent: def.cost, note: `${mine.length} structures repaired` };
  }

  const clamped = Math.max(40, Math.min(WORLD_W - 40, x));
  if (!canBuildAt(side, clamped)) return fail('You can only build on your own half.');

  const size =
    id === 'wall' ? { w: BLOCK, h: BLOCK } : id === 'timber' ? { w: 56, h: 26 } : { w: 22, h: 32 };
  if (!isClear(match, clamped, size.w + 6, size.h)) return fail('Something is already there.');
  if (!spend(player, def.cost)) return fail('Not enough credits.');

  const y = dropPoint(match.world, clamped, size.w, size.h);
  if (id === 'wall') {
    makeEntity(match.world, 'block', side, clamped, y, size.w, size.h, HP.stoneBlock, 'stone', {
      variant: 0,
    });
  } else if (id === 'timber') {
    makeEntity(match.world, 'timber', side, clamped, y, size.w, size.h, HP.timber, 'wood', {
      variant: 1,
    });
  } else {
    makeEntity(match.world, 'barrel', side, clamped, y, size.w, size.h, HP.barrel, 'powder', {
      variant: 0,
    });
  }
  return { ok: true, spent: def.cost, note: `${def.name} placed` };
}

/** Rough overlap test against every standing entity in a vertical slab. */
function isClear(match: MatchState, x: number, w: number, _h: number): boolean {
  for (const e of match.world.entities) {
    if (e.hp <= 0 || e.kind === 'tree') continue;
    if (Math.abs(e.x - x) < (e.w + w) / 2) {
      // Allow stacking on top of things — only reject if it is a cannon or king.
      if (e.kind === 'cannon' || e.kind === 'king') return false;
    }
  }
  return true;
}
