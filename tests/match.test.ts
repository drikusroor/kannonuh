import { describe, expect, test } from 'bun:test';
import { MAX_SHOTS_PER_TURN, STARTING_CREDITS } from '../src/shared/constants.ts';
import { buyAmmo, buyCannon, buyUpgrade, build } from '../src/shared/shop.ts';
import { cannonsOf, kingOf } from '../src/shared/world.ts';
import { Match } from '../src/server/match.ts';
import { planShot, botShop } from '../src/server/ai.ts';

function newMatch(seed = 4242): Match {
  return new Match({ seed, names: ['Red', 'Blue'], bots: [false, false] });
}

describe('turn structure', () => {
  test('a fresh match gives both sides two guns and a shot for each', () => {
    const m = newMatch();
    expect(cannonsOf(m.world, 0)).toHaveLength(2);
    expect(cannonsOf(m.world, 1)).toHaveLength(2);
    expect(m.state.shotsLeft).toBe(2);
    expect(m.state.turn).toBe(0);
    expect(m.player(0).credits).toBe(STARTING_CREDITS);
  });

  test('never grants more than the shot cap', () => {
    const m = newMatch();
    for (let i = 0; i < 4; i++) buyCannon(m.state, 0, 'field', 200 + i * 60);
    m.beginTurn(0, true);
    expect(m.state.shotsLeft).toBeLessThanOrEqual(MAX_SHOTS_PER_TURN);
  });

  test('each gun fires once, then the turn passes', () => {
    const m = newMatch();
    const guns = cannonsOf(m.world, 0);
    expect(m.fire(0, { cannonId: guns[0]!.id, elevation: 45, power: 70, ammo: 'round' }).error).toBeUndefined();
    // The same gun cannot fire twice.
    expect(m.fire(0, { cannonId: guns[0]!.id, elevation: 45, power: 70, ammo: 'round' }).error).toBeDefined();
    expect(m.fire(0, { cannonId: guns[1]!.id, elevation: 45, power: 70, ammo: 'round' }).error).toBeUndefined();
    expect(m.state.turn).toBe(1);
    expect(m.player(0).stats.shots).toBe(2);
  });

  test('rejects firing out of turn and with an empty magazine', () => {
    const m = newMatch();
    const blue = cannonsOf(m.world, 1)[0]!;
    expect(m.fire(1, { cannonId: blue.id, elevation: 45, power: 70, ammo: 'round' }).error).toBeDefined();
    const red = cannonsOf(m.world, 0)[0]!;
    m.player(0).ammo.mortar = 0;
    expect(m.fire(0, { cannonId: red.id, elevation: 45, power: 70, ammo: 'mortar' }).error).toBeDefined();
  });

  test('consumes paid ammunition but never round shot', () => {
    const m = newMatch();
    const guns = cannonsOf(m.world, 0);
    m.player(0).ammo.shell = 2;
    m.fire(0, { cannonId: guns[0]!.id, elevation: 45, power: 70, ammo: 'shell' });
    expect(m.player(0).ammo.shell).toBe(1);
    const before = m.player(0).ammo.round;
    m.fire(0, { cannonId: guns[1]!.id, elevation: 45, power: 70, ammo: 'round' });
    expect(m.player(0).ammo.round).toBe(before);
  });

  test('a gunner who loses every gun is issued a militia piece', () => {
    const m = newMatch();
    for (const gun of cannonsOf(m.world, 1)) gun.hp = 0;
    m.world.entities = m.world.entities.filter((e) => e.hp > 0);
    m.beginTurn(1);
    expect(cannonsOf(m.world, 1).length).toBe(1);
    expect(m.state.phase).toBe('playing');
  });

  test('killing the king ends the battle and scores the winner higher', () => {
    const m = newMatch();
    const king = kingOf(m.world, 1)!;
    king.hp = 1;
    // Walk the bot's search until it finds the killing blow.
    let guard = 0;
    while (m.state.phase === 'playing' && guard++ < 60) {
      const side = m.state.turn;
      const plan = planShot(m, side, 2);
      if (!plan) {
        m.endTurn();
        continue;
      }
      const out = m.fire(side, plan);
      if (out.summary) {
        expect(out.summary.winner).toBe(0);
        expect(out.summary.scores[0].total).toBeGreaterThan(out.summary.scores[1].total);
        expect(out.summary.reason).toBe('king');
        return;
      }
      if (m.state.turn === side && m.state.shotsLeft <= 0) m.endTurn();
      // Keep the blue king pinned at one hit point so the test terminates.
      const k = kingOf(m.world, 1);
      if (k) k.hp = 1;
    }
    throw new Error('bot never killed the king');
  });
});

