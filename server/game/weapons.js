// Orbs, fire resolution, and projectiles — the lag-compensation heart.
//
// Netcode trade-offs, per weapon (see PROTOCOL.md + shared/constants.js):
// - W1 WAVE is hitscan: resolved instantly against REWOUND player positions
//   ("what you see is what you hit"), dots at current positions (server-owned
//   swarm, nobody predicts individual dots so there is nothing to compensate).
// - W2 SCATTER pellets are client-predicted ballistics (fireSeq on the wire
//   lets the client reconcile its ghost pellets). A rewind spawn-window trace
//   makes point-blank hits land at high RTT, then the pellet is spawned
//   already advanced past the lag window so it appears where the shooter's
//   screen says it is.
// - W3 SEEKER is server-steered and NOT predicted — homing state on the
//   client would desync; clients just render the authoritative missile rows.
import {
  ARENA, PLAYER_RADIUS, DOT_RADIUS, ORB_RADIUS, PELLET_RADIUS, MISSILE_RADIUS,
  WEAPON_NONE, WEAPON_WAVE, WEAPON_SCATTER, WEAPON_SEEKER,
  WAVE, SCATTER, SEEKER, MAX_PROJECTILES,
  ORB_SPAWN_EVERY_MS, MAX_ORBS, ORB_MIN_PLAYER_DIST, SIM_DT_MS,
} from '../../shared/constants.js';
import { EV, DEATH_CAUSE, qPos, qAng } from '../../shared/wire.js';
import { nextRand, rewindPos, angleDiff, dist, clamp } from './util.js';
import { removeDotIds } from './dots.js';
import { awardDotKills, killPlayer } from './score.js';

const WEAPON_SPEC = { [WEAPON_WAVE]: WAVE, [WEAPON_SCATTER]: SCATTER, [WEAPON_SEEKER]: SEEKER };
const KIND_PELLET = 2;
const KIND_MISSILE = 3;
const CLUSTER_GRID_U = 16;            // dot-density buckets for seeker fallback
const MISSILE_ARRIVE_U = 1.5;         // cluster-point "impact" distance

const living = (state) => state.players.filter((p) => p.alive);
const rivalsOf = (state, slot) => living(state).filter((p) => p.slot !== slot);

/** Kill dots by id, credit the shooter, emit one aggregated 'dk' at the centroid. */
function killDots(state, shooter, ids, cx, cy) {
  if (!ids.length) return;
  removeDotIds(state, ids);
  awardDotKills(state, shooter, ids.length);
  state.events.push([EV.DOT_KILLS, shooter.slot, ids.length, qPos(cx), qPos(cy)]);
}

// ----------------------------------------------------------------- orbs -----

function stepOrbs(state) {
  if (state.timeMs >= state.orbNextAtMs) {
    state.orbNextAtMs = state.timeMs + ORB_SPAWN_EVERY_MS;
    if (state.orbs.length < MAX_ORBS) {
      // Rejection-sample a spot ≥ ORB_MIN_PLAYER_DIST from every living
      // player — orbs must be earned by crossing dot-infested ground, never
      // handed to whoever is standing there. Bounded tries: skip this cycle
      // if the arena is too crowded (next cycle is 7 s away).
      const margin = ORB_RADIUS + 2;
      for (let tries = 0; tries < 12; tries++) {
        const x = margin + nextRand(state) * (ARENA - 2 * margin);
        const y = margin + nextRand(state) * (ARENA - 2 * margin);
        if (living(state).some((p) => dist(p.x, p.y, x, y) < ORB_MIN_PLAYER_DIST)) continue;
        state.orbs.push({ id: state.nextOrbId++, x, y, type: 1 + Math.floor(nextRand(state) * 3) });
        break;
      }
    }
  }

  for (const p of living(state)) {
    for (let i = 0; i < state.orbs.length; i++) {
      const o = state.orbs[i];
      if (dist(p.x, p.y, o.x, o.y) > PLAYER_RADIUS + ORB_RADIUS) continue;
      p.weapon = o.type;                       // replaces any held weapon
      p.ammo = WEAPON_SPEC[o.type].AMMO;
      p.cooldownUntilMs = state.timeMs;        // fresh pickup fires immediately
      p.stats.pickups += 1;
      state.events.push([EV.PICKUP, p.slot, o.type]);
      state.orbs.splice(i, 1);
      break;                                   // one orb per player per tick
    }
  }
}

