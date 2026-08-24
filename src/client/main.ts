import {
  AMMO,
  BUILDS,
  CANNONS,
  TICK_HZ,
  WORLD_H,
  WORLD_W,
  type AmmoId,
  type BuildId,
  type CannonId,
  type UpgradeId,
} from '../shared/constants.ts';
import { applyCrater, surfaceAt } from '../shared/terrain.ts';
import type {
  ClientMsg,
  Entity,
  GameSummary,
  MatchSnapshot,
  RoomInfo,
  ServerMsg,
  ShotResult,
  Side,
} from '../shared/types.ts';
import { canBuildAt, dropPoint, facing } from '../shared/world.ts';
import { sound } from './audio.ts';
import { initDiscord, type DiscordContext } from './discord.ts';
import {
  camBounds,
  camFit,
  camLookAt,
  camSnap,
  clamp,
  Fx,
  makeCamera,
  screenToWorld,
  shake,
  worldToScreen,
} from './fx.ts';
import { LocalGame } from './local.ts';
import { Net } from './net.ts';
import { Renderer, type Ghost, type LiveProjectile, type Scene } from './render.ts';
import { Ui, type ViewModel } from './ui.ts';

interface Replay {
  result: ShotResult;
  after: MatchSnapshot;
  t: number;
  ev: number;
  linger: number;
  slow: number;
  whistling: boolean;
}

interface PlacingIntent {
  kind: 'cannon' | 'build';
  cannon?: CannonId;
  build?: BuildId;
  w: number;
  h: number;
  label: string;
}

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const cam = makeCamera();
const fx = new Fx();
const renderer = new Renderer(canvas, cam, fx);

const app = {
  uid: localStorage.getItem('kannonuh.uid') ?? '',
  name: localStorage.getItem('kannonuh.name') ?? '',
  discord: null as DiscordContext | null,
  room: null as RoomInfo | null,
  state: null as MatchSnapshot | null,
  hotseat: false,
  terrain: new Array<number>(WORLD_W / 5).fill(WORLD_H * 0.7),
  you: -1 as Side | -1,
  selected: 0,
  aim: { elevation: 45, power: 62, ammo: 'round' as AmmoId },
  replay: null as Replay | null,
  ghosts: [] as Ghost[],
  placing: null as PlacingIntent | null,
  hover: null as { x: number; y: number } | null,
  time: 0,
  lastAimSent: 0,
  displayY: new Map<number, number>(),
};

