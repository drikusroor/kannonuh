import type { AmmoId, CannonId, UpgradeId, BuildId, Material } from './constants.ts';

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export type EntityKind = 'cannon' | 'king' | 'block' | 'timber' | 'barrel' | 'tree' | 'rock';

/** -1 marks neutral scenery that belongs to nobody. */
export type Side = 0 | 1;
export type Owner = Side | -1;

export interface Entity {
  id: number;
  kind: EntityKind;
  owner: Owner;
  /** Centre position. */
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  mat: Material;
  /** Stable per-entity randomness so textures do not shimmer between frames. */
  seed: number;
  /** Cannons only. */
  cannon?: CannonId;
  elevation?: number;
  power?: number;
  ammo?: AmmoId;
  upgrades?: Partial<Record<UpgradeId, number>>;
  firedThisTurn?: boolean;
  /** Turns of fire remaining. */
  burning?: number;
  /** Decorative variation index. */
  variant?: number;
}

export interface WorldState {
  seed: number;
  /** Surface Y for each terrain column; smaller Y is higher ground. */
  terrain: number[];
  entities: Entity[];
  nextId: number;
  /** -1..1, negative blows left. */
  wind: number;
  /** 0..1 picks the sky palette. */
  timeOfDay: number;
  theme: number;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface PlayerStats {
  shots: number;
  hits: number;
  damageDealt: number;
  damageTaken: number;
  cannonsKilled: number;
  structuresKilled: number;
  barrelsPopped: number;
  bestHit: number;
  kingHits: number;
  creditsEarned: number;
  creditsSpent: number;
  longestShot: number;
}

export interface PlayerState {
  side: Side;
  name: string;
  /** Empty for an open seat. */
  uid: string;
  bot: boolean;
  connected: boolean;
  credits: number;
  ammo: Record<AmmoId, number>;
  stats: PlayerStats;
  ready: boolean;
  emote?: { icon: string; at: number };
}

export type Phase = 'lobby' | 'countdown' | 'playing' | 'resolving' | 'over';

export interface MatchState {
  world: WorldState;
  players: [PlayerState, PlayerState];
  phase: Phase;
  turn: Side;
  turnNumber: number;
  shotsLeft: number;
  /** Epoch ms when the current turn expires. */
  deadline: number;
  winner: Side | -1;
  startedAt: number;
  endedAt: number;
}

/** Match state as sent over the wire; terrain only rides along when it changed wholesale. */
export type MatchSnapshot = Omit<MatchState, 'world'> & {
  world: Omit<WorldState, 'terrain'> & { terrain?: number[] };
};

// ---------------------------------------------------------------------------
// Simulation output
// ---------------------------------------------------------------------------

export interface ShotTrack {
  id: number;
  ammo: AmmoId;
  /** Tick this projectile came into existence. */
  birth: number;
  /** Flat [x0,y0,x1,y1,…] sampled once per tick. */
  pts: number[];
  /** How the flight ended, for the client's impact effects. */
  end: 'terrain' | 'entity' | 'air' | 'edge';
}

export type SimEvent =
  | { k: 'muzzle'; t: number; x: number; y: number; a: number; power: number }
  | { k: 'boom'; t: number; x: number; y: number; r: number; kind: 'shell' | 'barrel' | 'fire' }
  | { k: 'hit'; t: number; x: number; y: number; id: number; dmg: number; mat: Material }
  | { k: 'thud'; t: number; x: number; y: number }
  | { k: 'bounce'; t: number; x: number; y: number; speed: number }
  | { k: 'split'; t: number; x: number; y: number }
  | { k: 'crater'; t: number; x: number; y: number; r: number }
  | { k: 'gone'; t: number; x: number; y: number; id: number; kind: EntityKind; mat: Material }
  | { k: 'ignite'; t: number; id: number }
  | { k: 'king'; t: number; x: number; y: number; dmg: number; hp: number };

export interface ShotResult {
  by: Side;
  cannonId: number;
  ammo: AmmoId;
  elevation: number;
  power: number;
  tracks: ShotTrack[];
  events: SimEvent[];
  ticks: number;
  damage: number;
  selfDamage: number;
  hits: number;
  credits: number;
  /** Distance from muzzle to first impact, for the stats screen. */
  distance: number;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreLine {
  label: string;
  detail: string;
  points: number;
}

export interface PlayerScore {
  side: Side;
  name: string;
  total: number;
  lines: ScoreLine[];
  stats: PlayerStats;
  accuracy: number;
}

export interface GameSummary {
  winner: Side | -1;
  reason: 'king' | 'forfeit' | 'draw';
  turns: number;
  durationMs: number;
  scores: [PlayerScore, PlayerScore];
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export type RoomMode = 'versus' | 'practice';

export interface RoomInfo {
  code: string;
  mode: RoomMode;
  hostUid: string;
  players: { side: Side; name: string; uid: string; bot: boolean; connected: boolean; ready: boolean }[];
  spectators: number;
  phase: Phase;
  rematchVotes: string[];
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

export type ClientMsg =
  | { t: 'hello'; name: string; uid?: string; discord?: { instanceId: string; userId?: string; channel?: string } }
  | { t: 'create'; mode: RoomMode; difficulty?: number }
  | { t: 'join'; code: string }
  | { t: 'quick' }
  | { t: 'leave' }
  | { t: 'ready'; value: boolean }
  | { t: 'buyAmmo'; ammo: AmmoId }
  | { t: 'buyCannon'; cannon: CannonId; x: number }
  | { t: 'buyUpgrade'; cannonId: number; upgrade: UpgradeId }
  | { t: 'build'; build: BuildId; x: number; y: number }
  | { t: 'aim'; cannonId: number; elevation: number; power: number; ammo: AmmoId }
  | { t: 'fire'; cannonId: number; elevation: number; power: number; ammo: AmmoId }
  | { t: 'endTurn' }
  | { t: 'chat'; text: string }
  | { t: 'emote'; icon: string }
  | { t: 'rematch' }
  | { t: 'resign' }
  | { t: 'ping'; at: number };

export type ServerMsg =
  | { t: 'welcome'; uid: string; name: string }
  | { t: 'room'; info: RoomInfo | null }
  | { t: 'match'; state: MatchSnapshot; you: Side | -1 }
  | { t: 'state'; state: MatchSnapshot }
  | { t: 'shot'; result: ShotResult; state: MatchSnapshot }
  | { t: 'aim'; side: Side; cannonId: number; elevation: number; power: number; ammo: AmmoId }
  | { t: 'chat'; from: string; side: Side | -1; text: string; at: number }
  | { t: 'emote'; side: Side; icon: string }
  | { t: 'over'; summary: GameSummary; state: MatchSnapshot }
  | { t: 'toast'; kind: 'info' | 'warn' | 'good'; text: string }
  | { t: 'error'; text: string }
  | { t: 'pong'; at: number };
