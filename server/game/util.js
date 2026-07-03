// Small pure helpers shared by the sim modules. Everything here is
// deterministic — the sim's only randomness source is nextRand(state), which
// derives from the room seed + a cursor, so identical seeds + identical
// inputs replay bit-identically (the property the tests assert).
import { mulberry32 } from '../../shared/movement.js';
import { SIM_DT_MS, LAGCOMP_HISTORY_MS } from '../../shared/constants.js';

/** Max position-history entries per player (~500 ms at 60 Hz). */
export const POS_HISTORY_MAX = Math.round(LAGCOMP_HISTORY_MS / SIM_DT_MS);

/**
 * Draw the next deterministic uniform [0,1) from the state's RNG stream.
 * Each draw seeds a fresh mulberry32 with seed^golden-ratio-hash(cursor) —
 * slightly wasteful but keeps the RNG state a single serializable integer.
 * @param {{seed:number, rngCursor:number}} state
 */
export function nextRand(state) {
  state.rngCursor = (state.rngCursor + 1) | 0;
  return mulberry32((state.seed ^ Math.imul(state.rngCursor, 0x9e3779b9)) >>> 0)();
}

/** Record a player's post-movement position for lag-compensated rewinds. */
export function recordPosition(p) {
  p.posHistory.push({ x: p.x, y: p.y });
  if (p.posHistory.length > POS_HISTORY_MAX) p.posHistory.shift();
}

/**
 * The player's position `rewindMs` ago (CS:GO-style rewind) — where the
 * SHOOTER saw this player, so "what you see is what you hit" holds at high
 * RTT. Falls back to the current position when history is short.
 * @param {{x:number,y:number,posHistory:{x:number,y:number}[]}} p
 * @param {number} rewindMs
 */
export function rewindPos(p, rewindMs) {
  if (!rewindMs || rewindMs <= 0 || p.posHistory.length === 0) return { x: p.x, y: p.y };
  const ticksBack = Math.round(rewindMs / SIM_DT_MS);
  const idx = Math.max(0, p.posHistory.length - 1 - ticksBack);
  return p.posHistory[idx];
}

/** Signed smallest angle from `a` to `b`, wrapped to (-PI, PI]. */
export function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