const ui = new Ui({
  practice: (difficulty) => {
    sound.unlock();
    startLocal('practice', difficulty as 0 | 1 | 2);
  },
  hotseat: () => {
    sound.unlock();
    startLocal('hotseat');
  },
  create: () => {
    sound.unlock();
    onlineIntent = true;
    net.send({ t: 'create', mode: 'versus' });
  },
  quick: () => {
    sound.unlock();
    onlineIntent = true;
    net.send({ t: 'quick' });
  },
  join: (code) => {
    sound.unlock();
    onlineIntent = true;
    net.send({ t: 'join', code });
  },
  ready: (value) => send({ t: 'ready', value }),
  leave: () => {
    const wasLocal = stopLocal();
    if (!wasLocal) net.send({ t: 'leave' });
    app.state = null;
    app.room = null;
    app.you = -1;
    app.hotseat = false;
    fx.clear();
    ui.showMenu();
  },
  handoffReady: () => {
    sound.unlock();
    focusOwnGun();
    sync();
  },
  selectGun: (id) => {
    app.selected = id;
    sound.click();
    const gun = entity(id);
    if (gun) {
      app.aim.elevation = clampElevation(gun, gun.elevation ?? 45);
      app.aim.power = gun.power ?? app.aim.power;
      camLookAt(cam, gun.x, gun.y - 90, Math.max(cam.tzoom, zoomFor(0.62)));
    }
    sync();
  },
  aim: (elevation, power) => {
    const gun = entity(app.selected);
    app.aim.elevation = gun ? clampElevation(gun, elevation) : elevation;
    app.aim.power = clamp(power, 5, 100);
    pushAim();
    sync();
  },
  chooseAmmo: (ammo) => {
    const player = app.you === -1 ? null : app.state?.players[app.you];
    if (AMMO[ammo].cost > 0 && (player?.ammo[ammo] ?? 0) <= 0) {
      sound.deny();
      ui.toast('warn', `No ${AMMO[ammo].name} in the magazine — buy some from the Quartermaster.`);
      return;
    }
    app.aim.ammo = ammo;
    sound.click();
    sync();
  },
  fire: () => doFire(),
  endTurn: () => {
    send({ t: 'endTurn' });
    sound.click();
  },
  buyAmmo: (ammo) => send({ t: 'buyAmmo', ammo }),
  buyCannon: (cannon) => startPlacing({ kind: 'cannon', cannon, ...cannonBox(cannon), label: `Place your ${CANNONS[cannon].name}` }),
  buyUpgrade: (cannonId, upgrade) => send({ t: 'buyUpgrade', cannonId, upgrade: upgrade as UpgradeId }),
  build: (build) => {
    if (build === 'repair') {
      send({ t: 'build', build, x: 0, y: 0 });
      return;
    }
    startPlacing({ kind: 'build', build, ...buildBox(build), label: `Place your ${BUILDS[build].name}` });
  },
  cancelPlacing: () => {
    app.placing = null;
    ui.hidePlacing();
  },
  chat: (text) => send({ t: 'chat', text }),
  emote: (icon) => send({ t: 'emote', icon }),
  rematch: () => send({ t: 'rematch' }),
  resign: () => send({ t: 'resign' }),
  toggleSound: () => {
    sound.unlock();
    sound.setEnabled(!sound.enabled);
    return sound.enabled;
  },
  toggleMusic: () => {
    sound.unlock();
    sound.setMusic(!sound.musicOn);
    return sound.musicOn;
  },
  fit: () => fitField(),
  nameChanged: (name) => {
    app.name = name;
    net.hello = helloMsg();
    // Tell the server straight away so the lobby shows the right name.
    net.send(net.hello);
  },
});

// Only nag about a dropped connection once the player has actually tried to
// play online — otherwise a server-less deploy (e.g. GitHub Pages) shows a
// permanent "Reconnecting…" banner for a socket nobody asked for.
let onlineIntent = false;
const net = new Net(onMessage, (up) => {
  if (onlineIntent) ui.connection(up);
});

let localGame: LocalGame | null = null;

/** Routes an action to whichever transport is live: the local engine, or the network. */
function send(msg: ClientMsg): void {
  if (localGame) localGame.send(msg);
  else net.send(msg);
}

function startLocal(mode: 'practice' | 'hotseat', difficulty: 0 | 1 | 2 = 1): void {
  localGame?.destroy();
  app.hotseat = mode === 'hotseat';
  localGame = new LocalGame(mode, difficulty, app.name || ui.playerName, onMessage);
}

