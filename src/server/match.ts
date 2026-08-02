import {
  AMMO,
  AMMO_ORDER,
  BURN_DAMAGE,
  CANNONS,
  INCOME_PER_TURN,
  MAX_SHOTS_PER_TURN,
  STARTING_CREDITS,
  TURN_SECONDS,
  type AmmoId,
} from '../shared/constants.ts';
import { Rng } from '../shared/rng.ts';
import { emptyStats, summarise } from '../shared/scoring.ts';
import { simulateShot, shotTally, type ShotOrder } from '../shared/sim.ts';
import type {
  GameSummary,
  MatchSnapshot,
  MatchState,
  PlayerState,
  ShotResult,
  Side,
} from '../shared/types.ts';
import { cannonsOf, createWorld, facing, findEntity, kingOf, placeCannon, rollWind } from '../shared/world.ts';

export interface MatchOptions {
  seed?: number;
  names: [string, string];
  bots: [boolean, boolean];
}

export class Match {
  state: MatchState;
  private rng: Rng;
  private shotSeq = 0;
  private reserves: [number, number] = [0, 0];

  constructor(opts: MatchOptions) {
    const seed = opts.seed ?? (Math.random() * 0xffffffff) >>> 0;
    this.rng = new Rng(seed ^ 0x5bf03635);
    const world = createWorld(seed);
    this.state = {
      world,
      players: [makePlayer(0, opts.names[0], opts.bots[0]), makePlayer(1, opts.names[1], opts.bots[1])],
      phase: 'playing',
      turn: 0,
      turnNumber: 1,
      shotsLeft: 0,
      deadline: 0,
      winner: -1,
      startedAt: Date.now(),
      endedAt: 0,
    };
    this.beginTurn(0, true);
  }

  // -------------------------------------------------------------------------

  get world() {
    return this.state.world;
  }

  player(side: Side): PlayerState {
    return this.state.players[side];
  }

  snapshot(withTerrain = false): MatchSnapshot {
    const { world, ...rest } = this.state;
    const { terrain, ...worldRest } = world;
    return {
      ...rest,
      // Two decimals is plenty for drawing, and keeps the payload small.
      world: withTerrain ? { ...worldRest, terrain: terrain.map((v) => Math.round(v * 100) / 100) } : { ...worldRest },
    };
  }

  // -------------------------------------------------------------------------

  beginTurn(side: Side, first = false): void {
    const state = this.state;
    state.turn = side;
    if (!first) state.turnNumber++;

    const player = state.players[side];
    if (!first) {
      player.credits += INCOME_PER_TURN;
      player.stats.creditsEarned += INCOME_PER_TURN;
    }

    // Fire burns down whatever it caught last round.
    for (const e of state.world.entities) {
      if (!e.burning || e.burning <= 0) continue;
      if (e.owner !== side && !(e.owner === -1 && side === 0)) continue;
      e.hp -= BURN_DAMAGE;
      e.burning--;
      if (e.hp <= 0) e.hp = 0;
    }
    state.world.entities = state.world.entities.filter((e) => e.hp > 0);

    // A gunner with no guns gets a militia piece rolled up — twice.
    let guns = cannonsOf(state.world, side);
    if (guns.length === 0 && this.reserves[side] < 2) {
      this.reserves[side]++;
      const king = kingOf(state.world, side);
      const bx = king ? king.x + 120 * facing(side) : side === 0 ? 300 : 2300;
      placeCannon(state.world, side, 'field', bx);
      guns = cannonsOf(state.world, side);
    }

    for (const c of guns) c.firedThisTurn = false;
    state.shotsLeft = Math.min(MAX_SHOTS_PER_TURN, guns.length);
    state.world.wind = rollWind(this.rng);
    state.deadline = Date.now() + TURN_SECONDS * 1000;

    if (guns.length === 0) {
      // No guns and no reserves left: the siege is over.
      this.finish(other(side), 'forfeit');
    }
  }

