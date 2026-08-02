import { file } from 'bun';
import type { ServerWebSocket } from 'bun';
import { join, normalize } from 'node:path';
import type { ClientMsg, ServerMsg, Side } from '../shared/types.ts';
import { applyShop, Lobby, Room, type Client } from './rooms.ts';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(import.meta.dir, '../../public');
const lobby = new Lobby();

interface Socket {
  client: Client;
}

let nextClientId = 1;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

/**
 * Discord serves activities behind `/.proxy/…`; depending on the URL mapping
 * the prefix may or may not survive. Strip it so both shapes work.
 */
function normalisePath(pathname: string): string {
  let p = pathname;
  if (p.startsWith('/.proxy/')) p = p.slice('/.proxy'.length);
  else if (p === '/.proxy') p = '/';
  if (p === '/' || p === '') p = '/index.html';
  return normalize(p).replace(/^(\.\.[/\\])+/, '');
}

const server = Bun.serve<Socket>({
  port: PORT,
  idleTimeout: 120,

  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = normalisePath(url.pathname);

    if (path === '/ws') {
      const ok = srv.upgrade(req, {
        data: {
          client: {
            id: nextClientId++,
            uid: '',
            name: '',
            room: null,
            side: -1,
            send() {},
          } as Client,
        },
      });
      return ok ? undefined : new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    if (path === '/health') {
      return Response.json({
        ok: true,
        rooms: lobby.rooms.size,
        clients: srv.pendingWebSockets,
        uptime: Math.round(process.uptime()),
      });
    }

    // Discord's client calls this to exchange an OAuth code for a token.
    if (path === '/api/token' && req.method === 'POST') {
      return handleTokenExchange(req);
    }

    const asset = file(join(PUBLIC_DIR, path));
    if (await asset.exists()) {
      const ext = path.slice(path.lastIndexOf('.'));
      return new Response(asset, {
        headers: {
          'content-type': MIME[ext] ?? asset.type ?? 'application/octet-stream',
          'cache-control': path === '/index.html' ? 'no-cache' : 'public, max-age=300',
        },
      });
    }

    // Single page app: unknown routes fall back to the shell.
    const shell = file(join(PUBLIC_DIR, 'index.html'));
    if (await shell.exists()) {
      return new Response(shell, { headers: { 'content-type': MIME['.html']!, 'cache-control': 'no-cache' } });
    }
    return new Response('Run `bun run build:client` first.', { status: 404 });
  },

  websocket: {
    open(ws) {
      const client = ws.data.client;
      client.send = (msg: ServerMsg) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* socket already gone */
        }
      };
    },

    message(ws, raw) {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        handle(ws, msg);
      } catch (err) {
        console.error('handler failed', msg.t, err);
        ws.data.client.send({ t: 'error', text: 'Something went wrong handling that.' });
      }
    },

    close(ws) {
      const client = ws.data.client;
      const room = client.room;
      if (!room) return;
      const side = client.side;
      room.detach(client);
      if (room.match && room.match.state.phase === 'playing' && side !== -1) {
        room.broadcast({ t: 'toast', kind: 'warn', text: `${client.name} lost connection.` });
      }
      room.sendRoom();
      if (room.everyone.length === 0 && !room.match) lobby.remove(room);
    },
  },
});