// ----------------------------------------------------------------- fires ----

function fireWave(state, p) {
  state.events.push([EV.WAVE, p.slot, qPos(p.x), qPos(p.y), qAng(p.angle)]);
  const half = WAVE.ARC_RAD / 2;
  const inArc = (x, y) => Math.abs(angleDiff(p.angle, Math.atan2(y - p.y, x - p.x))) <= half;

  const killed = [];
  let cx = 0; let cy = 0;
  for (const d of state.dots) {
    if (dist(p.x, p.y, d.x, d.y) <= WAVE.RADIUS + DOT_RADIUS && inArc(d.x, d.y)) {
      killed.push(d.id); cx += d.x; cy += d.y;
    }
  }
  if (killed.length) killDots(state, p, killed, cx / killed.length, cy / killed.length);

  for (const r of rivalsOf(state, p.slot)) {
    // Rewind the TARGET to where the shooter saw them; the shooter is at
    // their authoritative present position (they fired "now").
    const rp = rewindPos(r, p.rewindMs);
    const dd = dist(p.x, p.y, rp.x, rp.y);
    if (dd > WAVE.RADIUS + PLAYER_RADIUS || !inArc(rp.x, rp.y)) continue;
    if (dd <= WAVE.KILL_RADIUS + PLAYER_RADIUS) {
      killPlayer(state, r, DEATH_CAUSE.WAVE, p.slot);
    } else {
      const ux = (rp.x - p.x) / (dd || 1);
      const uy = (rp.y - p.y) / (dd || 1);
      r.vx += ux * WAVE.KNOCKBACK;
      r.vy += uy * WAVE.KNOCKBACK;
      state.events.push([EV.KNOCKBACK, r.slot]);
    }
  }
}

function cullOldestProjectiles(state, incoming) {
  while (state.projs.length + incoming > MAX_PROJECTILES) state.projs.shift();
}

function fireScatter(state, p, fs) {
  state.events.push([EV.FIRE, p.slot, WEAPON_SCATTER, fs]);
  cullOldestProjectiles(state, SCATTER.PELLETS);
  const rewindMs = clamp(p.rewindMs, 0, SCATTER.TTL_MS);
  const steps = Math.floor(rewindMs / SIM_DT_MS);

  for (let i = 0; i < SCATTER.PELLETS; i++) {
    const a = p.angle + SCATTER.FAN_RAD * (i / (SCATTER.PELLETS - 1) - 0.5);
    const vx = Math.cos(a) * SCATTER.SPEED;
    const vy = Math.sin(a) * SCATTER.SPEED;
    let x = p.x + Math.cos(a) * PLAYER_RADIUS;
    let y = p.y + Math.sin(a) * PLAYER_RADIUS;

    // Spawn-window trace: march the pellet through the shooter's lag window
    // checking rewound rivals (and current dots) so point-blank shots that
    // clearly hit on the shooter's screen actually hit. If it survives, the
    // pellet enters the world already advanced — visually consistent for
    // everyone, and its remaining TTL is reduced by the traced time.
    let consumed = false;
    for (let s = 1; s <= steps && !consumed; s++) {
      x += vx * (SIM_DT_MS / 1000);
      y += vy * (SIM_DT_MS / 1000);
      const remaining = rewindMs - s * SIM_DT_MS;
      for (const r of rivalsOf(state, p.slot)) {
        const rp = rewindPos(r, Math.max(0, remaining));
        if (dist(x, y, rp.x, rp.y) <= PELLET_RADIUS + PLAYER_RADIUS) {
          killPlayer(state, r, DEATH_CAUSE.PELLET, p.slot);
          consumed = true;
          break;
        }
      }
      if (consumed) break;
      const hitDot = state.dots.find((d) => dist(x, y, d.x, d.y) <= PELLET_RADIUS + DOT_RADIUS);
      if (hitDot) {
        killDots(state, p, [hitDot.id], hitDot.x, hitDot.y);
        consumed = true;
      }
    }
    if (consumed || x < 0 || x > ARENA || y < 0 || y > ARENA) continue;

    state.projs.push({
      id: state.nextProjId++, kind: KIND_PELLET, owner: p.slot,
      x, y, vx, vy, ttlMs: SCATTER.TTL_MS - steps * SIM_DT_MS, fireSeq: fs,
    });
  }
}