/** Tears down a running local game, if any. Returns whether one was running. */
function stopLocal(): boolean {
  if (!localGame) return false;
  localGame.destroy();
  localGame = null;
  return true;
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      // Only a real server ever sends this — safe to start caring about connection drops.
      onlineIntent = true;
      app.uid = msg.uid;
      localStorage.setItem('kannonuh.uid', msg.uid);
      app.name = msg.name;
      net.hello = helloMsg();
      break;

    case 'room':
      app.room = msg.info;
      if (!msg.info) {
        ui.showMenu();
      } else if (msg.info.phase === 'lobby') {
        ui.showLobby(msg.info, app.you);
      } else if (msg.info.phase === 'over') {
        ui.overVotes(msg.info);
      }
      break;

    case 'match': {
      app.you = msg.you;
      applyState(msg.state, true);
      app.ghosts = [];
      app.displayY.clear();
      fx.clear();
      ui.showHud();
      measureHud();
      const mine = myGuns();
      app.selected = mine[0]?.id ?? 0;
      if (mine[0]) {
        app.aim.elevation = clampElevation(mine[0], 45);
        app.aim.power = 62;
      }
      fitField();
      camSnap(cam);
      setTimeout(() => {
        if (app.state?.turn === app.you) focusOwnGun();
      }, 700);
      ui.banner('To arms!', 1500);
      sound.setWind(msg.state.world.wind);
      break;
    }

    case 'state':
      applyState(msg.state);
      break;

    case 'shot':
      startReplay(msg.result, msg.state);
      break;

    case 'aim':
      if (msg.side !== app.you) {
        const gun = entity(msg.cannonId);
        if (gun) {
          gun.elevation = msg.elevation;
          gun.power = msg.power;
          if (!app.replay) camLookAt(cam, gun.x, gun.y - 60, Math.max(cam.tzoom, zoomFor(0.55)));
        }
      }
      break;

    case 'chat':
      ui.chatLine(msg.from, msg.side, msg.text);
      break;

    case 'emote': {
      const king = app.state?.world.entities.find((e) => e.kind === 'king' && e.owner === msg.side);
      const at = king ? worldToScreen(cam, king.x, king.y - 70) : { x: cam.w / 2, y: cam.h / 2 };
      ui.emotePop(msg.icon, at.x, at.y);
      break;
    }

    case 'over':
      applyState(msg.state);
      pendingOver = msg.summary;
      if (!app.replay) showOver();
      break;

    case 'toast':
      ui.toast(msg.kind, msg.text);
      break;

    case 'error':
      ui.toast('warn', msg.text);
      sound.deny();
      break;

    case 'pong':
      break;
  }
}

let pendingOver: GameSummary | null = null;

function showOver(): void {
  if (!pendingOver || !app.state) return;
  const summary = pendingOver;
  pendingOver = null;
  const won = summary.winner === app.you;
  ui.banner(app.you === -1 ? 'The king has fallen' : won ? 'VICTORY' : 'DEFEAT', 2600);
  sound.fanfare(won);
  setTimeout(() => ui.showOver(summary, app.you, app.state!.world.entities), 2200);
  const king = app.state.world.entities.find(
    (e) => e.kind === 'king' && e.owner === (summary.winner === 0 ? 1 : 0),
  );
  if (king) camLookAt(cam, king.x, king.y - 40, zoomFor(1.1));
}

function applyState(state: MatchSnapshot, full = false): void {
  const before = app.state;
  app.state = state;
  // Hot-seat has no fixed "you" — control follows whoever's turn it is.
  if (app.hotseat) app.you = state.turn;
  if (state.world.terrain) {
    app.terrain = state.world.terrain.slice();
    camBounds(cam, app.terrain);
  }
  if (full) app.displayY.clear();
  if (before && before.turn !== state.turn && state.phase === 'playing') {
    onTurnChanged(state);
  }
  if (!myGuns().some((g) => g.id === app.selected)) {
    const next = myGuns().find((g) => !g.firedThisTurn) ?? myGuns()[0];
    if (next) app.selected = next.id;
  }
  sound.setWind(state.world.wind);
  sync();
}

function onTurnChanged(state: MatchSnapshot): void {
  const gun = myGuns().find((g) => !g.firedThisTurn);
  if (gun) {
    app.selected = gun.id;
    app.aim.elevation = clampElevation(gun, app.aim.elevation);
  }
  if (app.hotseat) {
    // Cover the field before revealing the next gunner's battery.
    ui.showHandoff(state.players[state.turn].name, state.turn);
    return;
  }
  if (state.turn === app.you) {
    ui.banner('Your volley', 1200);
    if (gun) focusOwnGun();
  }
}

function sync(): void {
  ui.update(viewModel());
}

