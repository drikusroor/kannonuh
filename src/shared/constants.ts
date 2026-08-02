/**
 * Tuning values for Kannonuh. Everything that decides how the game *feels*
 * lives here so it can be balanced without touching the simulation.
 */

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export const WORLD_W = 2600;
export const WORLD_H = 1400;

/** Terrain is a heightmap: one surface sample every COL_W world units. */
export const COL_W = 5;
export const COLS = WORLD_W / COL_W; // 520

/** Simulation runs at a fixed step so every peer replays the same shot. */
export const TICK_HZ = 120;
export const DT = 1 / TICK_HZ;
/** Hard stop for a single shot resolution (~12s of flight). */
export const MAX_SHOT_TICKS = 1440;

export const GRAVITY = 700;
/** Linear drag: a = -DRAG * v. Keeps long shots from feeling weightless. */
export const DRAG = 0.045;
/** Wind acceleration applied per unit of wind strength. */
export const WIND_ACCEL = 26;

// ---------------------------------------------------------------------------
// Turn structure
// ---------------------------------------------------------------------------

export const TURN_SECONDS = 90;
export const MAX_SHOTS_PER_TURN = 3;
export const STARTING_CREDITS = 320;
export const INCOME_PER_TURN = 70;
/** Damage dealt is converted to credits at this rate. */
export const CREDITS_PER_DAMAGE = 0.22;

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export type Material = 'stone' | 'wood' | 'metal' | 'flesh' | 'powder' | 'earth';

// ---------------------------------------------------------------------------
// Ammunition
// ---------------------------------------------------------------------------

export type AmmoId = 'round' | 'shell' | 'grape' | 'mortar' | 'chain' | 'fire';

export interface AmmoDef {
  id: AmmoId;
  name: string;
  blurb: string;
  /** Cost per shot. Round shot is free — you always have something to fire. */
  cost: number;
  /** Bought in bundles of this size. */
  bundle: number;
  icon: string;
  /** Muzzle velocity multiplier. */
  speed: number;
  /** Projectile mass affects drag response — heavier shells punch through wind. */
  mass: number;
  radius: number;
  /** Direct impact damage. */
  impact: number;
  /** Explosion radius on impact (0 = solid shot). */
  blast: number;
  /** Peak explosion damage at the centre. */
  blastDamage: number;
  /** Crater radius carved out of the terrain. */
  crater: number;
  /** Solid shot can skip off shallow ground. */
  bounces: number;
  /** Splits into this many sub-projectiles at apex (grapeshot). */
  cluster?: { count: number; spread: number; atApex: boolean };
  /** Per-material damage multipliers. */
  vs: Partial<Record<Material, number>>;
  /** Sets fire to flammable targets. */
  incendiary?: boolean;
  trail: string;
}

