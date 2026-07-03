// Pure, deterministic player movement — imported VERBATIM by the server sim
// and by the client predictor (SDK createPredictor's `apply`). Bit-identical
// results on both sides are what make reconciliation silent: same op order,
// same clamps, same rounding. Do not fork this logic.

import {
  ACCEL, DRAG, MAX_SPEED, FACING_MIN_SPEED,
  ARENA, PLAYER_RADIUS, STATE_PRECISION,
} from './constants.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const q = (v) => Math.round(v * STATE_PRECISION) / STATE_PRECISION;

/**
 * Advance one player one step. Pure: returns a new {x,y,vx,vy,angle}.
 * Op order is part of the contract: accel → drag → cap → integrate →
 * wall clamp → facing → quantize.
 *
 * @param {{x:number,y:number,vx:number,vy:number,angle:number}} p
 * @param {{mx:number,my:number}} input  tilt vector, clamped to [-1,1]
 * @param {number} dtSec                 fixed step (1/SIM_HZ on both sides)
 */
export function stepPlayer(p, input, dtSec) {
  const mx = clamp(input.mx || 0, -1, 1);
  const my = clamp(input.my || 0, -1, 1);

  let vx = p.vx + mx * ACCEL * dtSec;
  let vy = p.vy + my * ACCEL * dtSec;

  const drag = Math.exp(-DRAG * dtSec);
  vx *= drag;
  vy *= drag;

  const sp = Math.hypot(vx, vy);
  if (sp > MAX_SPEED) {
    vx = (vx / sp) * MAX_SPEED;
    vy = (vy / sp) * MAX_SPEED;
  }

  let x = p.x + vx * dtSec;
  let y = p.y + vy * dtSec;

  const lo = PLAYER_RADIUS;
  const hi = ARENA - PLAYER_RADIUS;
  if (x < lo) { x = lo; if (vx < 0) vx = 0; }
  else if (x > hi) { x = hi; if (vx > 0) vx = 0; }
  if (y < lo) { y = lo; if (vy < 0) vy = 0; }
  else if (y > hi) { y = hi; if (vy > 0) vy = 0; }

  let angle = p.angle;
  if (Math.hypot(vx, vy) > FACING_MIN_SPEED) angle = Math.atan2(vy, vx);

  return { x: q(x), y: q(y), vx: q(vx), vy: q(vy), angle: q(angle) };
}

/** Quantize a full player pose with the shared precision (reconcile helper). */
export function roundState(p) {
  return { x: q(p.x), y: q(p.y), vx: q(p.vx), vy: q(p.vy), angle: q(p.angle) };
}

/** Deterministic PRNG (mulberry32) — dot steering noise, formation jitter. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
