/**
 * Runs a battle entirely in the browser — no server, no WebSocket. Powers
 * both "Practice siege" (vs the bot) and "Hot-seat" (two players, one
 * screen, passing the device each turn) so they work even on a static
 * deploy like GitHub Pages.
 *
 * Reuses the exact same `Room`/`Match`/bot logic the server runs, just fed
 * by in-process `Client` stubs instead of real sockets.
 */
import { applyShop, Room, type Client } from '../server/rooms.ts';
import type { Difficulty } from '../server/ai.ts';
import type { ClientMsg, ServerMsg, Side } from '../shared/types.ts';

export type LocalMode = 'practice' | 'hotseat';

export class LocalGame {
  private room: Room;
  private clients: [Client, Client];
  private mode: LocalMode;
  private handler: (msg: ServerMsg) => void;
  private timer: ReturnType<typeof setInterval>;
  /** Room.broadcast() calls every seated client's `send` with the same message object; in
   *  hot-seat both seats point at this one handler, so drop the exact repeat. */
  private lastDelivered: ServerMsg | null = null;

  constructor(mode: LocalMode, difficulty: Difficulty, playerName: string, handler: (msg: ServerMsg) => void) {
    this.mode = mode;
    this.handler = handler;
    this.room = new Room('LOCAL', mode === 'practice' ? 'practice' : 'versus');
    if (mode === 'practice') this.room.difficulty = difficulty;

    const client0: Client = { id: 1, uid: 'local-1', name: playerName || 'Red', room: null, side: -1, send: (m) => this.deliver(m) };
    const client1: Client = { id: 2, uid: 'local-2', name: 'Blue', room: null, side: -1, send: (m) => this.deliver(m) };
    this.clients = [client0, client1];

    this.room.seat(client0);
    if (mode === 'hotseat') {
      this.room.seat(client1);
      this.room.ready = [true, true];
    }
    this.room.start();
    // Mirrors the server's tick loop: turn timeout, nothing else applies locally.
    this.timer = setInterval(() => this.room.tick(), 1000);
  }

  /** Both seats point at the same handler; only 'match' differs per seat (its `you`), and the UI derives that itself for hot-seat. */
  private deliver(msg: ServerMsg): void {
    if (msg.t === 'match' && msg.you !== 0) return;
    if (msg === this.lastDelivered) return;
    this.lastDelivered = msg;
    this.handler(msg);
  }

  /** Who is acting: the sole human in practice, whoever's turn it is in hot-seat. */
  private actingSide(): Side {
    if (this.mode === 'practice') return 0;
    return (this.room.match?.state.turn ?? 0) as Side;
  }

  send(msg: ClientMsg): void {
    const side = this.actingSide();
    const client = this.clients[side]!;
    switch (msg.t) {
      case 'buyAmmo':
      case 'buyCannon':
      case 'buyUpgrade':
      case 'build': {
        const out = applyShop(this.room, side, msg);
        if (out.error) client.send({ t: 'error', text: out.error });
        else {
          if (out.note) client.send({ t: 'toast', kind: 'good', text: out.note });
          this.room.pushState();
        }
        return;
      }
      case 'fire': {
        const error = this.room.handleFire(side, msg);
        if (error) client.send({ t: 'error', text: error });
        return;
      }
      case 'endTurn':
        this.room.endTurn(side);
        return;
      case 'emote':
        this.room.broadcast({ t: 'emote', side, icon: String(msg.icon ?? '👋').slice(0, 4) });
        return;
      case 'resign':
        this.room.broadcast({ t: 'toast', kind: 'warn', text: `${client.name} struck the colours.` });
        this.room.forfeit(side);
        return;
      case 'rematch':
        if (this.room.match && this.room.match.state.phase === 'over') this.room.start();
        return;
      default:
        return;
    }
  }

  destroy(): void {
    clearInterval(this.timer);
  }
}