function viewModel(): ViewModel {
  return {
    state: app.state,
    you: app.you,
    selected: app.selected,
    aim: app.aim,
    busy: !!app.replay,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function helloMsg() {
  return {
    t: 'hello' as const,
    name: app.name || ui.playerName,
    uid: app.uid || undefined,
    discord: app.discord
      ? { instanceId: app.discord.instanceId, userId: app.discord.userId, channel: app.discord.channelId }
      : undefined,
  };
}

function entity(id: number): Entity | undefined {
  return app.state?.world.entities.find((e) => e.id === id);
}

function myGuns(): Entity[] {
  if (!app.state || app.you === -1) return [];
  return app.state.world.entities.filter((e) => e.kind === 'cannon' && e.owner === app.you);
}

function clampElevation(gun: Entity, elevation: number): number {
  const def = CANNONS[gun.cannon ?? 'field'];
  return clamp(elevation, def.minElevation, def.maxElevation);
}

function cannonBox(id: CannonId): { w: number; h: number } {
  return { w: CANNONS[id].width, h: CANNONS[id].height };
}

function buildBox(id: BuildId): { w: number; h: number } {
  return id === 'wall' ? { w: 30, h: 30 } : id === 'timber' ? { w: 56, h: 26 } : { w: 22, h: 32 };
}

/** Small screens see less world, so the same "zoom level" needs a smaller scale. */
function zoomFor(base: number): number {
  // Tie the close-up scale to the height of the free area, not the width — a
  // phone in portrait should still get a usable view of its own battery.
  return base * clamp(Math.max(220, cam.h - cam.padTop - cam.padBottom) / 620, 0.72, 1.3);
}

function fitField(): void {
  if (!app.state) return;
  camBounds(cam, app.terrain);
  const b = cam.bounds;
  camFit(cam, b.x0 + 30, b.x1 - 30, b.y1 - 420, b.y1, 20);
}

function focusOwnGun(): void {
  const gun = entity(app.selected) ?? myGuns()[0];
  if (!gun) return;
  camLookAt(cam, gun.x + facing(app.you === 1 ? 1 : 0) * 160, gun.y - 110, zoomFor(0.66));
}

function pushAim(): void {
  const now = performance.now();
  if (now - app.lastAimSent < 90) return;
  app.lastAimSent = now;
  if (app.you === -1 || !app.state || app.state.turn !== app.you) return;
  send({
    t: 'aim',
    cannonId: app.selected,
    elevation: app.aim.elevation,
    power: app.aim.power,
    ammo: app.aim.ammo,
  });
}

function doFire(): void {
  if (!app.state || app.you === -1 || app.replay) return;
  if (app.state.turn !== app.you || app.state.phase !== 'playing') return;
  const gun = entity(app.selected);
  if (!gun || gun.firedThisTurn) {
    const next = myGuns().find((g) => !g.firedThisTurn);
    if (!next) {
      ui.toast('warn', 'Every gun has fired. End the volley.');
      sound.deny();
      return;
    }
    app.selected = next.id;
  }
  send({
    t: 'fire',
    cannonId: app.selected,
    elevation: app.aim.elevation,
    power: app.aim.power,
    ammo: app.aim.ammo,
  });
}

function startPlacing(intent: PlacingIntent): void {
  app.placing = intent;
  ui.closeShop();
  ui.showPlacing(intent.label);
  ui.toast('info', 'Click on your half of the field to place it.');
}

function confirmPlacing(worldX: number): void {
  const intent = app.placing;
  if (!intent || app.you === -1) return;
  if (!canBuildAt(app.you, worldX)) {
    ui.toast('warn', 'That is not your half of the field.');
    sound.deny();
    return;
  }
  if (intent.kind === 'cannon') send({ t: 'buyCannon', cannon: intent.cannon!, x: worldX });
  else send({ t: 'build', build: intent.build!, x: worldX, y: 0 });
  app.placing = null;
  ui.hidePlacing();
  sound.coin();
}

// ---------------------------------------------------------------------------
// Shot replay
// ---------------------------------------------------------------------------

function startReplay(result: ShotResult, after: MatchSnapshot): void {
  app.replay = { result, after, t: 0, ev: 0, linger: 1.1, slow: 0, whistling: false };
  sync();
  const gun = entity(result.cannonId);
  if (gun) camLookAt(cam, gun.x, gun.y - 80, zoomFor(0.72));
}

function updateReplay(dt: number): void {
  const r = app.replay;
  if (!r) return;
  const speed = r.slow > 0 ? 0.32 : 1;
  r.slow = Math.max(0, r.slow - dt);
  r.t += dt * TICK_HZ * speed;

  const events = r.result.events;
  while (r.ev < events.length && events[r.ev]!.t <= r.t) {
    handleEvent(events[r.ev]!);
    r.ev++;
  }

  // Live projectiles for this instant.
  const live: LiveProjectile[] = [];
  let lead: { x: number; y: number; speed: number } | null = null;
  for (const track of r.result.tracks) {
    const idx = Math.floor(r.t - track.birth);
    const count = track.pts.length / 2;
    if (idx < 0 || idx >= count) continue;
    const x = track.pts[idx * 2]!;
    const y = track.pts[idx * 2 + 1]!;
    const trail: { x: number; y: number }[] = [];
    for (let i = Math.max(0, idx - 16); i <= idx; i++) {
      trail.push({ x: track.pts[i * 2]!, y: track.pts[i * 2 + 1]! });
    }
    live.push({ x, y, ammo: track.ammo, trail });
    const prev = Math.max(0, idx - 1);
    const vx = x - track.pts[prev * 2]!;
    const vy = y - track.pts[prev * 2 + 1]!;
    const sp = Math.hypot(vx, vy) * TICK_HZ;
    if (!lead || sp > lead.speed) lead = { x, y, speed: sp };
    if (AMMO[track.ammo].incendiary || track.ammo === 'fire') fx.ember(x, y, 1);
    if (idx % 2 === 0) fx.trailPuff(x, y, AMMO[track.ammo].blast > 0 ? '#d8c6b0' : '#cdc6ba');
  }
  liveProjectiles = live;

  if (lead) {
    camLookAt(cam, lead.x + Math.sign(lead.x - cam.x) * 40, lead.y - 40, cameraZoomFor(lead.speed));
    if (r.whistling) sound.whistleUpdate(clamp(lead.speed / 1400, 0, 1));
  } else if (r.whistling) {
    sound.whistleStop();
    r.whistling = false;
  }

  if (r.t > r.result.ticks && live.length === 0) {
    r.linger -= dt;
    if (r.linger <= 0) finishReplay();
  }
}

function cameraZoomFor(speed: number): number {
  return zoomFor(clamp(0.86 - speed / 4200, 0.45, 0.8));
}

function finishReplay(): void {
  const r = app.replay;
  if (!r) return;
  app.replay = null;
  if (r.whistling) sound.whistleStop();
  liveProjectiles = [];
  // Keep the trail on screen as a ranging aid.
  const main = r.result.tracks[0];
  if (main && main.pts.length > 4) {
    app.ghosts.push({ side: r.result.by, pts: main.pts });
    const mine = app.ghosts.filter((g) => g.side === r.result.by);
    while (mine.length > 2) {
      const drop = app.ghosts.indexOf(mine.shift()!);
      if (drop >= 0) app.ghosts.splice(drop, 1);
    }
  }
  applyState(r.after);
  if (pendingOver) {
    showOver();
  } else if (app.state && app.state.turn === app.you && app.state.phase === 'playing') {
    focusOwnGun();
  }
}

function handleEvent(ev: ShotResult['events'][number]): void {
  switch (ev.k) {
    case 'muzzle': {
      const dx = Math.cos(ev.a);
      const dy = Math.sin(ev.a);
      fx.muzzleSmoke(ev.x, ev.y, dx, dy);
      shake(cam, 5 + ev.power * 0.06);
      sound.cannon(ev.power / 100);
      if (app.replay && !app.replay.whistling) {
        sound.whistleStart();
        app.replay.whistling = true;
      }
      break;
    }
    case 'boom':
      fx.explosion(ev.x, ev.y, ev.r, ev.kind);
      shake(cam, 8 + ev.r * 0.14);
      sound.explode(clamp(ev.r / 130, 0.2, 1));
      break;
    case 'crater':
      applyCrater(app.terrain, ev.x, ev.y, ev.r);
      camBounds(cam, app.terrain);
      fx.dust(ev.x, ev.y, 5);
      break;
    case 'hit':
      if (ev.dmg >= 4) {
        fx.text(ev.x, ev.y - 12, `-${ev.dmg}`, ev.mat === 'flesh' ? '#ff9a9a' : '#ffe6ad', 16);
      }
      fx.debris(ev.x, ev.y, 4 + Math.min(10, ev.dmg / 6), matColour(ev.mat), ev.y + 40);
      sound.impact(ev.mat, clamp(ev.dmg / 60, 0.2, 1));
      break;
    case 'thud':
      fx.dust(ev.x, ev.y, 6);
      sound.impact('earth', 0.4);
      shake(cam, 3);
      break;
    case 'bounce':
      fx.dust(ev.x, ev.y, 4);
      sound.ricochet();
      break;
    case 'split':
      fx.explosion(ev.x, ev.y, 26, 'shell');
      sound.impact('metal', 0.5);
      break;
    case 'gone': {
      const e = entity(ev.id);
      fx.debris(ev.x, ev.y, 16, matColour(ev.mat), ev.y + (e ? e.h : 20));
      fx.smoke(ev.x, ev.y, 5, 14);
      sound.crumble();
      shake(cam, 6);
      break;
    }
    case 'ignite': {
      const e = entity(ev.id);
      if (e) {
        e.burning = 3;
        fx.ember(e.x, e.y, 8);
      }
      break;
    }
    case 'king':
      fx.text(ev.x, ev.y - 40, `THE KING! -${ev.dmg}`, '#ffd76a', 22);
      shake(cam, 22);
      sound.kingHit();
      if (app.replay) app.replay.slow = 0.85;
      camLookAt(cam, ev.x, ev.y - 30, zoomFor(1.05));
      break;
  }
}

function matColour(mat: string): string {
  switch (mat) {
    case 'stone':
      return '#8d8171';
    case 'wood':
      return '#6b4a2a';
    case 'metal':
      return '#5b5b64';
    case 'flesh':
      return '#a8443c';
    case 'powder':
      return '#3d2a14';
    default:
      return '#6a563c';
  }
}

let liveProjectiles: LiveProjectile[] = [];

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

type Drag = { mode: 'aim' | 'pan'; id: number; sx: number; sy: number; camX: number; camY: number };
let drag: Drag | null = null;
const touches = new Map<number, { x: number; y: number }>();
let pinchStart = 0;
let pinchZoom = 1;

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock();
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinchStart = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    pinchZoom = cam.tzoom;
    drag = null;
    return;
  }

  const world = screenToWorld(cam, e.clientX, e.clientY);

  if (app.placing) {
    confirmPlacing(world.x);
    return;
  }

  // Tapping one of your guns selects it.
  const gun = myGuns().find(
    (g) => Math.abs(g.x - world.x) < g.w * 0.8 && Math.abs(g.y - world.y) < g.h * 1.3,
  );
  if (gun && gun.id !== app.selected) {
    ui.hooks.selectGun(gun.id);
    return;
  }

  const selected = entity(app.selected);
  const canAim = selected && app.state?.turn === app.you && !app.replay && app.state?.phase === 'playing';
  if (canAim && e.button !== 2) {
    const s = worldToScreen(cam, selected!.x, selected!.y);
    if (Math.hypot(s.x - e.clientX, s.y - e.clientY) < 150) {
      drag = { mode: 'aim', id: e.pointerId, sx: e.clientX, sy: e.clientY, camX: cam.x, camY: cam.y };
      return;
    }
  }
  drag = { mode: 'pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, camX: cam.tx, camY: cam.ty };
});

