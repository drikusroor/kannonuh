import { describe, expect, test } from 'bun:test';
import { COLS, WORLD_W } from '../src/shared/constants.ts';
import { Rng } from '../src/shared/rng.ts';
import { carve, generateTerrain, surfaceAt } from '../src/shared/terrain.ts';
import { simulateShot } from '../src/shared/sim.ts';
import { cannonsOf, createWorld, kingOf, settle } from '../src/shared/world.ts';
import type { Side, WorldState } from '../src/shared/types.ts';

function clone(world: WorldState): WorldState {
  return {
    ...world,
    terrain: world.terrain.slice(),
    entities: world.entities.map((e) => ({ ...e, upgrades: { ...(e.upgrades ?? {}) } })),
  };
}

describe('terrain', () => {
  test('generates a heightmap with flat plots for both castles', () => {
    const { terrain, bases } = generateTerrain(new Rng(99));
    expect(terrain).toHaveLength(COLS);
    expect(terrain.every((v) => Number.isFinite(v))).toBe(true);
    for (const base of bases) {
      expect(Math.abs(surfaceAt(terrain, base.x) - surfaceAt(terrain, base.x + 120))).toBeLessThan(2);
      expect(Math.abs(surfaceAt(terrain, base.x) - surfaceAt(terrain, base.x - 120))).toBeLessThan(2);
    }
    expect(bases[0].x).toBeLessThan(WORLD_W / 2);
    expect(bases[1].x).toBeGreaterThan(WORLD_W / 2);
  });

  test('craters lower the ground and never punch through the floor', () => {
    const { terrain } = generateTerrain(new Rng(7));
    const before = surfaceAt(terrain, 1300);
    carve(terrain, 1300, before, 80);
    const after = surfaceAt(terrain, 1300);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(2000);
  });
});

describe('simulation', () => {
  test('is deterministic for the same seed', () => {
    const world = createWorld(4242);
    const gun = cannonsOf(world, 0)[0]!;
    const order = { side: 0 as Side, cannonId: gun.id, elevation: 41, power: 88, ammo: 'shell' as const };
    const a = simulateShot(clone(world), order, 777);
    const b = simulateShot(clone(world), order, 777);
    expect(a.tracks[0]!.pts).toEqual(b.tracks[0]!.pts);
    expect(a.damage).toBe(b.damage);
    expect(a.events.length).toBe(b.events.length);
  });

  test('a full-power shot crosses the battlefield', () => {
    const world = createWorld(31337);
    const gun = cannonsOf(world, 0)[0]!;
    const result = simulateShot(clone(world), {
      side: 0,
      cannonId: gun.id,
      elevation: 44,
      power: 100,
      ammo: 'round',
    }, 1);
    const track = result.tracks[0]!;
    const lastX = track.pts[track.pts.length - 2]!;
    const enemyKing = kingOf(world, 1)!;
    expect(lastX).toBeGreaterThan(enemyKing.x - 250);
  });

  test('a shot into your own feet does not damage the neighbouring gun in your battery', () => {
    const world = createWorld(1234);
    const guns = cannonsOf(world, 0);
    const result = simulateShot(clone(world), {
      side: 0,
      cannonId: guns[0]!.id,
      elevation: 12,
      power: 40,
      ammo: 'round',
    }, 5);
    const hitOwnGun = result.events.some(
      (e) => e.k === 'hit' && guns.some((g) => g.id === (e as { id: number }).id),
    );
    expect(hitOwnGun).toBe(false);
  });

  test('grapeshot bursts into a cone of pellets', () => {
    const world = createWorld(808);
    const gun = cannonsOf(world, 0)[0]!;
    const result = simulateShot(clone(world), {
      side: 0,
      cannonId: gun.id,
      elevation: 45,
      power: 80,
      ammo: 'grape',
    }, 3);
    expect(result.tracks.length).toBeGreaterThan(4);
    expect(result.events.some((e) => e.k === 'split')).toBe(true);
  });

  test('some reachable shot damages the enemy and pays credits', () => {
    const world = createWorld(555);
    const gun = cannonsOf(world, 0)[0]!;
    let best = { damage: 0, credits: 0, selfDamage: 0 };
    for (let elevation = 20; elevation <= 70 && best.damage === 0; elevation += 5) {
      for (let power = 60; power <= 100 && best.damage === 0; power += 4) {
        const r = simulateShot(clone(world), { side: 0, cannonId: gun.id, elevation, power, ammo: 'shell' }, 9);
        if (r.damage > 0) best = r;
      }
    }
    expect(best.damage).toBeGreaterThan(0);
    expect(best.credits).toBeGreaterThan(0);
    expect(best.selfDamage).toBe(0);
  });

  test('unsupported blocks fall when the ground under them is blown away', () => {
    const world = createWorld(2468);
    const block = world.entities.find((e) => e.kind === 'block')!;
    const startY = block.y;
    carve(world.terrain, block.x, block.y + 200, 220);
    const falls = settle(world);
    expect(falls.some((f) => f.id === block.id)).toBe(true);
    expect(world.entities.find((e) => e.id === block.id)!.y).toBeGreaterThan(startY);
  });
});