/** Densest 16 u grid cell of dots → its center, or null when no dots exist. */
function densestDotCluster(state) {
  if (!state.dots.length) return null;
  const buckets = new Map();
  for (const d of state.dots) {
    const key = `${Math.floor(d.x / CLUSTER_GRID_U)},${Math.floor(d.y / CLUSTER_GRID_U)}`;
    const b = buckets.get(key) || { n: 0, sx: 0, sy: 0 };
    b.n += 1; b.sx += d.x; b.sy += d.y;
    buckets.set(key, b);
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return { x: best.sx / best.n, y: best.sy / best.n };
}

function fireSeeker(state, p, fs) {
  state.events.push([EV.FIRE, p.slot, WEAPON_SEEKER, fs]);
  cullOldestProjectiles(state, SEEKER.MISSILES);

  let targetSlot = -1;
  let bestD = Infinity;
  for (const r of rivalsOf(state, p.slot)) {
    const dd = dist(p.x, p.y, r.x, r.y);
    if (dd < bestD) { bestD = dd; targetSlot = r.slot; }
  }
  const cluster = targetSlot < 0 ? densestDotCluster(state) : null;

  for (let i = 0; i < SEEKER.MISSILES; i++) {
    const a = p.angle + (i - (SEEKER.MISSILES - 1) / 2) * 0.45; // fan the salvo
    state.projs.push({
      id: state.nextProjId++, kind: KIND_MISSILE, owner: p.slot,
      x: p.x + Math.cos(a) * PLAYER_RADIUS,
      y: p.y + Math.sin(a) * PLAYER_RADIUS,
      vx: Math.cos(a) * SEEKER.SPEED,
      vy: Math.sin(a) * SEEKER.SPEED,
      ttlMs: SEEKER.TTL_MS, fireSeq: fs,
      targetSlot,
      tx: cluster ? cluster.x : p.x + Math.cos(p.angle) * WAVE.RADIUS,
      ty: cluster ? cluster.y : p.y + Math.sin(p.angle) * WAVE.RADIUS,
    });
  }
}

function resolveFires(state) {
  for (const p of state.players) {
    if (!p.alive || !p.fires.length) continue;
    if (state.timeMs < p.staggerUntilMs) { p.fires = []; continue; } // input frozen
    if (p.weapon === WEAPON_NONE) { p.fires = []; continue; }        // taps while unarmed
    // Cooldown gates the FIFO — at most one fire resolves per tick anyway
    // since firing pushes the cooldown timestamp forward.
    if (state.timeMs < p.cooldownUntilMs || p.ammo <= 0) continue;

    const { fs } = p.fires.shift();
    const spec = WEAPON_SPEC[p.weapon];
    p.ammo -= 1;
    p.cooldownUntilMs = state.timeMs + spec.COOLDOWN_MS;
    p.stats.shotsFired += 1;

    if (p.weapon === WEAPON_WAVE) fireWave(state, p);
    else if (p.weapon === WEAPON_SCATTER) fireScatter(state, p, fs);
    else fireSeeker(state, p, fs);

    if (p.ammo <= 0) { p.weapon = WEAPON_NONE; p.fires = []; }
  }
}

// ----------------------------------------------------------- projectiles ----

/** Seeker blast: kills dots, staggers (not kills) players caught in it. */
function blast(state, pr, directVictimSlot) {
  const owner = state.players[pr.owner];
  const killed = [];
  let cx = 0; let cy = 0;
  for (const d of state.dots) {
    if (dist(pr.x, pr.y, d.x, d.y) <= SEEKER.BLAST_RADIUS + DOT_RADIUS) {
      killed.push(d.id); cx += d.x; cy += d.y;
    }
  }
  if (killed.length && owner) killDots(state, owner, killed, cx / killed.length, cy / killed.length);
  for (const r of living(state)) {
    if (r.slot === pr.owner || r.slot === directVictimSlot) continue;
    if (dist(pr.x, pr.y, r.x, r.y) <= SEEKER.BLAST_RADIUS + PLAYER_RADIUS) {
      r.staggerUntilMs = state.timeMs + SEEKER.STAGGER_MS;
      state.events.push([EV.STAGGER, r.slot]);
    }
  }
}

function stepMissile(state, pr, dtSec) {
  // Track a live rival; retarget if they died; fall back to the frozen
  // cluster/waypoint so an expired target still produces a satisfying boom.
  if (pr.targetSlot >= 0) {
    const t = state.players[pr.targetSlot];
    if (t && t.alive) { pr.tx = t.x; pr.ty = t.y; }
    else {
      pr.targetSlot = -1;
      const rs = rivalsOf(state, pr.owner);
      if (rs.length) pr.targetSlot = rs.reduce((a, b) =>
        (dist(pr.x, pr.y, b.x, b.y) < dist(pr.x, pr.y, a.x, a.y) ? b : a)).slot;
    }
  }
  const cur = Math.atan2(pr.vy, pr.vx);
  const want = Math.atan2(pr.ty - pr.y, pr.tx - pr.x);
  const turn = clamp(angleDiff(cur, want), -SEEKER.TURN_RAD_PER_S * dtSec, SEEKER.TURN_RAD_PER_S * dtSec);
  pr.vx = Math.cos(cur + turn) * SEEKER.SPEED;
  pr.vy = Math.sin(cur + turn) * SEEKER.SPEED;
  pr.x += pr.vx * dtSec;
  pr.y += pr.vy * dtSec;

  for (const r of living(state)) {
    if (r.slot === pr.owner) continue;
    if (dist(pr.x, pr.y, r.x, r.y) <= MISSILE_RADIUS + PLAYER_RADIUS) {
      killPlayer(state, r, DEATH_CAUSE.MISSILE, pr.owner); // direct hit kills
      blast(state, pr, r.slot);                            // splash staggers the rest
      return false;
    }
  }
  if (pr.targetSlot < 0 && dist(pr.x, pr.y, pr.tx, pr.ty) <= MISSILE_ARRIVE_U) {
    blast(state, pr, -1);
    return false;
  }
  if (pr.ttlMs <= 0) {
    // Expiry near the target still detonates (feels earned); a missile that
    // fizzles far away just disappears — no free area denial.
    if (dist(pr.x, pr.y, pr.tx, pr.ty) <= 2 * SEEKER.BLAST_RADIUS) blast(state, pr, -1);
    return false;
  }
  return pr.x >= 0 && pr.x <= ARENA && pr.y >= 0 && pr.y <= ARENA;
}

function stepPellet(state, pr, dtSec) {
  pr.x += pr.vx * dtSec;
  pr.y += pr.vy * dtSec;
  if (pr.ttlMs <= 0 || pr.x < 0 || pr.x > ARENA || pr.y < 0 || pr.y > ARENA) return false;
  // In-flight hits use current positions — the spawn-window trace already
  // covered the shooter's lag; double-compensating would favor the shooter.
  const owner = state.players[pr.owner];
  const hitDot = state.dots.find((d) => dist(pr.x, pr.y, d.x, d.y) <= PELLET_RADIUS + DOT_RADIUS);
  if (hitDot) {
    if (owner) killDots(state, owner, [hitDot.id], hitDot.x, hitDot.y);
    else removeDotIds(state, [hitDot.id]);
    return false;
  }
  for (const r of living(state)) {
    if (r.slot === pr.owner) continue;
    if (dist(pr.x, pr.y, r.x, r.y) <= PELLET_RADIUS + PLAYER_RADIUS) {
      killPlayer(state, r, DEATH_CAUSE.PELLET, pr.owner);
      return false;
    }
  }
  return true;
}

function stepProjectiles(state, dtMs) {
  const dtSec = dtMs / 1000;
  const keep = [];
  for (const pr of state.projs) {
    pr.ttlMs -= dtMs;
    const alive = pr.kind === KIND_MISSILE
      ? stepMissile(state, pr, dtSec)
      : stepPellet(state, pr, dtSec);
    if (alive) keep.push(pr);
  }
  state.projs = keep;
}

/** One sim step of the weapon layer: orbs → queued fires → projectiles. */
export function step(state, dtMs) {
  stepOrbs(state);
  resolveFires(state);
  stepProjectiles(state, dtMs);
}