export const AMMO: Record<AmmoId, AmmoDef> = {
  round: {
    id: 'round',
    name: 'Round Shot',
    blurb: 'Solid iron ball. Free, flat, and it skips off hillsides.',
    cost: 0,
    bundle: 0,
    icon: '⚫',
    speed: 1,
    mass: 1,
    radius: 6,
    impact: 38,
    blast: 0,
    blastDamage: 0,
    crater: 26,
    bounces: 2,
    vs: { stone: 1, wood: 1.1, metal: 1.1, flesh: 1.2 },
    trail: '#f6e2b8',
  },
  shell: {
    id: 'shell',
    name: 'Explosive Shell',
    blurb: 'Bursting charge. Reliable all-rounder that clears clutter.',
    cost: 55,
    bundle: 3,
    icon: '💣',
    speed: 0.98,
    mass: 1.1,
    radius: 7,
    impact: 20,
    blast: 70,
    blastDamage: 48,
    crater: 46,
    bounces: 0,
    vs: { stone: 0.9, wood: 1.2, metal: 1, flesh: 1.3, powder: 1.5 },
    trail: '#ffb45a',
  },
  grape: {
    id: 'grape',
    name: 'Grapeshot',
    blurb: 'Bursts into a cone of shot. Shreds crews and cannon, useless on stone.',
    cost: 45,
    bundle: 3,
    icon: '✳️',
    speed: 1.05,
    mass: 0.75,
    radius: 5,
    impact: 6,
    blast: 0,
    blastDamage: 0,
    crater: 8,
    bounces: 0,
    cluster: { count: 7, spread: 0.15, atApex: true },
    vs: { stone: 0.3, wood: 0.85, metal: 1.7, flesh: 2.0, powder: 1.2 },
    trail: '#cfd8e6',
  },
  mortar: {
    id: 'mortar',
    name: 'Mortar Bomb',
    blurb: 'Heavy lobbed bomb. Enormous blast, drops like a stone.',
    cost: 110,
    bundle: 2,
    icon: '🔴',
    speed: 0.9,
    mass: 1.8,
    radius: 10,
    impact: 34,
    blast: 96,
    blastDamage: 64,
    crater: 70,
    bounces: 0,
    vs: { stone: 1.15, wood: 1.3, metal: 1.1, flesh: 1.4, powder: 1.8 },
    trail: '#ff8a5c',
  },
  chain: {
    id: 'chain',
    name: 'Chain Shot',
    blurb: 'Two balls on a chain. Tears masonry and topples walls.',
    cost: 60,
    bundle: 3,
    icon: '⛓️',
    speed: 0.95,
    mass: 1.3,
    radius: 9,
    impact: 46,
    blast: 0,
    blastDamage: 0,
    crater: 22,
    bounces: 1,
    vs: { stone: 2.1, wood: 1.6, metal: 1.2, flesh: 1, powder: 1 },
    trail: '#d9c48a',
  },
  fire: {
    id: 'fire',
    name: 'Fire Shell',
    blurb: 'Pitch and naphtha. Sets timber and powder alight for several turns.',
    cost: 70,
    bundle: 2,
    icon: '🔥',
    speed: 0.97,
    mass: 1,
    radius: 7,
    impact: 16,
    blast: 60,
    blastDamage: 30,
    crater: 28,
    bounces: 0,
    incendiary: true,
    vs: { stone: 0.55, wood: 1.5, metal: 0.9, flesh: 1.5, powder: 2.2 },
    trail: '#ff6a2a',
  },
};

export const AMMO_ORDER: AmmoId[] = ['round', 'shell', 'grape', 'chain', 'fire', 'mortar'];

/** Burning targets take this much damage at the start of each of their owner's turns. */
export const BURN_DAMAGE = 11;
export const BURN_TURNS = 3;

// ---------------------------------------------------------------------------
// Cannons
// ---------------------------------------------------------------------------

export type CannonId = 'field' | 'mortar' | 'longgun';

export interface CannonDef {
  id: CannonId;
  name: string;
  blurb: string;
  cost: number;
  hp: number;
  /** Muzzle velocity multiplier. */
  speed: number;
  /** Random aim error in degrees before upgrades. */
  spread: number;
  minElevation: number;
  maxElevation: number;
  /** Bonus damage multiplier for shells fired from this piece. */
  ammoBonus?: Partial<Record<AmmoId, number>>;
  barrelLength: number;
  width: number;
  height: number;
}

export const CANNONS: Record<CannonId, CannonDef> = {
  field: {
    id: 'field',
    name: 'Field Cannon',
    blurb: 'The workhorse. Balanced velocity, takes a beating.',
    cost: 260,
    hp: 130,
    speed: 1,
    spread: 0.8,
    minElevation: 0,
    maxElevation: 86,
    barrelLength: 34,
    width: 44,
    height: 26,
  },
  mortar: {
    id: 'mortar',
    name: 'Siege Mortar',
    blurb: 'Squat and stubborn. Lobs over walls, loves heavy bombs.',
    cost: 430,
    hp: 165,
    speed: 0.92,
    spread: 1.2,
    minElevation: 32,
    maxElevation: 89,
    ammoBonus: { mortar: 1.35, shell: 1.1 },
    barrelLength: 24,
    width: 40,
    height: 30,
  },
  longgun: {
    id: 'longgun',
    name: 'Long Gun',
    blurb: 'Rifled monster. Flat, fast and frighteningly accurate.',
    cost: 640,
    hp: 105,
    speed: 1.18,
    spread: 0.25,
    minElevation: 0,
    maxElevation: 72,
    ammoBonus: { round: 1.2, chain: 1.15 },
    barrelLength: 46,
    width: 52,
    height: 24,
  },
};