canvas.addEventListener('pointermove', (e) => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (touches.size === 2 && pinchStart > 0) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    cam.tzoom = clamp((pinchZoom * d) / pinchStart, 0.22, 1.9);
    return;
  }

  if (app.placing) {
    const world = screenToWorld(cam, e.clientX, e.clientY);
    app.hover = { x: world.x, y: world.y };
    return;
  }

  if (!drag || drag.id !== e.pointerId) return;

  if (drag.mode === 'pan') {
    cam.tx = drag.camX - (e.clientX - drag.sx) / cam.zoom;
    cam.ty = drag.camY - (e.clientY - drag.sy) / cam.zoom;
    return;
  }

  const gun = entity(app.selected);
  if (!gun) return;
  const s = worldToScreen(cam, gun.x, gun.y);
  // Slingshot: pull away from the gun, the shot goes the other way.
  const px = s.x - e.clientX;
  const py = s.y - e.clientY;
  const dir = facing((gun.owner === 1 ? 1 : 0) as Side);
  const elevation = (Math.atan2(-py, Math.max(1, Math.abs(px)) * (px * dir > 0 ? 1 : -1)) * 180) / Math.PI;
  app.aim.elevation = clampElevation(gun, clamp(px * dir > 0 ? elevation : 89, 0, 89));
  app.aim.power = clamp(Math.hypot(px, py) / 2.4, 5, 100);
  pushAim();
  sync();
});

