// The pure round simulation — a fixed-step orchestrator with NO I/O.
//
// RoomRuntime (server/room.js) owns time, sockets, and scheduling; this
// module owns the rules. Everything is a function of (state, dtMs), state is
// flat and JSON-serializable, and the only randomness is the seeded stream
// in util.nextRand — so the headless tests can replay entire 150 s rounds
// deterministically at far faster than real time.
import {
  ARENA, MIN_PLAYERS, PLAYER_RADIUS, DOT_RADIUS, KILL_CIRCLE_FACTOR,
  ROUND_MS, SPAWN_SHIELD_MS, ORB_SPAWN_EVERY_MS,
} from '../../shared/constants.js';
import { stepPlayer } from '../../shared/movement.js';
import { DEATH_CAUSE } from '../../shared/wire.js';
import * as dots from './dots.js';
import * as weapons from './weapons.js';
import { accrueSurvival, killPlayer } from './score.js';
import { recordPosition, dist, clamp } from './util.js';

// Spawn corners (quarter points), facing the arena center — maximum initial
// separation for up to 4 players.
const SPAWNS = [
  { x: 30, y: 30 }, { x: 90, y: 90 }, { x: 90, y: 30 }, { x: 30, y: 90 },
];

const ZERO_INPUT = Object.freeze({ mx: 0, my: 0 });

/**
 * Create an empty pre-round state. Players are added as they join the
 * waiting room; beginRound() starts the clock.
 * @param {{seed:number}} opts
 */
export function createState({ seed }) {
  return {
    seed: seed >>> 0,
    rngCursor: 0,
    started: false,
    timeMs: 0,
    remainingMs: ROUND_MS,
    players: [],
    dots: [],
    pendingDots: [],
    projs: [],
    orbs: [],
    events: [],          // wire tuples, drained by the net layer per net tick
    dotRm: [],           // dot membership changes since last net frame …
    dotAdd: [],          // … consumed by snapshot building
    nextDotId: 1,
    nextProjId: 1,
    nextOrbId: 1,
    orbNextAtMs: ORB_SPAWN_EVERY_MS,
    director: { ambientAcc: 0, nextFormationAtMs: 0, formationIdx: 0, ringRR: 0 },
    over: null,          // { reason, winnerSlots } once terminal
  };
}

/**
 * Add a player at the next spawn corner. Valid until beginRound().
 * @param {object} state
 * @param {{slot:number,userId:string,name:string,bot?:boolean}} info
 */
export function addPlayer(state, { slot, userId, name, bot = false }) {
  const s = SPAWNS[slot % SPAWNS.length];
  const player = {
    slot, userId, name, bot,
    x: s.x, y: s.y, vx: 0, vy: 0,
    angle: Math.atan2(ARENA / 2 - s.y, ARENA / 2 - s.x),
    alive: true, connected: true,
    shieldUntilMs: 0, staggerUntilMs: 0,
    weapon: 0, ammo: 0, cooldownUntilMs: 0,
    score: 0, scoreFrac: 0,
    chain: 0, chainUntilMs: 0, bestCombo: 0,
    input: { mx: 0, my: 0 },
    fires: [],           // FIFO of unconsumed fire taps [{fs}]
    ackIseq: 0,          // highest applied input iseq (prediction ack)
    rewindMs: 0,         // lag-comp window, maintained by the room per input
    posHistory: [],      // rewind ring buffer (never serialized)
    stats: { kills: 0, dotKills: 0, pickups: 0, shotsFired: 0 },
    deathCause: null,
    diedAtMs: null,
  };
  state.players[slot] = player;
  return player;
}

/** Remove a waiting-room player and re-pack slots (only legal pre-round). */
export function removePlayer(state, slot) {
  if (state.started) throw new Error('removePlayer after round start');
  state.players.splice(slot, 1);
  state.players.forEach((p, i) => {
    p.slot = i;
    const s = SPAWNS[i % SPAWNS.length];
    p.x = s.x; p.y = s.y;
    p.angle = Math.atan2(ARENA / 2 - s.y, ARENA / 2 - s.x);
  });
}

