# Tilt Royale wire protocol (server ⇄ client contract)

This file is the binding contract between `server/` and `client/`. Both sides
also share code: [shared/constants.js](shared/constants.js) (every number),
[shared/movement.js](shared/movement.js) (player physics — server sim AND
client prediction), [shared/wire.js](shared/wire.js) (codec). If you change
anything here, change both sides in the same commit.

Transport: **JSON text frames** over WebSocket at `/ws`. The Usion SDK's
direct-mode socket drops binary frames — everything is JSON.

## Envelope

Every client→server message uses the Usion SDK direct-mode envelope:

```json
{ "type": "input", "room_id": "r1", "ts": 1720000000000, "seq": 41,
  "session_id": "…", "protocol_version": "2", "payload": { } }
```

- `seq` is transport-monotonic per connection; the server drops `seq <= last`.
- Server→client messages are `{ "type": "...", "payload": { } }` (plus
  `room_id`). The SDK dispatches them by `type`.

## Connection & auth

- URL: `wss://…/ws?token=<RS256 JWT>` (SDK appends the token it fetched from
  `POST /games/rooms/{room_id}/access`).
- Server verifies via platform JWKS (`JWKS_URL`), audience
  `usion-game-service:<SERVICE_ID>`, requires `permissions` to include
  `"play"`; identity = `sub`, room = `room_id` claim, `session_id` claim kept
  for results.
- **Dev bypass** (`DEV_ALLOW_UNSIGNED=1` AND `NODE_ENV != production`):
  token format `dev:<user_id>:<room_id>` mints a synthetic identity
  (name = user_id). Server logs a loud warning; refuses to boot with the flag
  set in production.

## Client → server messages

| type | payload | notes |
|---|---|---|
| `join` | `{}` | sent on open (SDK does this). Idempotent; rejoin re-attaches the same slot and triggers a unicast keyframe. |
| `input` | see below | the only gameplay message. Server must ALSO accept `action` as an alias (SDK versions drift). |
| `heartbeat` | `{}` | SDK sends every 25 s. Refreshes liveness only. |
| `ping` | `{ t }` or `{ last_sequence }` | reply `pong` (see below). If `last_sequence` present → also unicast a fresh keyframe (SDK reconnect resync path). |
| `sync` | `{ sequence }` | same keyframe resync response. |
| `leave` | `{}` | optional; same as socket close. |
| `set_state` | ignored | reply `error` code `UNSUPPORTED` (server-authoritative game). |

### `input` payload

```json
{ "action_type": "input",
  "action_data": {
    "mx": 0.42, "my": -0.87,      // tilt vector, clamped server-side to [-1,1]
    "iseq": 512,                  // input sequence for prediction ack
    "fires": [{ "fs": 17 }],      // fire taps since last flush (fs = client fire_seq)
    "interp_ms": 90,              // client interp buffer (for lag comp), clamp 0..250
    "csa": 1720000000000          // client_sent_at ms (one-way delay EWMA), clamp age 0..2000
  } }
```

- Client sends at 30 Hz (SDK `createSender`), latest-wins for tilt; `fires`
  accumulate and flush immediately on tap (min 33 ms gap).
- **`hello` sub-message**: right after `joined`, the client sends an input
  frame with `action_type: "hello"`, `action_data: { name }` — platform RS256
  tokens carry no display-name claim, so this is how rosters get real names
  (server sanitizes: control chars stripped, 24 chars max). It rides the
  input channel because the SDK's public `realtime()` API cannot emit custom
  envelope types. Accepted in every phase.
- Server keeps *latest input per player* (ticks between messages reuse it) and
  a FIFO of unconsumed fires. Rate limit: token bucket 60 msg/s, burst 10;
  violations → `error` code `RATE_LIMITED`, repeat → close.
- Input from dead/spectator players is ignored.

## Server → client messages

