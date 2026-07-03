// RoomRuntime — one instance per room_id: lifecycle, tick loop, sockets.
//
// waiting → countdown(3 s) → playing(150 s) → finished. The sim (game/sim.js)
// is pure; this class owns everything impure: wall-clock time, the
// self-correcting 60 Hz scheduler (ported from space-craft-direct), socket
// fan-out, the results webhook, and session sweeping.
import {
  MIN_PLAYERS, MAX_PLAYERS, COUNTDOWN_MS, AUTO_START_MS, RESULTS_LINGER_MS,
  SIM_DT_MS, NET_EVERY_SIM_TICKS, KEYFRAME_EVERY_NET_TICKS, MAX_REWIND_MS,
  SESSION_SILENT_TIMEOUT_MS, LONE_PLAYER_END_MS,
} from './config.js';
import * as sim from './game/sim.js';
import { buildFrame } from './net/snapshot.js';
import { buildFinalStats, buildPlacements } from './game/score.js';
import * as bots from './bots.js';
import { submitMatchResult } from './webhook.js';
import { clamp } from './game/util.js';

const SWEEP_EVERY_MS = 5_000;
const MAX_PENDING_FIRES = 6;      // FIFO cap per player — bounds burst abuse
const MAX_SPECTATORS = 16;

const hashSeed = (roomId) => {
  let h = 0x811c9dc5; // FNV-1a — cheap, stable across restarts for same room
  for (let i = 0; i < roomId.length; i++) {
    h ^= roomId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export class Room {
  /**
   * @param {string} roomId
   * @param {{ onDestroy: (roomId: string) => void }} deps registry hook —
   *   index.js deletes the room from its map when the runtime dies.
   */
  constructor(roomId, { onDestroy }) {
    this.roomId = roomId;
    this.onDestroy = onDestroy;
    this.phase = 'waiting';
    this.state = sim.createState({ seed: hashSeed(roomId) });

    this.conns = new Map();          // userId -> conn (players)
    this.spectators = new Set();     // conns watching only
    this.lastSessionId = null;       // any authenticated session, for results

    this.serverTick = 0;
    this.netTick = 0;
    this.snapSeq = 0;
    this.countdownRemainingMs = 0;
    this.loneSinceMs = null;
    this.destroyed = false;

    this.tickHandle = null;
    this.lastTickNs = null;
    this.startTimer = null;
    this.lingerTimer = null;
    this.botTimer = null;
    this.botMem = { lastFireMs: -Infinity, fireSeq: 1 };
    this.sweepInterval = setInterval(() => this._sweep(), SWEEP_EVERY_MS);
    this.sweepInterval.unref?.();
  }

  // ------------------------------------------------------------- wire out --

  _send(conn, type, payload) {
    if (conn.ws.readyState !== 1) return;
    try { conn.ws.send(JSON.stringify({ type, room_id: this.roomId, payload })); } catch { /* dead socket */ }
  }

  _sendRaw(conn, json) {
    if (conn.ws.readyState !== 1) return;
    try { conn.ws.send(json); } catch { /* dead socket */ }
  }

  broadcast(type, payload) {
    const json = JSON.stringify({ type, room_id: this.roomId, payload });
    for (const conn of this.conns.values()) this._sendRaw(conn, json);
    for (const conn of this.spectators) this._sendRaw(conn, json);
  }

  _roster() {
    return this.state.players.map((p) => ({ slot: p.slot, user_id: p.userId, name: p.name }));
  }

  _frameMeta() {
    const ack = {};
    for (const p of this.state.players) ack[p.slot] = p.ackIseq;
    return {
      s: ++this.snapSeq,
      serverTs: Date.now(),
      serverTick: this.serverTick,
      phase: this.phase,
      ack,
    };
  }

  /** Unicast a fresh keyframe (join/resync). Never consumes the broadcast queue. */
  _unicastKeyframe(conn) {
    const { json } = buildFrame(this.state, this._frameMeta(), { keyframe: true, consume: false });
    this._sendRaw(conn, json);
  }

  // ------------------------------------------------------------ messages ---

  /** Entry point from index.js — envelope already rate-limited + seq-guarded. */
  handleMessage(conn, msg) {
    const type = msg?.type;
    const payload = msg?.payload || {};
    switch (type) {
      case 'join': return this._handleJoin(conn);
      case 'input':
      case 'action': // SDK versions drift on the type name — accept both
        return this._handleInput(conn, payload);
      case 'heartbeat': return; // liveness already refreshed by index.js
      case 'ping': {
        this._send(conn, 'pong', {
          t: payload?.t, server_ts: Date.now(), server_tick: this.serverTick,
        });
        // Reconnect resync path: SDK pings with last_sequence when it
        // suspects it missed frames — answer with a full keyframe.
        if (payload && payload.last_sequence !== undefined) this._unicastKeyframe(conn);
        return;
      }
      case 'sync': return this._unicastKeyframe(conn);
      case 'leave': {
        this.detachConn(conn);
        try { conn.ws.close(); } catch { /* already closing */ }
        return;
      }
      case 'set_state':
        return this._send(conn, 'error', {
          code: 'UNSUPPORTED', message: 'Server-authoritative game: set_state is ignored',
        });
      default:
        return this._send(conn, 'error', {
          code: 'BAD_MESSAGE', message: `Unknown message type: ${String(type).slice(0, 32)}`,
        });
    }
  }

  _handleJoin(conn) {
    this.lastSessionId = conn.sessionId;
    const existing = this.state.players.find((p) => p.userId === conn.userId);

    if (existing) {
      // Rejoin: re-attach the slot. An older socket for the same user is
      // superseded — close it so there is exactly one pipe per player.
      const old = this.conns.get(conn.userId);
      if (old && old !== conn) { try { old.ws.close(); } catch { /* noop */ } }
      this.conns.set(conn.userId, conn);
      existing.connected = true;
      existing.ackIseq = 0; // client predictor restarts iseq on a new socket
      this._sendJoined(conn, existing.slot, false);
      return;
    }

    const preRound = this.phase === 'waiting' || this.phase === 'countdown';
    if (preRound) {
      // A bot never blocks a human: evict it if the roster is full.
      const evict = bots.botSlotToEvict(this);
      if (evict !== null && this.state.players.length >= MAX_PLAYERS) this._removeWaitingPlayer(evict);

      if (this.state.players.length < MAX_PLAYERS) {
        const slot = this.state.players.length;
        sim.addPlayer(this.state, { slot, userId: conn.userId, name: conn.name });
        this.conns.set(conn.userId, conn);
        this._sendJoined(conn, slot, false);
        this.broadcast('player_joined', {
          roster: this._roster(), slot, user_id: conn.userId, name: conn.name,
        });
        bots.evaluateFill(this);
        this._maybeArmAutoStart();
        if (this.phase === 'waiting' && this.state.players.length >= MAX_PLAYERS) {
          this._startCountdown(); // full house — no reason to make 4 people wait
        }
        return;
      }
    }

    // Mid-round joins (and overflow pre-round) spectate: snapshots, no input.
    if (this.spectators.size >= MAX_SPECTATORS) {
      this._send(conn, 'error', { code: 'ROOM_FULL', message: 'Room and spectator seats are full' });
      try { conn.ws.close(); } catch { /* noop */ }
      return;
    }
    conn.spectator = true;
    this.spectators.add(conn);
    this._sendJoined(conn, null, true);
  }

  _sendJoined(conn, slot, spectator) {
    const { payload } = buildFrame(this.state, this._frameMeta(), { keyframe: true, consume: false });
    this._send(conn, 'joined', {
      room_id: this.roomId, slot, spectator,
      roster: this._roster(), phase: this.phase, snapshot: payload,
    });
  }

  _handleInput(conn, payload) {
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    const p = this.state.players.find((pl) => pl.userId === conn.userId);
    if (!p || !p.alive) return; // spectators and the dead are ignored

    const d = payload?.action_data || payload || {};
    p.input = { mx: clamp(Number(d.mx) || 0, -1, 1), my: clamp(Number(d.my) || 0, -1, 1) };

    const iseq = Number(d.iseq);
    if (Number.isFinite(iseq) && iseq > p.ackIseq) p.ackIseq = iseq;

    if (Array.isArray(d.fires)) {
      for (const f of d.fires) {
        const fs = Number(f?.fs);
        if (!Number.isFinite(fs)) continue;
        if (p.fires.length >= MAX_PENDING_FIRES) p.fires.shift(); // keep newest taps
        p.fires.push({ fs });
      }
    }

    // One-way delay EWMA from client_sent_at; rewind window per PROTOCOL.md:
    // min(2×one-way + interp buffer, MAX_REWIND_MS). 2×one-way ≈ RTT — the
    // shooter saw the victim a full round-trip plus their interp buffer ago.
    const interp = clamp(Number(d.interp_ms) || 0, 0, 250);
    const csa = Number(d.csa);
    if (Number.isFinite(csa) && csa > 0) {
      const age = Date.now() - csa;
      if (age >= 0 && age <= 2000) {
        conn.ewmaOneWayMs = conn.ewmaOneWayMs === null ? age : conn.ewmaOneWayMs * 0.8 + age * 0.2;
      }
    }
    p.rewindMs = Math.min(2 * (conn.ewmaOneWayMs || 0) + interp, MAX_REWIND_MS);
  }

  // ----------------------------------------------------------- lifecycle ---

  _maybeArmAutoStart() {
    if (this.phase !== 'waiting' || this.startTimer) return;
    if (this.state.players.length < MIN_PLAYERS) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.phase === 'waiting' && this.state.players.length >= MIN_PLAYERS) {
        this._startCountdown();
      }
    }, AUTO_START_MS);
  }

  _startCountdown() {
    if (this.phase !== 'waiting') return;
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    this.phase = 'countdown';
    this.countdownRemainingMs = COUNTDOWN_MS;
    this.broadcast('phase', { phase: 'countdown', at_ms: Date.now(), countdown_ms: COUNTDOWN_MS });
    this.lastTickNs = process.hrtime.bigint();
    this._scheduleNextTick();
  }

  _beginPlaying() {
    this.phase = 'playing';
    sim.beginRound(this.state);
    this.broadcast('phase', { phase: 'playing', at_ms: Date.now() });
  }

  // Self-correcting fixed-step scheduler (space-craft pattern): each timeout
  // is aimed at "previous tick start + SIM_DT_MS", so processing time and
  // timer jitter do not accumulate into sim-clock drift.
  _scheduleNextTick() {
    if (this.phase !== 'countdown' && this.phase !== 'playing') return;
    const elapsedNs = Number(process.hrtime.bigint() - this.lastTickNs);
    const delayMs = Math.max(0, Math.round((SIM_DT_MS * 1e6 - elapsedNs) / 1e6));
    this.tickHandle = setTimeout(() => this._tick(), delayMs);
  }

  _tick() {
    if (this.destroyed || (this.phase !== 'countdown' && this.phase !== 'playing')) return;
    const now = process.hrtime.bigint();
    // Actual elapsed time, clamped to 2 steps — a long GC pause slows the
    // game briefly instead of triggering a spiral-of-death catch-up.
    const dtMs = Math.min(Number(now - this.lastTickNs) / 1e6, SIM_DT_MS * 2);
    this.lastTickNs = now;
    this.serverTick += 1;

    if (this.phase === 'countdown') {
      this.countdownRemainingMs -= dtMs;
      if (this.countdownRemainingMs <= 0) this._beginPlaying();
    } else {
      if (this.serverTick % bots.BOT_THINK_EVERY_SIM_TICKS === 0) bots.tickBots(this);
      sim.step(this.state, dtMs);
      this._checkLonePlayer();
    }

    if (this.serverTick % NET_EVERY_SIM_TICKS === 0) this._netTick();

    if (this.state.over && this.phase === 'playing') {
      this._finishRound(this.state.over.reason, this.state.over.winnerSlots);
      return;
    }
    this._scheduleNextTick();
  }

  _netTick() {
    this.netTick += 1;
    const keyframe = (this.netTick - 1) % KEYFRAME_EVERY_NET_TICKS === 0;
    const { json } = buildFrame(this.state, this._frameMeta(), { keyframe, consume: true });
    for (const conn of this.conns.values()) this._sendRaw(conn, json);
    for (const conn of this.spectators) this._sendRaw(conn, json);
  }

  _checkLonePlayer() {
    const connected = this.state.players.filter((p) => p.connected).length;
    if (connected > 1) { this.loneSinceMs = null; return; }
    const now = Date.now();
    if (this.loneSinceMs === null) { this.loneSinceMs = now; return; }
    if (now - this.loneSinceMs < LONE_PLAYER_END_MS) return;
    // Everyone else has been gone 20 s — no point simulating an empty match.
    const lone = this.state.players.find((p) => p.connected);
    const winnerSlots = lone
      ? [lone.slot]
      : [...this.state.players].sort((a, b) => b.score - a.score).slice(0, 1).map((p) => p.slot);
    this._finishRound('opponents_left', winnerSlots);
  }

  _finishRound(reason, winnerSlots) {
    if (this.phase === 'finished' || this.destroyed) return;
    this.phase = 'finished';
    if (this.tickHandle) { clearTimeout(this.tickHandle); this.tickHandle = null; }

    this.broadcast('phase', { phase: 'finished', at_ms: Date.now() });
    const winnerIds = winnerSlots.map((s) => this.state.players[s]?.userId).filter(Boolean);
    this.broadcast('match_end', {
      winner_ids: winnerIds,
      reason,
      placements: buildPlacements(this.state, winnerSlots),
    });

    submitMatchResult({
      roomId: this.roomId,
      sessionId: this.lastSessionId || 'unknown',
      winnerIds,
      participants: this.state.players.map((p) => p.userId),
      reason,
      finalStats: buildFinalStats(this.state),
      hadBot: this.state.players.some((p) => p.bot),
    }).catch((err) => console.error(`[ROOM ${this.roomId}] webhook error`, err));

    // Let clients sit on the results screen, then tear everything down.
    this.lingerTimer = setTimeout(() => this.destroy(), RESULTS_LINGER_MS);
    this.lingerTimer.unref?.();
  }

  // ---------------------------------------------------------- connections --

  /** Socket closed (or leave). Roster semantics per PROTOCOL.md. */
  detachConn(conn) {
    if (this.spectators.delete(conn)) return;
    if (this.conns.get(conn.userId) !== conn) return; // superseded socket
    this.conns.delete(conn.userId);

    const p = this.state.players.find((pl) => pl.userId === conn.userId);
    if (!p) return;

    if (this.phase === 'waiting') {
      this._removeWaitingPlayer(p.slot);
      bots.evaluateFill(this);
      if (this.state.players.length < MIN_PLAYERS && this.startTimer) {
        clearTimeout(this.startTimer);
        this.startTimer = null;
      }
    } else {
      // Mid-round: the slot stays, flagged disconnected. Input zeroes so the
      // arrow drifts to a stop — still killable, reconnect re-attaches.
      p.connected = false;
      p.input = { mx: 0, my: 0 };
      p.fires = [];
      this.broadcast('player_left', { slot: p.slot, user_id: p.userId, roster: this._roster() });
    }
  }

  _removeWaitingPlayer(slot) {
    const p = this.state.players[slot];
    if (!p) return;
    sim.removePlayer(this.state, slot);
    if (p.bot) this.botMem = { lastFireMs: -Infinity, fireSeq: 1 };
    this.broadcast('player_left', { slot, user_id: p.userId, roster: this._roster() });
  }

  /** Bot fill callback (bots.evaluateFill owns the eligibility rules). */
  addBotPlayer() {
    const slot = this.state.players.length;
    sim.addPlayer(this.state, { slot, userId: bots.BOT_USER_ID, name: bots.BOT_NAME, bot: true });
    this.broadcast('player_joined', {
      roster: this._roster(), slot, user_id: bots.BOT_USER_ID, name: bots.BOT_NAME,
    });
    this._maybeArmAutoStart();
  }

  _sweep() {
    if (this.destroyed) return;
    const now = Date.now();
    for (const conn of [...this.conns.values(), ...this.spectators]) {
      if (now - conn.lastSeenMs > SESSION_SILENT_TIMEOUT_MS) {
        try { conn.ws.close(); } catch { /* noop */ } // close event → detachConn
      }
    }
    // An empty waiting room has no future; rounds in progress are ended by
    // the lone-player rule, and finished rooms by the linger timer.
    if (this.phase === 'waiting' && this.conns.size === 0 && this.spectators.size === 0) {
      this.destroy();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const t of [this.tickHandle, this.startTimer, this.lingerTimer, this.botTimer]) {
      if (t) clearTimeout(t);
    }
    clearInterval(this.sweepInterval);
    for (const conn of [...this.conns.values(), ...this.spectators]) {
      try { conn.ws.close(); } catch { /* noop */ }
    }
    this.conns.clear();
    this.spectators.clear();
    this.onDestroy(this.roomId);
  }
}