function endPointer(e: PointerEvent): void {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinchStart = 0;
  if (drag && drag.id === e.pointerId) drag = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0016);
    cam.tzoom = clamp(cam.tzoom * factor, 0.22, 1.9);
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const step = e.shiftKey ? 0.2 : 1;
  const gun = entity(app.selected);
  switch (e.key) {
    case ' ':
      e.preventDefault();
      doFire();
      break;
    case 'ArrowUp':
      e.preventDefault();
      ui.hooks.aim(app.aim.elevation + step, app.aim.power);
      break;
    case 'ArrowDown':
      e.preventDefault();
      ui.hooks.aim(app.aim.elevation - step, app.aim.power);
      break;
    case 'ArrowRight':
      e.preventDefault();
      ui.hooks.aim(app.aim.elevation, app.aim.power + step);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      ui.hooks.aim(app.aim.elevation, app.aim.power - step);
      break;
    case 'Tab': {
      e.preventDefault();
      const guns = myGuns();
      if (guns.length) {
        const i = guns.findIndex((g) => g.id === app.selected);
        ui.hooks.selectGun(guns[(i + 1) % guns.length]!.id);
      }
      break;
    }
    case 'b':
    case 'B':
      ui.openShop();
      sync();
      break;
    case 'e':
    case 'E':
      ui.hooks.endTurn();
      break;
    case 'f':
    case 'F':
      fitField();
      break;
    case 'Escape':
      if (app.placing) ui.hooks.cancelPlacing();
      else ui.closeShop();
      break;
    default:
      if (/^[1-6]$/.test(e.key)) {
        const order: AmmoId[] = ['round', 'shell', 'grape', 'chain', 'fire', 'mortar'];
        ui.hooks.chooseAmmo(order[Number(e.key) - 1]!);
      }
      break;
  }
  void gun;
});