export const CANNON_ORDER: CannonId[] = ['field', 'mortar', 'longgun'];

// ---------------------------------------------------------------------------
// Upgrades (applied to a single cannon)
// ---------------------------------------------------------------------------

export type UpgradeId = 'powder' | 'sights' | 'plating' | 'rifling';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  blurb: string;
  cost: number;
  maxLevel: number;
  icon: string;
}

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  powder: {
    id: 'powder',
    name: 'Better Powder',
    blurb: '+8% muzzle velocity per level. Reach further, hit harder.',
    cost: 150,
    maxLevel: 3,
    icon: '🧨',
  },
  sights: {
    id: 'sights',
    name: 'Gunner Sights',
    blurb: 'Halves aim scatter per level. Third level is dead true.',
    cost: 130,
    maxLevel: 3,
    icon: '🎯',
  },
  plating: {
    id: 'plating',
    name: 'Iron Plating',
    blurb: '+45 hit points and repairs the piece to full.',
    cost: 120,
    maxLevel: 3,
    icon: '🛡️',
  },
  rifling: {
    id: 'rifling',
    name: 'Rifled Bore',
    blurb: '+12% shot damage per level.',
    cost: 180,
    maxLevel: 2,
    icon: '🌀',
  },
};

export const UPGRADE_ORDER: UpgradeId[] = ['powder', 'sights', 'plating', 'rifling'];

// ---------------------------------------------------------------------------
// Buildable structures
// ---------------------------------------------------------------------------

export type BuildId = 'wall' | 'timber' | 'barrel' | 'repair';

export interface BuildDef {
  id: BuildId;
  name: string;
  blurb: string;
  cost: number;
  icon: string;
}

export const BUILDS: Record<BuildId, BuildDef> = {
  wall: {
    id: 'wall',
    name: 'Stone Block',
    blurb: 'Drop a 30×30 masonry block anywhere on your half.',
    cost: 90,
    icon: '🧱',
  },
  timber: {
    id: 'timber',
    name: 'Timber Barricade',
    blurb: 'Cheap, wide, burns. Buys you a turn or two.',
    cost: 45,
    icon: '🪵',
  },
  barrel: {
    id: 'barrel',
    name: 'Powder Barrel',
    blurb: 'A trap for the greedy. Detonates violently when struck.',
    cost: 55,
    icon: '🛢️',
  },
  repair: {
    id: 'repair',
    name: 'Masons',
    blurb: 'Restore 40 hit points to every damaged structure you own.',
    cost: 140,
    icon: '🔨',
  },
};

export const BUILD_ORDER: BuildId[] = ['wall', 'timber', 'barrel', 'repair'];

// ---------------------------------------------------------------------------
// Entity health
// ---------------------------------------------------------------------------

export const HP = {
  stoneBlock: 95,
  timber: 52,
  king: 320,
  barrel: 22,
  tree: 26,
  rock: 210,
} as const;

/** Explosion of a powder barrel. */
export const BARREL_BLAST = { radius: 118, damage: 74, crater: 56 };

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const SCORE = {
  win: 1200,
  accuracyBonus: 600,
  /** Points per turn saved under this par. */
  parTurns: 14,
  perTurnSaved: 55,
  damageDealt: 0.35,
  damageTaken: -0.18,
  cannonKill: 90,
  structureKill: 12,
  creditsLeft: 0.08,
  survivingKingHp: 1.2,
} as const;

export const KILL_REWARD: Record<string, number> = {
  cannon: 120,
  king: 0,
  block: 15,
  timber: 10,
  barrel: 28,
  tree: 4,
  rock: 14,
};