function handle(ws: ServerWebSocket<Socket>, msg: ClientMsg): void {
  const client = ws.data.client;

  switch (msg.t) {
    case 'hello': {
      client.uid = sanitiseUid(msg.uid) || randomUid();
      client.name = sanitiseName(msg.name);
      client.discordInstance = msg.discord?.instanceId;
      client.send({ t: 'welcome', uid: client.uid, name: client.name });
      // A refresh or a dropped connection puts you straight back in your seat.
      const seated = lobby.findSeat(client.uid);
      if (seated) {
        joinRoom(client, seated);
      } else if (msg.discord?.instanceId) {
        // Everyone in the same Discord activity lands in the same battle.
        joinRoom(client, lobby.forInstance(msg.discord.instanceId));
      } else {
        client.send({ t: 'room', info: null });
      }
      return;
    }

    case 'create': {
      leaveRoom(client);
      const room = lobby.create(msg.mode, client.discordInstance);
      if (msg.mode === 'practice') room.difficulty = clampDifficulty(msg.difficulty);
      joinRoom(client, room);
      if (msg.mode === 'practice') room.start();
      return;
    }

    case 'join': {
      const room = lobby.get(msg.code ?? '');
      if (!room) {
        client.send({ t: 'error', text: `No battle found with code ${String(msg.code).toUpperCase()}.` });
        return;
      }
      leaveRoom(client);
      joinRoom(client, room);
      return;
    }

    case 'quick': {
      leaveRoom(client);
      const room = lobby.findOpen() ?? lobby.create('versus');
      joinRoom(client, room);
      return;
    }

    case 'leave': {
      leaveRoom(client);
      client.send({ t: 'room', info: null });
      return;
    }

    case 'ready': {
      const room = client.room;
      if (!room || client.side === -1) return;
      room.ready[client.side] = !!msg.value;
      room.sendRoom();
      if (room.canStart()) room.start();
      return;
    }

    case 'buyAmmo':
    case 'buyCannon':
    case 'buyUpgrade':
    case 'build': {
      const room = client.room;
      if (!room || client.side === -1) return;
      const out = applyShop(room, client.side, msg);
      if (out.error) {
        client.send({ t: 'error', text: out.error });
      } else {
        if (out.note) client.send({ t: 'toast', kind: 'good', text: out.note });
        room.pushState();
      }
      return;
    }

    case 'aim': {
      const room = client.room;
      if (!room || client.side === -1 || !room.match) return;
      if (room.match.state.turn !== client.side) return;
      // Let the other side watch the barrel move — it builds tension.
      for (const c of room.everyone) {
        if (c !== client) {
          c.send({
            t: 'aim',
            side: client.side,
            cannonId: msg.cannonId,
            elevation: msg.elevation,
            power: msg.power,
            ammo: msg.ammo,
          });
        }
      }
      return;
    }

    case 'fire': {
      const room = client.room;
      if (!room || client.side === -1) return;
      const error = room.handleFire(client.side, msg);
      if (error) client.send({ t: 'error', text: error });
      return;
    }

    case 'endTurn': {
      const room = client.room;
      if (!room || client.side === -1) return;
      room.endTurn(client.side);
      return;
    }

    case 'chat': {
      const room = client.room;
      if (!room) return;
      const text = String(msg.text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240).trim();
      if (!text) return;
      room.broadcast({ t: 'chat', from: client.name, side: client.side, text, at: Date.now() });
      return;
    }

    case 'emote': {
      const room = client.room;
      if (!room || client.side === -1) return;
      room.broadcast({ t: 'emote', side: client.side, icon: String(msg.icon ?? '👋').slice(0, 4) });
      return;
    }

    case 'resign': {
      const room = client.room;
      if (!room || client.side === -1) return;
      room.broadcast({ t: 'toast', kind: 'warn', text: `${client.name} struck the colours.` });
      room.forfeit(client.side);
      return;
    }

    case 'rematch': {
      const room = client.room;
      if (!room || !room.match || room.match.state.phase !== 'over') return;
      room.rematchVotes.add(client.uid);
      room.sendRoom();
      const needed = room.mode === 'practice' ? 1 : 2;
      const seated = room.seats.filter(Boolean).length;
      if (room.rematchVotes.size >= Math.min(needed, seated || 1)) {
        room.start();
      }
      return;
    }

    case 'ping': {
      client.send({ t: 'pong', at: msg.at });
      return;
    }
  }
}

function joinRoom(client: Client, room: Room): void {
  room.seat(client);
  room.touch();
  room.sendRoom();
  if (room.match) {
    client.send({ t: 'match', state: room.match.snapshot(true), you: client.side });
  }
  room.broadcast({
    t: 'toast',
    kind: 'info',
    text: client.side === -1 ? `${client.name} is watching.` : `${client.name} joined.`,
  });
}

function leaveRoom(client: Client): void {
  const room = client.room;
  if (!room) return;
  const side = client.side;
  room.detach(client);
  if (side !== -1 && room.match && room.match.state.phase === 'playing' && room.mode === 'versus') {
    room.forfeit(side);
  }
  room.sendRoom();
  if (room.everyone.length === 0) lobby.remove(room);
}

// ---------------------------------------------------------------------------
// Discord OAuth token exchange (only needed when running as an Activity)
// ---------------------------------------------------------------------------

async function handleTokenExchange(req: Request): Promise<Response> {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return Response.json({ error: 'Discord credentials are not configured on this server.' }, { status: 501 });
  }
  let body: { code?: string };
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!body.code) return Response.json({ error: 'Missing code' }, { status: 400 });

  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: body.code,
    }),
  });
  if (!res.ok) {
    return Response.json({ error: 'Discord rejected the code' }, { status: 502 });
  }
  const data = (await res.json()) as { access_token?: string };
  return Response.json({ access_token: data.access_token });
}

// ---------------------------------------------------------------------------

function sanitiseName(name: unknown): string {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 20);
  return s || `Gunner ${Math.floor(Math.random() * 900 + 100)}`;
}

function sanitiseUid(uid: unknown): string {
  const s = String(uid ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return s;
}

function randomUid(): string {
  return `u${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function clampDifficulty(d: unknown): 0 | 1 | 2 {
  const n = Number(d);
  return (n === 0 || n === 2 ? n : 1) as 0 | 1 | 2;
}

setInterval(() => {
  for (const room of lobby.rooms.values()) room.tick();
  lobby.sweep();
}, 1000);

console.log(`⚔  Kannonuh listening on http://localhost:${server.port}`);

export type { Side };