describe('quartermaster', () => {
  test('ammunition costs credits and arrives in bundles', () => {
    const m = newMatch();
    const before = m.player(0).credits;
    const out = buyAmmo(m.player(0), 'shell');
    expect(out.ok).toBe(true);
    expect(m.player(0).credits).toBeLessThan(before);
    expect(m.player(0).ammo.shell).toBeGreaterThan(3);
  });

  test('round shot cannot be bought', () => {
    const m = newMatch();
    expect(buyAmmo(m.player(0), 'round').ok).toBe(false);
  });

  test('guns may only be deployed on your own half', () => {
    const m = newMatch();
    m.player(0).credits = 5000;
    expect(buyCannon(m.state, 0, 'field', 2400).ok).toBe(false);
    expect(buyCannon(m.state, 0, 'field', 700).ok).toBe(true);
    expect(cannonsOf(m.world, 0)).toHaveLength(3);
  });

  test('upgrades raise the level and plating heals the gun', () => {
    const m = newMatch();
    m.player(0).credits = 5000;
    const gun = cannonsOf(m.world, 0)[0]!;
    gun.hp = 10;
    expect(buyUpgrade(m.state, 0, gun.id, 'plating').ok).toBe(true);
    expect(gun.upgrades?.plating).toBe(1);
    expect(gun.hp).toBe(gun.maxHp);
    expect(buyUpgrade(m.state, 0, gun.id, 'rifling').ok).toBe(true);
    expect(buyUpgrade(m.state, 0, gun.id, 'rifling').ok).toBe(true);
    // Rifling maxes out at two levels.
    expect(buyUpgrade(m.state, 0, gun.id, 'rifling').ok).toBe(false);
  });

  test('you cannot spend credits you do not have', () => {
    const m = newMatch();
    m.player(0).credits = 10;
    expect(buyCannon(m.state, 0, 'longgun', 500).ok).toBe(false);
    expect(build(m.state, 0, 'wall', 500, 0).ok).toBe(false);
    expect(m.player(0).credits).toBe(10);
  });

  test('walls drop onto the ground where you place them', () => {
    const m = newMatch();
    m.player(0).credits = 900;
    const before = m.world.entities.length;
    const out = build(m.state, 0, 'wall', 620, 0);
    expect(out.ok).toBe(true);
    expect(m.world.entities.length).toBe(before + 1);
    const wall = m.world.entities[m.world.entities.length - 1]!;
    expect(wall.owner).toBe(0);
    expect(wall.y).toBeGreaterThan(0);
  });
});

describe('bot', () => {
  test('finds a shot and eventually wins a whole match', () => {
    const m = new Match({ seed: 99, names: ['A', 'B'], bots: [true, true] });
    let guard = 0;
    while (m.state.phase === 'playing' && guard++ < 300) {
      const side = m.state.turn;
      botShop(m, side, 2);
      const plan = planShot(m, side, 2);
      if (!plan) {
        m.endTurn();
        continue;
      }
      m.fire(side, plan);
      if (m.state.turn === side && m.state.shotsLeft <= 0) m.endTurn();
    }
    expect(m.state.phase).toBe('over');
    expect(m.state.turnNumber).toBeLessThan(60);
    const summary = m.summary();
    expect(summary.scores[0].stats.shots + summary.scores[1].stats.shots).toBeGreaterThan(4);
  }, 30000);
});
