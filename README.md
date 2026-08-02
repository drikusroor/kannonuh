# Kannonuh

A turn-based artillery siege duel for the browser. Two fortresses face each
other across a destructible landscape; you crank the elevation and the powder
charge, mind the wind, and try to blow a hole through the enemy keep before they
blow one through yours. The king dies, the battle ends.

Inspired by **Ballerberg**, dragged forward a couple of centuries into the age of
rifled bores and explosive shell.

Runs on [Bun](https://bun.sh) — WebSockets for play, canvas for rendering, and a
deterministic shared simulation so both players watch the exact same cannonball.
It also runs as a **Discord Activity**.

---

## Playing

```bash
bun install
bun run start        # builds the client, serves on http://localhost:3000
```

Then open <http://localhost:3000>.

- **Practice siege** — play the gunnery bot (three difficulties).
- **Create battle** — get a four letter code, send it to a friend.
- **Quick match** — drop into whoever is waiting.

### Controls

| Action | How |
| --- | --- |
| Aim | Drag away from your gun like a slingshot, or use the elevation / powder dials |
| Fine aim | Arrow keys (hold shift for 0.2 steps) |
| Fire | `Space` or the big red button |
| Pick a gun | Click it, or `Tab` |
| Pick ammunition | Number keys `1`–`6`, or the magazine chips |
| Quartermaster | `B` |
| End volley | `E` |
| Camera | Scroll to zoom, drag the background to pan, `F` refits the field |

### How a battle goes

Every gun in your battery may fire once per turn, up to three shots a turn. Hits
pay **credits**, and so does anything you destroy. Between shots — on your own
turn — the Quartermaster sells:

- **Ammunition.** Round shot is free and skips off shallow ground. Explosive
  shell is the workhorse; grapeshot shreds gun crews but bounces off masonry;
  chain shot tears walls apart; fire shell sets timber and powder alight for
  several turns; the mortar bomb is a very large hole in the ground.
- **Ordnance.** Field cannon, siege mortar (lobs over walls) and the long gun
  (fast, flat, deadly accurate). Each extra gun of the same type costs more.
- **Upgrades.** Powder for velocity, sights for accuracy, plating for survival,
  rifled bore for damage. Applied per gun.
- **Fortifications.** Stone blocks, timber barricades, powder barrel traps, and
  masons to repair what is left standing.

Powder barrels chain-detonate. Terrain is destructible, and masonry that loses
the ground beneath it falls — and takes damage doing so. Wind changes every turn
and shoves light shot around far more than heavy bombs.

Winning is worth a lot, but the scoreboard also rewards **accuracy** and
**speed**: every turn under par of 14 pays, and every shot that misses does not.

---

## Development

```bash
bun run dev          # build the client, then serve with --watch
bun run watch:client # rebuild the client bundle on change (run alongside)
bun test             # simulation, match rules and live protocol tests
bun run typecheck
```

Handy scripts:

```bash
bun run scripts/smoke.ts 1234      # play a whole match bot-vs-bot in the terminal
bun run scripts/screenshot.ts      # drive the real client in Chromium
bun run scripts/playthrough.ts     # play a full battle in a browser, capture stills
```

`?debug=1` on the client URL exposes `window.__kannonuh` for poking at state.

### Layout

```
src/shared/    the game itself — deterministic, used by server and client alike
  constants.ts   every tuning number: ammo, guns, upgrades, costs, scoring
  terrain.ts     destructible heightmap: generation, craters, slopes
  world.ts       entities, castle construction, settling/collapse
  sim.ts         the shot: ballistics, collisions, explosions, damage
  shop.ts        purchase rules
  scoring.ts     the after-action scoreboard
src/server/    Bun.serve HTTP + WebSocket, rooms, turn logic, the bot
src/client/    canvas renderer, procedural audio, HUD, input, Discord bridge
```

The server owns the truth. A shot is simulated once, server-side, and the result
is sent to every client as a list of per-tick projectile positions plus events
(`muzzle`, `boom`, `hit`, `gone`, `crater`, …). Clients replay that timeline —
so the animation, the sound and the damage numbers all agree, and a spectator
joining mid-battle sees exactly the same thing.

Nothing is loaded from a CDN. Every sound is synthesised with the Web Audio API
at runtime and every sprite is drawn with canvas primitives, which keeps the
bundle small and satisfies Discord's content security policy without ceremony.

---

## Running it as a Discord Activity

The game already speaks Discord's embedded-app conventions:

- All requests are made relative to the `/.proxy/` prefix Discord serves
  activities under, and the server strips that prefix if it survives.
- Everyone launching the same activity **instance** is put in the same battle
  automatically — no room code needed.
- No external asset hosts, so the CSP has nothing to block.

### Setup

1. Create an application at <https://discord.com/developers/applications>, then
   **Activities → Settings** and enable it.
2. Under **Activities → URL Mappings**, map the root `/` to the host serving this
   game (it must be HTTPS and publicly reachable — `cloudflared tunnel --url
   http://localhost:3000` is fine for testing).
3. Under **OAuth2**, note the client id and secret.
4. Build and run with the credentials in the environment:

   ```bash
   export DISCORD_CLIENT_ID=your_application_id
   export DISCORD_CLIENT_SECRET=your_client_secret
   bun run start
   ```

   `DISCORD_CLIENT_ID` is baked into the client bundle at build time;
   `DISCORD_CLIENT_SECRET` stays on the server and is only used by
   `POST /api/token` to exchange the OAuth code.
5. Launch the activity from a voice channel. Two players get the two seats,
   anyone else joining watches.

Without the credentials the activity still works — it reads `instance_id`
straight from the query string Discord provides, so players are grouped
correctly. You simply get generated gunner names instead of Discord ones.

### Deploying

Any host that runs Bun and allows WebSockets will do. `PORT` selects the port
(default 3000) and `/health` answers a JSON probe.

```bash
bun install --production
bun run build:client
PORT=8080 bun src/server/index.ts
```

---

## Notes on the simulation

- Fixed 120 Hz timestep, capped at 12 s per shot.
- Gravity 700 u/s², linear drag scaled by projectile mass, wind as a sideways
  acceleration — so a mortar bomb barely notices a gale that carries grapeshot
  away.
- Solid shot ricochets off shallow ground and punches through anything it
  shatters; explosive shells carve craters and chain into powder barrels.
- The heightmap is 520 columns wide. Craters lower it, blast debris raises the
  lip, and anything left unsupported falls on the next settle pass.
- Turn timer is 90 s (plus however long the last replay took); running out ends
  your volley. A dropped connection holds your seat for 45 s, then the battle
  goes to the player still standing.

## Roadmap

Deliberately left for later: achievements, more than two players (the protocol
is already side-indexed rather than two-player-shaped), persistent profiles and
a ladder.