function measureHud(): void {
  const top = document.querySelector<HTMLElement>('.topbar');
  const bottom = document.querySelector<HTMLElement>('.controls');
  const hidden = document.getElementById('hud')?.classList.contains('hidden');
  cam.padTop = hidden ? 0 : (top?.offsetHeight ?? 0);
  cam.padBottom = hidden ? 0 : (bottom?.offsetHeight ?? 0);
}

window.addEventListener('resize', () => {
  renderer.resize();
  measureHud();
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let last = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  app.time += dt;

  updateReplay(dt);
  fx.update(dt);
  emberTick(dt);

  if (app.state) {
    ui.clock(app.state.deadline, app.state.phase);
    renderer.draw(buildScene(), dt);
  } else {
    renderer.draw(emptyScene(), dt);
  }
  requestAnimationFrame(frame);
}

let emberTimer = 0;
function emberTick(dt: number): void {
  emberTimer -= dt;
  if (emberTimer > 0 || !app.state) return;
  emberTimer = 0.12;
  for (const e of app.state.world.entities) {
    if (e.burning && e.burning > 0) fx.ember(e.x, e.y - e.h * 0.4, 1);
  }
}

function buildScene(): Scene {
  const state = app.state!;
  // Ease entity positions so collapsing walls slide down instead of teleporting.
  const entities = state.world.entities.map((e) => {
    const shown = app.displayY.get(e.id);
    if (shown === undefined) {
      app.displayY.set(e.id, e.y);
      return e;
    }
    if (Math.abs(shown - e.y) < 0.6) {
      app.displayY.set(e.id, e.y);
      return e;
    }
    const next = shown + (e.y - shown) * 0.22;
    app.displayY.set(e.id, next);
    return { ...e, y: next };
  });

  let placing: Scene['placing'] = null;
  if (app.placing && app.hover) {
    const box = app.placing;
    const y = dropPoint({ terrain: app.terrain, entities } as never, app.hover.x, box.w, box.h);
    placing = {
      w: box.w,
      h: box.h,
      x: app.hover.x,
      y: app.placing.kind === 'cannon' ? surfaceAt(app.terrain, app.hover.x) - box.h / 2 : y,
      ok: app.you !== -1 && canBuildAt(app.you, app.hover.x),
    };
  }

  return {
    world: state.world,
    terrain: app.terrain,
    entities,
    you: app.you,
    turn: state.turn,
    selected: app.selected,
    aim: app.state?.phase === 'playing' && !app.replay ? app.aim : null,
    aimSide: app.you,
    projectiles: liveProjectiles,
    ghosts: app.ghosts,
    time: app.time,
    placing,
  };
}

function emptyScene(): Scene {
  return {
    world: { seed: 1, entities: [], nextId: 1, wind: 0.2, timeOfDay: 0.35, theme: 0 },
    terrain: app.terrain,
    entities: [],
    you: -1,
    turn: 0,
    selected: 0,
    aim: null,
    aimSide: -1,
    projectiles: [],
    ghosts: [],
    time: app.time,
    placing: null,
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  ui.showMenu();
  requestAnimationFrame(frame);

  if (new URLSearchParams(location.search).has('debug')) {
    // Handle for automated play-throughs and screenshots.
    (window as unknown as Record<string, unknown>).__kannonuh = {
      app,
      cam,
      fx,
      ui,
      fire: doFire,
      aim: (elevation: number, power: number) => ui.hooks.aim(elevation, power),
    };
  }

  app.discord = await initDiscord().catch(() => null);
  if (app.discord) {
    if (app.discord.name) {
      app.name = app.discord.name;
      (document.getElementById('name-input') as HTMLInputElement).value = app.name;
    }
    document.getElementById('menu-quick')?.classList.add('hidden');
  }
  if (!app.name) {
    app.name = `Gunner ${Math.floor(Math.random() * 900 + 100)}`;
    (document.getElementById('name-input') as HTMLInputElement).value = app.name;
  }
  net.hello = helloMsg();
  net.connect();

  setInterval(() => net.send({ t: 'ping', at: Date.now() }), 25000);
}

void boot();
