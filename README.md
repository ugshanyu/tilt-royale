# Tilt Royale

A 2–4 player, last-arrow-standing battle arena for the [Usion](https://usions.com)
platform. Tilt your phone to steer, dodge the red-dot swarm, grab weapon orbs,
and shove your rivals into the swarm — last one alive wins.

It is also a **reference implementation**: the most complete example of the
*best* way to build realtime multiplayer on Usion — a **server-authoritative
direct-mode game server** with **client prediction**, **snapshot
interpolation**, and **server-side lag compensation**, all wired through the
`@usions/sdk` netcode helpers. If you're building a fast realtime game, copy
this repo.

> **The one lesson:** *the engine renders, the server simulates.* Phaser draws
> pixels and reads input; it owns **zero** game logic. Every position,
> collision, and kill is decided by the Node server. That single boundary is
> what makes the game cheat-proof and consistent across devices — and it's the
> difference between a toy and something you can put real stakes on.

---

## Table of contents

- [How it plays](#how-it-plays)
- [Architecture](#architecture)
- [The direct-mode contract](#the-direct-mode-contract)
- [Netcode](#netcode)
- [Tilt input](#tilt-input)
- [Run it locally](#run-it-locally)
- [Deploy to Railway](#deploy-to-railway)
- [Register on Usion](#register-on-usion)
- [Match results & leaderboard](#match-results--leaderboard)
- [Project layout](#project-layout)
- [Protocol reference](#protocol-reference)

---

## How it plays

- **Steer by tilting** (keyboard on desktop). You have one life.
- **Red dots** swarm every player. One touch kills you. They arrive as a
  trickle of hunters plus scripted **formations** — sweeping walls, contracting
  rings, charging wedges, spinning pinwheels — that ramp up over a 150 s round.
- **Weapon orbs** spawn in the arena. Grab one for limited ammo of one of three
  weapons. Unarmed, you can only dodge.
  - **Shockwave** — an instant 120° arc. Clears crowds; kills rivals up close,
    knocks them back at range (into the swarm, ideally).
  - **Scatter** — a 5-pellet shotgun fan. Short-range, committed.
  - **Seeker** — 3 homing missiles that hunt the nearest rival or the densest
    dot cluster.
- **Last arrow standing wins.** Timeout → highest score. Score comes from dot
  kills (with combo multipliers), rival KOs, and survival time.

## Architecture

```
   ┌────────────┐   1. mint token    ┌──────────────────────┐
   │  Usion app │──────────────────► │   Usion backend      │
   │  (client)  │ ◄──────────────────│  POST /rooms/{id}/    │
   └─────┬──────┘   ws_url + JWT     │       access          │
         │                          │  /.well-known/jwks.json│
         │ 2. wss://…/ws?token=JWT   └──────────┬───────────┘
         ▼                                       │ 4. verify JWT (JWKS)
   ┌──────────────────────────────┐              │    signed results
   │   Tilt Royale server (Railway,│◄─────────────┘  POST /games/direct/results
   │   Singapore)                  │
   │   • verifies the RS256 token  │   3. 60 Hz authoritative sim,
   │   • runs the authoritative sim│      20 Hz snapshots  ─────────► all clients
   │   • serves the static client  │
   └──────────────────────────────┘
```

- **One Railway service** serves both the static client (the service's
  `iframe_url`) and the WebSocket at `/ws` (the service's `ws_url`) — same
  origin, one deploy.
- The Usion backend never relays gameplay. It only mints a short-lived signed
  token and receives the final result. All the realtime traffic is a direct
  client ⇄ Railway WebSocket — the lowest-latency path Usion offers.
- Hosted in **Singapore** (`asia-southeast1-eqsg3a`), Railway's only Asia
  region and the closest to Mongolia (~60–130 ms RTT).

## The direct-mode contract

Direct mode lets your own server own the realtime loop while Usion handles
identity, rooms, invites, and results. The full wire contract is in
[PROTOCOL.md](PROTOCOL.md); the essentials:

1. **Token flow.** The client calls `Usion.game.connectDirect({ roomId,
   serviceId })`. The SDK fetches `{ ws_url, access_token }` from
   `POST /games/rooms/{roomId}/access`, then opens `ws_url?token=<JWT>`.
2. **Verify on connect.** The server validates the RS256 JWT against the
   platform's JWKS (`JWKS_URL`): audience `usion-game-service:<SERVICE_ID>`,
   `permissions` must include `play`. Identity is the `sub` claim; the
   `session_id` claim is kept for the result submission. See
   [server/auth.js](server/auth.js).
3. **Talk your protocol.** After `join`, the client sends `input` frames and
   receives `state_snapshot` / `state_delta`. JSON only — the SDK's direct
   socket drops binary frames.
4. **Report the result.** When the match ends, the server POSTs an
   HMAC-SHA256-signed result to `POST {API_URL}/games/direct/results`. The
   platform records it, updates the leaderboard, and emits `game:finished` to
   the chat. See [server/webhook.js](server/webhook.js).

## Netcode

The hard part of a fast realtime game is making it feel instant on a 120 ms
link without letting clients lie. Tilt Royale uses the standard three-part
answer, each built on an `@usions/sdk` helper so you don't reinvent it:

| Technique | What it fixes | Where |
|---|---|---|
| **Client prediction** (`createPredictor`) | Your own arrow responds to input with zero delay, then reconciles against the server's authoritative position — no rubber-banding. | [client/js/game/predictor.js](client/js/game/predictor.js) |
| **Snapshot interpolation** (`createInterpolation`) | Remote players, dots, and projectiles render smoothly between the 20 Hz snapshots, with an adaptive buffer that grows under jitter. | [client/js/game/interp.js](client/js/game/interp.js) |
| **Lag compensation** (server rewind) | When you fire, the server rewinds rival positions to *when you saw them*, so hits land at high ping. | [server/game/weapons.js](server/game/weapons.js) |

Key decisions worth copying:

- **Shared physics.** [shared/movement.js](shared/movement.js) is imported
  *verbatim* by both the server sim and the client predictor. Same op order,
  same clamps, same rounding → reconciliation is silent because both sides
  compute bit-identical results.
- **60 Hz sim, 20 Hz network.** The server steps physics at 60 Hz but only
  emits state at 20 Hz — a full **keyframe** every second and compact
  **deltas** in between (each delta is diffed against the last keyframe, so one
  dropped packet never desyncs).
- **Compact snapshots.** Positions are quantized to 0.25 u ints, players are
  addressed by slot (not user-id strings), and dots ride as
  structure-of-arrays where per-dot ids are paid only on spawn. Worst case (220
  dots, 48 projectiles, 4 players) a keyframe is **~4.7 KB**, a delta **~3.9
  KB** — comfortably under the platform's 8 KB frame cap. The serializer
  asserts this ceiling. See [server/net/snapshot.js](server/net/snapshot.js)
  and [shared/wire.js](shared/wire.js).
- **When *not* to predict.** Scatter pellets are client-predicted (you fire
  from a known pose). The Seeker's homing targets depend on server-side world
  state the client can't know, so it is **deliberately not predicted** — only
  interpolated. Predicting it would guess wrong and snap.

Everything is server-authoritative: the client sends only *intent* (`mx, my,
fires[]`), clamped and rate-limited on arrival. Ammo, cooldowns, pickups,
collisions, and kills are decided server-side. A hacked client can move its own
arrow's *input* but can never teleport, claim a pickup, or forge a kill.

Turn on the in-game debug HUD with `?debug=1` to watch RTT, prediction error,
snapshot Hz/bytes, and the interpolation buffer live — and to inject latency,
jitter, and loss with `Usion.game.simulateNetwork()` (presets: **MN 4G**,
**hotel wifi**).

## Tilt input

`DeviceOrientation` drives movement on phones. iOS requires the permission
request to fire from inside a user gesture, so it's requested on the **Ready**
tap; a 300 ms calibration captures your neutral hold, and a low-pass filter
smooths sensor noise. Desktop falls back to WASD / arrow keys (ramped for an
analog feel) with Space / tap to fire. See
[client/js/input/tilt.js](client/js/input/tilt.js).

## Run it locally

```bash
npm install
npm run dev          # server + static client on http://localhost:3016
```

`npm run dev` sets `DEV_ALLOW_UNSIGNED=1` and `BOT_FILL=1`:

- **`DEV_ALLOW_UNSIGNED`** accepts local tokens of the form
  `dev:<name>:<room>` so you can play without the platform minting a real JWT.
  The server **refuses to boot** with this flag when `NODE_ENV=production` —
  it can never weaken auth in prod.
- **`BOT_FILL`** drops a server-side bot into your room after 5 s so one person
  can start a round alone.

Open two tabs to test real multiplayer:

- Tab 1: <http://localhost:3016/?player=alice&debug=1>
- Tab 2: <http://localhost:3016/?player=bob&debug=1>

Both join room `local-room` (override with `?room=`). Use the `?debug=1` chaos
panel to feel the game under latency and loss.

```bash
npm test             # deterministic sim tests + snapshot-size ceiling
```

## Deploy to Railway

```bash
railway init                       # create the project
railway up --detach                # build the Dockerfile, deploy
railway domain                     # generate a public https/wss domain
```

Pin the region to Singapore — [railway.json](railway.json) already sets
`deploy.multiRegionConfig` to `asia-southeast1-eqsg3a`; confirm it applied with
`railway status` (or set it in the dashboard under Service → Settings →
Region).

Set the production environment (never set `DEV_ALLOW_UNSIGNED`; leave
Serverless **off** so the game server never sleeps):

```bash
railway variable set SERVICE_ID=tilt-royale
railway variable set API_URL=https://mobile.mongolai.mn
railway variable set JWKS_URL=https://mobile.mongolai.mn/.well-known/jwks.json
railway variable set SIGNING_KEY_ID=tilt-royale-key-1
railway variable set SIGNING_SECRET="$(openssl rand -base64 48 | tr '+/' '-_')"
railway variable set NODE_ENV=production
```

Verify:

```bash
curl -s https://<your-domain>/health           # {"ok":true,...}
# a bad token must be rejected — proves the socket is reachable AND auth is on:
#   → {"type":"error","payload":{"code":"INVALID_TOKEN"}}
```

## Register on Usion

Register the service so it appears in Explore and works with chat game invites.
Any Usion creator can do this with a personal API token (**Service Creator →
Agent API Access → Create API token**, `usion_sk_…`):

```bash
curl -X POST https://mobile.mongolai.mn/registry/services/register \
  -H "Authorization: Bearer usion_sk_…" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Tilt Royale",
    "description": "2-4 player tilt battle royale. Tilt to dodge, grab weapons, be the last arrow standing.",
    "service_type": "game",
    "iframe_url": "https://<your-domain>",
    "cost": 0,
    "tags": ["game", "multiplayer"],
    "is_published": true,
    "max_players": 4,
    "realtime": {
      "connection_mode": "direct",
      "connection_transport": "websocket",
      "ws_url": "wss://<your-domain>/ws",
      "protocol_version": "2",
      "heartbeat_interval_ms": 15000,
      "max_payload_bytes": 8192,
      "rate_limits": { "input_per_sec": 60 },
      "signing": {
        "alg": "HMAC-SHA256",
        "key_id": "tilt-royale-key-1",
        "result_webhook_enabled": true,
        "shared_secret": "<the SIGNING_SECRET you set on Railway>"
      }
    }
  }'
```

The `signing.shared_secret` **must** match the server's `SIGNING_SECRET` — it's
how the platform verifies the result webhook. `ws_url` must be `wss://` and
`iframe_url` `https://` for a published service.

## Match results & leaderboard

When a round ends, the server builds per-player stats (score, kills, dot kills,
pickups, survival time, best combo) and POSTs a signed result to
`POST {API_URL}/games/direct/results`. The signature is
`HMAC-SHA256(SIGNING_SECRET, "timestamp\nPOST\n/games/direct/results\nsha256(body)")`
with an idempotency key so retries are safe. The platform then updates the
leaderboard and emits `game:finished` to the invite card. See
[server/webhook.js](server/webhook.js).

## Project layout

```
shared/        physics, constants, and the wire codec — imported by BOTH sides
server/        Node WebSocket server: auth, rooms, the authoritative sim, snapshots
client/        static Phaser client: netcode wiring, tilt/keyboard input, scenes, UI
test/          deterministic sim tests + snapshot-size ceiling
PROTOCOL.md    the binding server⇄client wire contract
```

Server and client never share runtime code *except* through `shared/` — that's
deliberate. `shared/movement.js` in particular must stay pure and identical on
both sides.

## Protocol reference

See [PROTOCOL.md](PROTOCOL.md) for the complete message catalog (envelope,
`input` shape, snapshot/delta format, error codes, and the results webhook).

---

MIT licensed. Built as a reference for the Usion SDK. Contributions and forks
welcome — if you ship a game on top of this, tell us.
