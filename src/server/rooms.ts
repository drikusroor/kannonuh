import { TICK_HZ, TURN_SECONDS } from '../shared/constants.ts';
import { buyAmmo, buyCannon, buyUpgrade, build } from '../shared/shop.ts';
import type {
  ClientMsg,
  GameSummary,
  RoomInfo,
  RoomMode,
  ServerMsg,
  ShotResult,
  Side,
} from '../shared/types.ts';
import { botShop, planShot, type Difficulty } from './ai.ts';
import { Match, other } from './match.ts';

export interface Client {
  id: number;
  uid: string;
  name: string;
  send(msg: ServerMsg): void;
  room: Room | null;
  side: Side | -1;
  discordInstance?: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class Room {
  code: string;
  mode: RoomMode;
  difficulty: Difficulty = 1;
  hostUid = '';
  match: Match | null = null;
  seats: [Client | null, Client | null] = [null, null];
  /** Seats remember who sat there so a dropped player can come back. */
  seatUids: [string, string] = ['', ''];
  spectators = new Set<Client>();
  rematchVotes = new Set<string>();
  ready: [boolean, boolean] = [false, false];
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = Date.now();
  /** When a seat went quiet, so we can hold it open for a reconnect. */
  private droppedAt: [number, number] = [0, 0];

  constructor(code: string, mode: RoomMode) {
    this.code = code;
    this.mode = mode;
  }

  get everyone(): Client[] {
    const out: Client[] = [];
    for (const s of this.seats) if (s) out.push(s);
    for (const s of this.spectators) out.push(s);
    return out;
  }

  broadcast(msg: ServerMsg): void {
    for (const c of this.everyone) c.send(msg);
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  idleMs(): number {
    return Date.now() - this.lastActivity;
  }

  info(): RoomInfo {
    return {
      code: this.code,
      mode: this.mode,
      hostUid: this.hostUid,
      players: ([0, 1] as Side[]).map((side) => ({
        side,
        name: this.match ? this.match.player(side).name : this.seats[side]?.name ?? '',
        uid: this.seatUids[side],
        bot: this.mode === 'practice' && side === 1,
        connected: !!this.seats[side] || (this.mode === 'practice' && side === 1),
        ready: this.ready[side],
      })),
      spectators: this.spectators.size,
      phase: this.match?.state.phase ?? 'lobby',
      rematchVotes: [...this.rematchVotes],
    };
  }

  sendRoom(): void {
    const info = this.info();
    this.broadcast({ t: 'room', info });
  }

  // -------------------------------------------------------------------------

  seat(client: Client): boolean {
    // Reclaim a seat this player already held.
    for (const side of [0, 1] as Side[]) {
      if (this.seatUids[side] === client.uid && !this.seats[side]) {
        this.attach(client, side);
        return true;
      }
    }
    for (const side of [0, 1] as Side[]) {
      if (this.mode === 'practice' && side === 1) continue;
      if (!this.seats[side] && !this.seatUids[side]) {
        this.attach(client, side);
        return true;
      }
    }
    this.spectators.add(client);
    client.room = this;
    client.side = -1;
    return false;
  }

  private attach(client: Client, side: Side): void {
    this.seats[side] = client;
    this.droppedAt[side] = 0;
    this.seatUids[side] = client.uid;
    client.room = this;
    client.side = side;
    if (!this.hostUid) this.hostUid = client.uid;
    if (this.match) {
      const p = this.match.player(side);
      p.connected = true;
      p.name = client.name;
      p.uid = client.uid;
    }
  }

  detach(client: Client): void {
    this.spectators.delete(client);
    for (const side of [0, 1] as Side[]) {
      if (this.seats[side] === client) {
        this.seats[side] = null;
        this.droppedAt[side] = Date.now();
        if (this.match) this.match.player(side).connected = false;
        this.ready[side] = false;
      }
    }
    this.rematchVotes.delete(client.uid);
    client.room = null;
    client.side = -1;
    this.touch();
  }

  get occupied(): number {
    return this.seats.filter(Boolean).length;
  }

  canStart(): boolean {
    if (this.match && this.match.state.phase !== 'over') return false;
    if (this.mode === 'practice') return !!this.seats[0];
    return this.ready[0] && this.ready[1] && !!this.seats[0] && !!this.seats[1];
  }

  start(seed?: number): void {
    const names: [string, string] = [
      this.seats[0]?.name ?? 'Red',
      this.mode === 'practice' ? botName(this.difficulty) : this.seats[1]?.name ?? 'Blue',
    ];
    this.match = new Match({ seed, names, bots: [false, this.mode === 'practice'] });
    for (const side of [0, 1] as Side[]) {
      const p = this.match.player(side);
      p.connected = !!this.seats[side] || (this.mode === 'practice' && side === 1);
      p.uid = this.seatUids[side];
    }
    this.ready = [false, false];
    this.rematchVotes.clear();
    this.touch();
    for (const c of this.everyone) {
      c.send({ t: 'match', state: this.match.snapshot(true), you: c.side });
    }
    this.sendRoom();
    this.kickBot(1400);
  }

  pushState(): void {
    if (!this.match) return;
    this.broadcast({ t: 'state', state: this.match.snapshot() });
  }

  // -------------------------------------------------------------------------

  handleFire(side: Side, msg: Extract<ClientMsg, { t: 'fire' }>): string | null {
    const match = this.match;
    if (!match) return 'No battle in progress.';
    const out = match.fire(side, {
      cannonId: msg.cannonId,
      elevation: msg.elevation,
      power: msg.power,
      ammo: msg.ammo,
    });
    if (out.error) return out.error;
    this.touch();
    const result = out.result!;
    // Give both sides the length of the replay before the clock bites again.
    match.state.deadline = Date.now() + replayMs(result) + TURN_SECONDS * 1000;
    // Terrain rides along so a long battle can never drift out of step.
    this.broadcast({ t: 'shot', result, state: match.snapshot(true) });
    if (out.summary) {
      this.finish(out.summary);
      return null;
    }
    this.kickBot(replayMs(result) + 900);
    return null;
  }

  endTurn(side: Side): void {
    const match = this.match;
    if (!match || match.state.phase !== 'playing' || match.state.turn !== side) return;
    match.endTurn();
    this.touch();
    if (this.match?.state.phase === 'over') {
      this.finish(match.summary('forfeit'));
      return;
    }
    this.pushState();
    this.kickBot(1200);
  }

  finish(summary: GameSummary): void {
    if (!this.match) return;
    this.broadcast({ t: 'over', summary, state: this.match.snapshot() });
    this.sendRoom();
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
  }

  forfeit(side: Side): void {
    const match = this.match;
    if (!match || match.state.phase !== 'playing') return;
    const summary = match.finish(other(side), 'forfeit');
    if (summary) this.finish(summary);
  }

  /** Server-side clock: turn timer plus the reconnect grace period. */
  tick(): void {
    const match = this.match;
    if (!match || match.state.phase !== 'playing') return;

    for (const side of [0, 1] as Side[]) {
      if (this.mode === 'practice' && side === 1) continue;
      if (this.seats[side] || !this.droppedAt[side]) continue;
      const gone = Date.now() - this.droppedAt[side];
      if (gone > RECONNECT_GRACE_MS) {
        this.broadcast({
          t: 'toast',
          kind: 'warn',
          text: `${match.player(side).name} never came back.`,
        });
        this.forfeit(side);
        return;
      }
    }

    if (!match.timedOut()) return;
    const side = match.state.turn;
    this.broadcast({ t: 'toast', kind: 'warn', text: `${match.player(side).name} ran out of time.` });
    this.endTurn(side);
  }

  // -------------------------------------------------------------------------
  // Practice-mode opponent
  // -------------------------------------------------------------------------

  kickBot(delay: number): void {
    if (this.mode !== 'practice') return;
    const match = this.match;
    if (!match || match.state.phase !== 'playing' || match.state.turn !== 1) return;
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = setTimeout(() => this.botTurn(), Math.max(400, delay));
  }

  private botTurn(): void {
    this.botTimer = null;
    const match = this.match;
    if (!match || match.state.phase !== 'playing' || match.state.turn !== 1) return;
    botShop(match, 1, this.difficulty);
    const plan = planShot(match, 1, this.difficulty);
    if (!plan) {
      this.endTurn(1);
      return;
    }
    this.broadcast({
      t: 'aim',
      side: 1,
      cannonId: plan.cannonId,
      elevation: plan.elevation,
      power: plan.power,
      ammo: plan.ammo,
    });
    const err = this.handleFire(1, { t: 'fire', ...plan });
    if (err) {
      this.endTurn(1);
      return;
    }
    if (match.state.phase === 'playing' && match.state.turn === 1 && match.state.shotsLeft > 0) {
      // handleFire already scheduled the next kick.
    }
  }
}

/** How long a dropped player keeps their seat before losing by default. */
export const RECONNECT_GRACE_MS = 45_000;

export function replayMs(result: ShotResult): number {
  return (result.ticks / TICK_HZ) * 1000 + 1200;
}

function botName(difficulty: Difficulty): string {
  return difficulty === 0 ? 'Cadet Fitz' : difficulty === 1 ? 'Sgt. Bombard' : 'Master Gunner Vos';
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class Lobby {
  rooms = new Map<string, Room>();
  /** Discord activity instance id → room code, so an Activity is one battle. */
  private byInstance = new Map<string, string>();

  create(mode: RoomMode, instanceId?: string): Room {
    const code = instanceId ? this.instanceCode(instanceId) : this.freshCode();
    const room = new Room(code, mode);
    this.rooms.set(code, room);
    if (instanceId) this.byInstance.set(instanceId, code);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase().trim());
  }

  forInstance(instanceId: string, mode: RoomMode = 'versus'): Room {
    const existing = this.byInstance.get(instanceId);
    if (existing) {
      const room = this.rooms.get(existing);
      if (room) return room;
    }
    return this.create(mode, instanceId);
  }

  /** A live battle where this player still holds an empty seat. */
  findSeat(uid: string): Room | undefined {
    if (!uid) return undefined;
    for (const room of this.rooms.values()) {
      if (!room.match || room.match.state.phase === 'over') continue;
      for (const side of [0, 1] as Side[]) {
        if (room.seatUids[side] === uid && !room.seats[side]) return room;
      }
    }
    return undefined;
  }

  findOpen(): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.mode !== 'versus') continue;
      if (room.match && room.match.state.phase !== 'over') continue;
      if (room.occupied === 1) return room;
    }
    return undefined;
  }

  remove(room: Room): void {
    this.rooms.delete(room.code);
    for (const [k, v] of this.byInstance) if (v === room.code) this.byInstance.delete(k);
  }

  sweep(): void {
    for (const room of [...this.rooms.values()]) {
      if (room.everyone.length === 0 && room.idleMs() > 5 * 60_000) this.remove(room);
    }
  }

  private freshCode(): string {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    return `R${Date.now().toString(36).slice(-3).toUpperCase()}`;
  }

  private instanceCode(instanceId: string): string {
    let h = 0;
    for (let i = 0; i < instanceId.length; i++) h = (Math.imul(h, 31) + instanceId.charCodeAt(i)) | 0;
    let code = '';
    let v = Math.abs(h);
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[v % CODE_ALPHABET.length];
      v = Math.floor(v / CODE_ALPHABET.length);
    }
    return this.rooms.has(code) ? `${code[0]}${Date.now().toString(36).slice(-3).toUpperCase()}` : code;
  }
}

/** Applies a shop action and reports what to tell the buyer. */
export function applyShop(room: Room, side: Side, msg: ClientMsg): { error?: string; note?: string } {
  const match = room.match;
  if (!match || match.state.phase !== 'playing') return { error: 'The battle is not running.' };
  if (match.state.turn !== side) return { error: 'You can only requisition on your own turn.' };
  const player = match.player(side);
  switch (msg.t) {
    case 'buyAmmo':
      return buyAmmo(player, msg.ammo);
    case 'buyCannon':
      return buyCannon(match.state, side, msg.cannon, msg.x);
    case 'buyUpgrade':
      return buyUpgrade(match.state, side, msg.cannonId, msg.upgrade);
    case 'build':
      return build(match.state, side, msg.build, msg.x, msg.y);
    default:
      return { error: 'Unknown purchase.' };
  }
}