| type | payload |
|---|---|
| `joined` | `{ room_id, slot, spectator, roster, phase, snapshot }` — `roster: [{slot, user_id, name}]`; `snapshot` = a full keyframe payload (below). Sent on every (re)join, unicast. |
| `player_joined` | `{ roster, slot, user_id, name }` broadcast on roster growth. |
| `player_left` | `{ slot, user_id, roster }` broadcast (leaves roster only in `waiting`; during a round the slot stays, flagged disconnected via player flags). |
| `phase` | `{ phase, at_ms, countdown_ms? }` broadcast on `waiting → countdown → playing → finished`. |
| `state_snapshot` | full keyframe (below), broadcast every `KEYFRAME_EVERY_NET_TICKS`, and unicast on join/resync. |
| `state_delta` | delta frame (below), broadcast on all other net ticks. |
| `pong` | `{ t, server_ts, server_tick }` (echo `t` when given). |
| `match_end` | `{ winner_ids, reason, placements: [{slot, user_id, name, score, kills, dot_kills, survival_ms, best_combo}] }` broadcast; sockets close after `RESULTS_LINGER_MS`. |
| `error` | `{ code, message }` — codes: `INVALID_TOKEN`, `ROOM_FULL`, `RATE_LIMITED`, `UNSUPPORTED`, `BAD_MESSAGE`. |

## Snapshot payloads

Codec helpers in [shared/wire.js](shared/wire.js). Positions are quantized
ints (`POS_QUANT` 0.25 u), velocities ×10, angles ×100. Players are addressed
by `slot` (0..3); `roster` maps slots to user ids once.

### `state_snapshot` (keyframe)

```json
{ "s": 87,                       // snapshot seq, monotonic; receiver drops stale
  "k": true,                     // keyframe marker
  "server_ts": 1720000000000, "server_tick": 4321,
  "phase": "playing", "remaining_ms": 92000,
  "ack": { "0": 512, "1": 498 }, // highest applied input iseq per slot
  "players": [[slot, xq, yq, vxq, vyq, angq, flags, weapon, ammo, score, chain], …],
  "dots": { "ids": […], "xs": […], "ys": […] },      // id-sorted parallel arrays
  "projs": [[id, kind, ownerSlot, xq, yq, vxq, vyq, fireSeq], …],
  "orbs": [[id, xq, yq, type], …],
  "events": [["dk", 2, 7, 180, 240], ["pk", 1, 3], …] }
```

### `state_delta`

Same header fields (`s`, `server_ts`, `server_tick`, `phase`, `remaining_ms`,
`ack`, `events`, `projs`, `orbs`, `players` — players always full rows, ≤ 4),
but `k` absent and `dots` is:

```json
{ "rm": [ids…], "add": [[id, xq, yq], …], "xs": […], "ys": […] }
```

Receiver: apply `rm`, then `add` (keep list id-sorted), then `xs`/`ys` are
positions for **all alive dots in id order**. Deltas are stateful only
relative to dot membership; a receiver that missed frames requests a keyframe
(`ping` with `last_sequence`) instead of patching gaps. `s` gaps > 1 on a
delta ⇒ resync.

Dot spawn telegraphs are **events only** (`["tg", xq, yq]`): the client renders
a 1 s ghost locally; the dot row appears in `add` when it goes live. Removed
dots (killed/converted) appear in `rm`; kill VFX come from `dk` events.

## Timing

- Sim 60 Hz fixed-step; net tick every 3 sim ticks (20 Hz); keyframe every
  20 net ticks (1 s).
- Serialized snapshot length is asserted ≤ `SNAPSHOT_MAX_BYTES` (7.5 KB);
  breach logs + emergency-culls oldest hunter dots (tripwire — sim caps make
  this unreachable).
- Server sweeps sessions silent > 45 s. Disconnected players' arrows drift to
  a stop (zeroed input) and stay killable; reconnect within the round
  re-attaches the slot.

## Match results (server → platform, not the socket)

`POST {API_URL}/games/direct/results` with HMAC-SHA256 signature headers
(`X-Usion-Service-Id`, `X-Usion-Key-Id`, `X-Usion-Signature`,
`X-Usion-Timestamp`, `X-Idempotency-Key`); canonical string
`timestamp\nPOST\n/games/direct/results\nsha256hex(body)`. Body:

```json
{ "room_id": "…", "session_id": "…", "service_id": "tilt-royale",
  "winner_ids": ["u1"], "participants": ["u1","u2","u3"],
  "reason": "elimination",
  "final_stats": { "u1": { "slot": 0, "score": 2410, "kills": 1, "dot_kills": 84,
                            "pickups": 5, "survival_ms": 121000, "best_combo": 9,
                            "shots_fired": 11, "death_cause": null } },
  "ended_at": "2026-07-04T12:00:00Z" }
```

`reason ∈ elimination | timeout | opponents_left | error`. `session_id` = any
authenticated player's session (the platform validates room + service).