/** Arm the round: start the clock, grant spawn shields (dot-immunity only). */
export function beginRound(state) {
  state.started = true;
  state.timeMs = 0;
  state.remainingMs = ROUND_MS;
  for (const p of state.players) p.shieldUntilMs = SPAWN_SHIELD_MS;
}

/** True while the spawn shield or an active stagger applies. */
export const isShielded = (state, p) => state.timeMs < p.shieldUntilMs;
export const isStaggered = (state, p) => state.timeMs < p.staggerUntilMs;

// Player-player collision: separate the overlap, exchange half the normal
// velocity components. "Small" on purpose — bumps are a nudge, not a weapon;
// full elastic exchange lets players spike each other into dot swarms.
function bumpPlayers(state) {
  const alive = state.players.filter((p) => p.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i];
      const b = alive[j];
      const d = dist(a.x, a.y, b.x, b.y);
      const minD = 2 * PLAYER_RADIUS;
      if (d >= minD || d === 0) continue;
      const nx = (b.x - a.x) / d;
      const ny = (b.y - a.y) / d;
      const push = (minD - d) / 2;
      const lo = PLAYER_RADIUS;
      const hi = ARENA - PLAYER_RADIUS;
      a.x = clamp(a.x - nx * push, lo, hi);
      a.y = clamp(a.y - ny * push, lo, hi);
      b.x = clamp(b.x + nx * push, lo, hi);
      b.y = clamp(b.y + ny * push, lo, hi);
      const va = a.vx * nx + a.vy * ny;
      const vb = b.vx * nx + b.vy * ny;
      if (va - vb > 0) { // only when approaching
        const ex = (vb - va) * 0.5;
        a.vx += ex * nx; a.vy += ex * ny;
        b.vx -= ex * nx; b.vy -= ex * ny;
      }
    }
  }
}

function dotVsPlayers(state) {
  for (const p of state.players) {
    if (!p.alive || isShielded(state, p)) continue;
    const killR = KILL_CIRCLE_FACTOR * (DOT_RADIUS + PLAYER_RADIUS);
    for (const d of state.dots) {
      if (dist(p.x, p.y, d.x, d.y) <= killR) {
        killPlayer(state, p, DEATH_CAUSE.DOT, -1);
        break;
      }
    }
  }
}

const highestScoreSlots = (players) => {
  const max = Math.max(...players.map((p) => p.score));
  return players.filter((p) => p.score === max).map((p) => p.slot);
};

function checkTerminal(state) {
  if (state.over || state.players.length < MIN_PLAYERS) return;
  const alive = state.players.filter((p) => p.alive);
  if (alive.length === 1) {
    state.over = { reason: 'elimination', winnerSlots: [alive[0].slot] };
  } else if (alive.length === 0) {
    // Same-tick wipe: nobody survived, highest score takes it.
    state.over = { reason: 'elimination', winnerSlots: highestScoreSlots(state.players) };
  } else if (state.timeMs >= ROUND_MS) {
    // Timeout ranks the survivors — a dead high-scorer already lost the
    // survival game that the timer rewards.
    state.over = { reason: 'timeout', winnerSlots: highestScoreSlots(alive) };
  }
}

/**
 * Advance the whole round one fixed step. Order matters and is part of the
 * design: move players (shared physics) → bumps → dots → weapons → lethal
 * contact → scoring → terminal check.
 * @param {object} state @param {number} dtMs
 * @param {object} [ctx] reserved for runtime context (currently none — all
 *   per-player netcode inputs ride on the player records)
 */
export function step(state, dtMs, ctx = {}) { // eslint-disable-line no-unused-vars
  if (!state.started || state.over) return;
  const dtSec = dtMs / 1000;
  state.timeMs += dtMs;
  state.remainingMs = Math.max(0, ROUND_MS - state.timeMs);

  for (const p of state.players) {
    if (!p.alive) continue;
    // Dead players never get here; staggered and disconnected players steer
    // with zero input — the arrow drifts to a stop but STAYS killable.
    const input = isStaggered(state, p) ? ZERO_INPUT : p.input;
    Object.assign(p, stepPlayer(p, input, dtSec));
    recordPosition(p);
  }
  bumpPlayers(state);
  dots.step(state, dtMs);
  weapons.step(state, dtMs);
  dotVsPlayers(state);
  accrueSurvival(state, dtMs);
  checkTerminal(state);
}