  endTurn(): GameSummary | null {
    if (this.state.phase !== 'playing') return null;
    this.beginTurn(other(this.state.turn));
    return null;
  }

  fire(side: Side, order: Omit<ShotOrder, 'side'>): { result?: ShotResult; error?: string; summary?: GameSummary } {
    const state = this.state;
    if (state.phase !== 'playing') return { error: 'The battle is not running.' };
    if (state.turn !== side) return { error: 'It is not your turn.' };
    if (state.shotsLeft <= 0) return { error: 'No shots left this turn.' };

    const cannon = findEntity(state.world, order.cannonId);
    if (!cannon || cannon.kind !== 'cannon' || cannon.owner !== side || cannon.hp <= 0) {
      return { error: 'That gun is not available.' };
    }
    if (cannon.firedThisTurn) return { error: 'That gun has already fired this turn.' };

    const ammo = order.ammo;
    const player = state.players[side];
    if (AMMO[ammo].cost > 0 && (player.ammo[ammo] ?? 0) <= 0) {
      return { error: `No ${AMMO[ammo].name} in the magazine.` };
    }
    if (AMMO[ammo].cost > 0) player.ammo[ammo]--;

    const def = CANNONS[cannon.cannon ?? 'field'];
    const elevation = Math.max(def.minElevation, Math.min(def.maxElevation, order.elevation));
    const power = Math.max(5, Math.min(100, order.power));
    cannon.elevation = elevation;
    cannon.power = power;
    cannon.ammo = ammo;
    cannon.firedThisTurn = true;

    const result = simulateShot(state.world, { side, cannonId: cannon.id, elevation, power, ammo }, ++this.shotSeq * 2654435761 + state.world.seed);

    const tally = shotTally(result);
    const foe = state.players[other(side)];
    player.stats.shots++;
    if (result.damage > 0) player.stats.hits++;
    player.stats.damageDealt += result.damage;
    player.stats.cannonsKilled += tally.cannons;
    player.stats.structuresKilled += tally.structures;
    player.stats.barrelsPopped += tally.barrels;
    player.stats.bestHit = Math.max(player.stats.bestHit, tally.bestHit);
    player.stats.kingHits += tally.kingHits;
    player.stats.longestShot = Math.max(player.stats.longestShot, result.distance);
    player.credits += result.credits;
    player.stats.creditsEarned += result.credits;
    foe.stats.damageTaken += result.damage;
    player.stats.damageTaken += result.selfDamage;

    state.shotsLeft--;

    const enemyKing = kingOf(state.world, other(side));
    if (!enemyKing) {
      return { result, summary: this.finish(side, 'king') ?? undefined };
    }
    if (state.shotsLeft <= 0) {
      this.beginTurn(other(side));
      if (this.state.phase === 'over') {
        return { result, summary: summarise(this.state, 'forfeit') };
      }
    }
    return { result };
  }

  timedOut(): boolean {
    return this.state.phase === 'playing' && Date.now() > this.state.deadline + 1500;
  }

  finish(winner: Side | -1, reason: GameSummary['reason']): GameSummary | null {
    if (this.state.phase === 'over') return null;
    this.state.phase = 'over';
    this.state.winner = winner;
    this.state.endedAt = Date.now();
    return summarise(this.state, reason);
  }

  summary(reason: GameSummary['reason'] = 'king'): GameSummary {
    return summarise(this.state, reason);
  }
}

export function other(side: Side): Side {
  return side === 0 ? 1 : 0;
}

function makePlayer(side: Side, name: string, bot: boolean): PlayerState {
  const ammo = Object.fromEntries(AMMO_ORDER.map((a) => [a, 0])) as Record<AmmoId, number>;
  ammo.round = 999;
  ammo.shell = 3;
  return {
    side,
    name,
    uid: '',
    bot,
    connected: false,
    credits: STARTING_CREDITS,
    ammo,
    stats: emptyStats(),
    ready: false,
  };
}
