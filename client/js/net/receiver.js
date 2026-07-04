/**
 * Tilt Royale — inbound message processing. Owns the authoritative mirror of
 * server state: roster, phase, latest player rows, the dot list (keyframe +
 * delta codec), orbs — and feeds the netcode modules (predictor reconcile,
 * interpolation groups, predicted-shot reconcile) on every snapshot.
 *
 * Snapshot discipline (PROTOCOL.md):
 *  - `s` is monotonic on the BROADCAST chain; unicast resync keyframes REUSE
 *    the current seq, so keyframes are accepted at s == lastS too.
 *  - Only the dot stream is stateful (membership deltas). A seq gap therefore
 *    stalls DOTS ONLY until a keyframe restores them; players/projectiles/
 *    orbs/header are full state on every frame and are NEVER dropped on a
 *    gap — remote player motion must survive any resync window.
 *  - Resync requests are throttled (they cost a full keyframe each).
 */
import {
  decodePlayerRow, decodeDotsKeyframe, applyDotsDelta,
  decodeProjRow, decodeOrbRow,
} from '/shared/wire.js';
import { COUNTDOWN_MS } from '/shared/constants.js';

export function createReceiver({ bus, connection, predictor, interp, shots }) {
  const roster = new Map();      // slot → {userId, name}
  let mySlot = null;
  let spectator = false;
  let phase = 'waiting';
  let phaseAt = 0;               // local ms when phase last changed
  let countdownEndsAt = 0;       // local ms; from phase frame countdown_ms
  let remainingMs = null;        // round clock from last snapshot header
  let remainingAt = 0;           // local ms when remainingMs was sampled
  let rows = [];                 // latest decoded player rows, slot-indexed
  let orbs = [];
  let dots = [];                 // id-sorted [{id,x,y}] — mutated by deltas
  let lastS = -1;
  let dotsSynced = false;        // dots patch cleanly only on a contiguous chain
  let lastResyncReqAt = 0;       // throttle: each request costs a keyframe
  let selfAlive = false;

  // Debug-panel stats (bytes are approximated from the parsed payload —
  // the SDK hands us objects, not raw frames).
  const stats = { frames: 0, bytes: 0, since: Date.now(), measureBytes: false };

  function setRoster(list) {
    roster.clear();
    for (const r of list || []) roster.set(r.slot, { userId: r.user_id, name: r.name });
    bus.emit('game:roster', getRoster());
  }

  function setPhase(next, countdownMs) {
    if (next === phase && !countdownMs) return;
    const changed = next !== phase;
    phase = next;
    phaseAt = Date.now();
    if (countdownMs != null) countdownEndsAt = Date.now() + countdownMs;
    // Fallback: phase frames can be lost; snapshot headers still flip us to
    // 'countdown' but carry no countdown_ms — assume the shared default.
    else if (changed && next === 'countdown') countdownEndsAt = Date.now() + COUNTDOWN_MS;
    bus.emit('game:phase', { phase, countdownEndsAt });
  }

  function handleJoined(p) {
    // (Re)join baseline: server unicasts full context + a fresh keyframe.
    mySlot = p.slot;
    spectator = !!p.spectator;
    lastS = -1;                  // accept the join keyframe unconditionally
    dotsSynced = false;
    // A rejoin follows a gap: clear interp history so the buffer can't blend
    // across the disconnect (old snapshot → fresh keyframe = a fake streak).
    interp.clear?.();
    setRoster(p.roster);
    setPhase(p.phase);
    if (p.snapshot) handleSnapshot(p.snapshot, true);
    bus.emit('game:me', { slot: mySlot, spectator });
  }

  function requestResync() {
    const now = Date.now();
    if (now - lastResyncReqAt < 500) return;     // a keyframe per request — throttle
    lastResyncReqAt = now;
    connection.requestKeyframe(Math.max(0, lastS));
  }

  function handleSnapshot(p, fromJoin) {
    if (typeof p.s !== 'number') return;
    const isKey = !!p.k;
    const fresh = p.s > lastS;
    // Duplicate/ancient deltas carry nothing new. A keyframe at s == lastS is
    // the normal unicast resync (server reuses the broadcast seq) — apply its
    // dots, but don't re-fire events/interp for a frame we already processed.
    if (!fresh && !(isKey && p.s === lastS)) return;

    // Dots: the only stateful stream. Patch on a contiguous chain, restore
    // from any keyframe, and on a gap stall ONLY the dots while a throttled
    // resync is in flight — players/projs/orbs below flow regardless.
    if (isKey) {
      dots = decodeDotsKeyframe(p.dots || { ids: [], xs: [], ys: [] });
      dotsSynced = true;
    } else if (dotsSynced && p.s === lastS + 1) {
      applyDotsDelta(dots, p.dots || {});
    } else {
      dotsSynced = false;
      requestResync();
    }
    if (!fresh) return;                          // resync keyframe: dots restored, rest already seen
    lastS = p.s;

    if (stats.measureBytes) { try { stats.bytes += JSON.stringify(p).length; } catch (e) {} }
    stats.frames += 1;

    // Header state.
    setPhase(p.phase);
    if (typeof p.remaining_ms === 'number') { remainingMs = p.remaining_ms; remainingAt = Date.now(); }

    // Players: always full rows (≤ 4).
    rows = [];
    const players = [];
    for (const r of p.players || []) {
      const d = decodePlayerRow(r);
      rows[d.slot] = d;
      players.push(d);
    }
    orbs = (p.orbs || []).map(decodeOrbRow);
    const projs = (p.projs || []).map(decodeProjRow);

    // Reconcile own prediction against ack[mySlot] (JSON object keys are
    // strings). Only meaningful while we drive a live arrow.
    const me = mySlot != null ? rows[mySlot] : null;
    if (me && !spectator) {
      const ack = p.ack ? (p.ack[String(mySlot)] ?? p.ack[mySlot]) : null;
      if (me.alive) predictor.reconcile(me, ack == null ? -1 : ack);
      const wasAlive = selfAlive;
      selfAlive = me.alive;
      if (wasAlive && !me.alive) bus.emit('game:selfDied', {});
    }

    // Feed interpolation. Entities need stable ids; dots are cloned because
    // applyDotsDelta mutates our list in place while the vault must keep
    // immutable history. Remote players are everyone but us (our own arrow
    // renders from the predictor, never from interpolation).
    interp.addSnapshot({
      serverTs: p.server_ts,
      players: players
        .filter((d) => d.slot !== mySlot)
        .map((d) => ({ id: d.slot, x: d.x, y: d.y, vx: d.vx, vy: d.vy,
                       angle: d.angle, alive: d.alive, shield: d.shield,
                       stagger: d.stagger, connected: d.connected, weapon: d.weapon })),
      dots: dots.map((d) => ({ id: d.id, x: d.x, y: d.y })),
      projs: projs.map((pr) => ({ id: pr.id, x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy,
                                  kind: pr.kind, owner: pr.owner, fireSeq: pr.fireSeq })),
    });

    // Predicted scatter pellets: fade batches the server has confirmed.
    shots.reconcile(projs, mySlot);

    // Discrete events → FX bus (fired on arrival; VFX are self-animating so
    // the ≤ interp-buffer skew vs rendered positions is imperceptible).
    for (const ev of p.events || []) bus.emit('game:event', ev);

    bus.emit('game:snapshot', { fromJoin: !!fromJoin });
  }

  // --- wire up ---
  bus.on('net:joined', handleJoined);
  bus.on('net:snapshot', (p) => handleSnapshot(p, false));
  bus.on('net:phase', (p) => setPhase(p.phase, p.countdown_ms));
  bus.on('net:playerJoined', (p) => setRoster(p.roster));
  bus.on('net:playerLeft', (p) => setRoster(p.roster));
  bus.on('net:matchEnd', (p) => { setPhase('finished'); bus.emit('game:matchEnd', p); });
  bus.on('net:error', (p) => bus.emit('game:error', p));
  // Local-dev reconnect: our socket re-joined; ask for a fresh keyframe from
  // our last seq (the SDK does the equivalent requestSync itself in platform
  // mode — the throttle also folds that duplicate into one request).
  bus.on('net:reconnected', () => requestResync());

  function getRoster() {
    const out = [];
    for (const [slot, r] of roster.entries()) out.push({ slot, ...r });
    return out.sort((a, b) => a.slot - b.slot);
  }

  return {
    getRoster,
    mySlot: () => mySlot,
    isSpectator: () => spectator,
    phase: () => phase,
    phaseAt: () => phaseAt,
    countdownMsLeft: () => Math.max(0, countdownEndsAt - Date.now()),
    /** Round clock, extrapolated locally between 20 Hz headers. */
    remainingMs: () => (remainingMs == null ? null
      : Math.max(0, remainingMs - (Date.now() - remainingAt))),
    rows: () => rows,
    myRow: () => (mySlot != null ? rows[mySlot] || null : null),
    orbs: () => orbs,
    aliveCount: () => rows.reduce((n, r) => n + (r && r.alive ? 1 : 0), 0),
    lastSnapshotSeq: () => lastS,

    /** Debug stats: snapshot Hz + approx bytes/s since the last call. */
    drainStats() {
      const now = Date.now();
      const secs = Math.max(0.001, (now - stats.since) / 1000);
      const out = { hz: stats.frames / secs, bytesPerSec: stats.bytes / secs };
      stats.frames = 0; stats.bytes = 0; stats.since = now;
      return out;
    },
    setStatsEnabled(on) { stats.measureBytes = !!on; },
  };
}
