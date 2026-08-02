import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import type { ClientMsg, ServerMsg } from '../src/shared/types.ts';

const PORT = 3199 + Math.floor(Math.random() * 400);
let server: Subprocess;

/** A tiny scripted client that records everything the server says. */
class TestClient {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];

  static async connect(): Promise<TestClient> {
    const c = new TestClient();
    c.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    c.ws.onmessage = (ev) => c.inbox.push(JSON.parse(String(ev.data)) as ServerMsg);
    await new Promise<void>((resolve, reject) => {
      c.ws.onopen = () => resolve();
      c.ws.onerror = () => reject(new Error('socket failed'));
    });
    return c;
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Waits for a message of the given type, with a generous timeout. */
  async next<T extends ServerMsg['t']>(
    t: T,
    timeout = 6000,
    where: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMsg, { t: T }>> {
    const started = Date.now();
    for (;;) {
      const found = this.inbox.find(
        (m) => m.t === t && where(m as Extract<ServerMsg, { t: T }>),
      );
      if (found) {
        this.inbox.splice(this.inbox.indexOf(found), 1);
        return found as Extract<ServerMsg, { t: T }>;
      }
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for "${t}"`);
      await Bun.sleep(20);
    }
  }

  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  server = Bun.spawn(['bun', 'src/server/index.ts'], {
    env: { ...process.env, PORT: String(PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(60);
  }
  throw new Error('server never came up');
});

afterAll(() => {
  server?.kill();
});

describe('http', () => {
  test('serves a health probe', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test('serves the client shell, also under the Discord proxy prefix', async () => {
    const direct = await fetch(`http://localhost:${PORT}/`);
    expect(direct.status).toBe(200);
    expect(direct.headers.get('content-type')).toContain('text/html');
    const proxied = await fetch(`http://localhost:${PORT}/.proxy/`);
    expect(proxied.status).toBe(200);
    expect(await proxied.text()).toContain('KANNONUH');
  });

  test('refuses to walk out of the public directory', async () => {
    const res = await fetch(`http://localhost:${PORT}/../package.json`);
    const body = await res.text();
    expect(body).not.toContain('"@discord/embedded-app-sdk"');
  });
});

describe('versus flow', () => {
  test('two players meet by code, fight, and one leaving ends it', async () => {
    const a = await TestClient.connect();
    const b = await TestClient.connect();

    a.send({ t: 'hello', name: 'Ada' });
    const welcomeA = await a.next('welcome');
    expect(welcomeA.uid).toBeTruthy();
    b.send({ t: 'hello', name: 'Baz' });
    const welcomeB = await b.next('welcome');

    a.send({ t: 'create', mode: 'versus' });
    const roomA = await a.next('room', 6000, (m) => !!m.info);
    const code = roomA.info!.code;
    expect(code).toHaveLength(4);

    b.send({ t: 'join', code });
    const roomB = await b.next('room', 6000, (m) => (m.info?.players.filter((p) => p.uid).length ?? 0) === 2);
    expect(roomB.info!.players.filter((p) => p.uid).length).toBe(2);

    a.send({ t: 'ready', value: true });
    b.send({ t: 'ready', value: true });

    const matchA = await a.next('match');
    const matchB = await b.next('match');
    expect(matchA.you).toBe(0);
    expect(matchB.you).toBe(1);
    expect(matchA.state.world.terrain).toBeDefined();
    expect(matchA.state.world.entities.length).toBeGreaterThan(20);

    // Blue cannot shoot on red's turn.
    const blueGun = matchB.state.world.entities.find((e) => e.kind === 'cannon' && e.owner === 1)!;
    b.send({ t: 'fire', cannonId: blueGun.id, elevation: 45, power: 70, ammo: 'round' });
    expect((await b.next('error')).text).toContain('not your turn');

    const redGun = matchA.state.world.entities.find((e) => e.kind === 'cannon' && e.owner === 0)!;
    a.send({ t: 'fire', cannonId: redGun.id, elevation: 42, power: 90, ammo: 'round' });
    const shot = await a.next('shot');
    expect(shot.result.tracks[0]!.pts.length).toBeGreaterThan(10);
    expect(shot.result.by).toBe(0);
    await b.next('shot');

    // Shopping is turn-gated.
    b.send({ t: 'buyAmmo', ammo: 'shell' });
    expect((await b.next('error')).text).toContain('own turn');
    a.send({ t: 'buyAmmo', ammo: 'shell' });
    const bought = await a.next('toast', 6000, (m) => m.kind === 'good');
    expect(bought.text).toContain('Explosive');

    a.send({ t: 'chat', text: 'good luck' });
    expect((await b.next('chat')).text).toBe('good luck');

    // A dropped socket holds the seat open rather than ending the battle.
    b.close();
    await Bun.sleep(400);
    const stillRunning = await fetch(`http://localhost:${PORT}/health`);
    expect((await stillRunning.json()).rooms).toBeGreaterThan(0);

    // Reconnecting reclaims the same seat.
    const b2 = await TestClient.connect();
    b2.send({ t: 'hello', name: 'Baz', uid: welcomeB.uid });
    const rejoined = await b2.next('match', 6000);
    expect(rejoined.you).toBe(1);

    // Walking away deliberately hands the win to the other side.
    b2.send({ t: 'leave' });
    const over = await a.next('over');
    expect(over.summary.winner).toBe(0);
    expect(over.summary.reason).toBe('forfeit');
    a.close();
    b2.close();
  }, 20000);
});

describe('practice flow', () => {
  test('the bot takes its own turn without any help', async () => {
    const c = await TestClient.connect();
    c.send({ t: 'hello', name: 'Solo' });
    await c.next('welcome');
    c.send({ t: 'create', mode: 'practice', difficulty: 1 });
    const match = await c.next('match');
    expect(match.you).toBe(0);
    expect(match.state.players[1].bot).toBe(true);

    const gun = match.state.world.entities.find((e) => e.kind === 'cannon' && e.owner === 0)!;
    c.send({ t: 'fire', cannonId: gun.id, elevation: 40, power: 85, ammo: 'round' });
    await c.next('shot');
    c.send({ t: 'endTurn' });

    // The bot should answer within a few seconds.
    const botShot = await c.next('shot', 15000);
    expect(botShot.result.by).toBe(1);
    c.close();
  }, 25000);
});

describe('discord activities', () => {
  test('players in the same instance land in the same battle', async () => {
    const a = await TestClient.connect();
    const b = await TestClient.connect();
    const instanceId = `inst-${Math.random().toString(36).slice(2)}`;

    a.send({ t: 'hello', name: 'One', discord: { instanceId } });
    const roomA = await a.next('room', 6000, (m) => !!m.info);
    b.send({ t: 'hello', name: 'Two', discord: { instanceId } });
    const roomB = await b.next('room', 6000, (m) => (m.info?.players.filter((p) => p.uid).length ?? 0) === 2);

    expect(roomA.info!.code).toBe(roomB.info!.code);
    expect(roomB.info!.players.filter((p) => p.uid).length).toBe(2);
    a.close();
    b.close();
  }, 15000);
});
