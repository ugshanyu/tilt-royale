// The Dot Director: ambient pressure + choreographed formations.
//
// Dots are the antagonist. Ambient hunters seep in from the edges at a rate
// set by DOT_PHASES; formations are scripted set-pieces that convert into
// ordinary hunters when their script completes. Every spawn is telegraphed:
// a 'tg' event fires immediately (client renders a 1 s ghost) and the dot
// only becomes lethal DOT_TELEGRAPH_MS later — surprise deaths from
// offscreen spawns are what make tilt games feel unfair, so we never allow
// them. Pure state mutation, no I/O.
import {
  ARENA, DOT_RADIUS, DOT_SPEED_MIN, DOT_SPEED_MAX, DOT_TELEGRAPH_MS,
  DOT_EDGE_BAND, DOT_PHASES, MAX_DOTS, ROUND_MS, NO_DOTS_AT_START_MS,
} from '../../shared/constants.js';
import { EV, qPos } from '../../shared/wire.js';
import { nextRand, angleDiff, dist, clamp } from './util.js';

export const MODE_HUNTER = 0;
export const MODE_WALL = 1;
export const MODE_RING = 2;
export const MODE_WEDGE = 3;
export const MODE_PINWHEEL = 4;

// Formation tuning. These are server-only choreography numbers (the client
// never needs them), which is why they live here and not in shared/constants.
const HUNTER_NOISE_AMP = 0.55;        // rad of sinusoidal heading wobble
const WALL_DOTS = 34;
const WALL_GAP_U = 8;                 // two survivable gaps in the wall
const RING_DOTS = 28;
const RING_RADIUS = 30;
const RING_CONTRACT_PER_S = 6;
const RING_RELEASE_RADIUS = 6;        // ring converts to hunters here
const WEDGE_DOTS = 15;                // 1 apex + 2 legs of 7
const WEDGE_HOMING_MS = 2_000;        // homes on the leader, then locks heading
const WEDGE_TURN_RAD_PER_S = 2.1;     // gentle: keeps the V shape coherent
const WEDGE_SPEED_MULT = 1.35;        // charges faster than ambient hunters
const PINWHEEL_ARMS = 4;
const PINWHEEL_DOTS_PER_ARM = 10;
const PINWHEEL_OMEGA = (40 * Math.PI) / 180; // rad/s arm rotation
const PINWHEEL_ARM_BASE = 4;          // u from center to first dot
const PINWHEEL_ARM_STEP = 3;          // u between dots on an arm
const PINWHEEL_DRIFT_PER_S = 3;       // center drift speed
const PINWHEEL_MAX_MS = 12_000;       // safety release even if still in-bounds

const LO = DOT_RADIUS;
const HI = ARENA - DOT_RADIUS;
const clampArena = (v) => clamp(v, LO, HI);

/** Hunter speed ramps linearly over the round (warmup → sudden death). */
export function dotSpeed(state) {
  const t = clamp(state.timeMs / ROUND_MS, 0, 1);
  return DOT_SPEED_MIN + (DOT_SPEED_MAX - DOT_SPEED_MIN) * t;
}

/** Current difficulty phase row: [untilMs, ambientPerSec, formationEveryMs]. */
function phaseRow(timeMs) {
  for (const row of DOT_PHASES) if (timeMs < row[0]) return row;
  return DOT_PHASES[DOT_PHASES.length - 1];
}

/**
 * Queue a telegraphed dot. Emits the 'tg' event now; the dot goes live after
 * DOT_TELEGRAPH_MS. Budget-checked against MAX_DOTS (live + pending) — the
 * excess is dropped, keeping the snapshot-size invariant enforceable at the
 * source instead of at the serializer.
 * @returns {boolean} true if queued
 */
export function telegraphDot(state, fields) {
  if (state.dots.length + state.pendingDots.length >= MAX_DOTS) return false;
  const x = clampArena(fields.x);
  const y = clampArena(fields.y);
  state.pendingDots.push({ ...fields, x, y, goLiveAtMs: state.timeMs + DOT_TELEGRAPH_MS });
  state.events.push([EV.TELEGRAPH, qPos(x), qPos(y)]);
  return true;
}

/** Insert a live dot (id allocated here — monotonic, so dots stay id-sorted). */
function goLive(state, pending) {
  const { goLiveAtMs, ...fields } = pending;
  const dot = { id: state.nextDotId++, ...fields };
  state.dots.push(dot);
  // Delta tracking: receivers learn membership from add/rm since last frame.
  state.dotAdd.push({ id: dot.id, x: dot.x, y: dot.y });
  return dot;
}

/**
 * Remove dots by id (killed by weapons, corpse-cleared, emergency-culled).
 * Reconciles with delta tracking: a dot that spawned and died within the
 * same net tick is scrubbed from `add` instead of appearing in `rm` — the
 * receiver applies rm before add, so advertising both would resurrect it.
 * @param {object} state @param {number[]} ids
 */
export function removeDotIds(state, ids) {
  if (!ids.length) return;
  const rm = new Set(ids);
  state.dots = state.dots.filter((d) => !rm.has(d.id));
  const advertised = new Set(state.dotAdd.map((a) => a.id));
  for (const id of ids) {
    if (advertised.has(id)) {
      state.dotAdd = state.dotAdd.filter((a) => a.id !== id);
    } else {
      state.dotRm.push(id);
    }
  }
}

function hunterFields(state, x, y) {
  return {
    mode: MODE_HUNTER, x, y,
    // Per-dot heading noise: deterministic sinusoid parameters drawn from the
    // room RNG. Stored as plain numbers (not a generator) so state stays
    // serializable and replays stay bit-identical.
    noiseF: 0.8 + nextRand(state) * 1.6,       // wobble frequency, rad/s
    noiseP: nextRand(state) * Math.PI * 2,     // phase offset
  };
}

function convertToHunter(state, d) {
  const h = hunterFields(state, d.x, d.y);
  d.mode = MODE_HUNTER;
  d.noiseF = h.noiseF;
  d.noiseP = h.noiseP;
}

/** Point on a random arena edge, inside the spawn band. */
function edgePoint(state) {
  const edge = Math.floor(nextRand(state) * 4);
  const along = LO + nextRand(state) * (HI - LO);
  const depth = LO + nextRand(state) * DOT_EDGE_BAND;
  if (edge === 0) return { x: along, y: depth };
  if (edge === 1) return { x: along, y: ARENA - depth };
  if (edge === 2) return { x: depth, y: along };
  return { x: ARENA - depth, y: along };
}

const livingPlayers = (state) => state.players.filter((p) => p.alive);

// ------------------------------------------------------------ formations ----

function spawnWall(state) {
  // A line sweeping in from one edge, with two 8 u gaps to dodge through.
  const edge = Math.floor(nextRand(state) * 4);
  const speed = dotSpeed(state);
  const gap1 = nextRand(state) * (ARENA - WALL_GAP_U);
  let gap2 = nextRand(state) * (ARENA - WALL_GAP_U);
  if (Math.abs(gap2 - gap1) < WALL_GAP_U) gap2 = (gap1 + ARENA / 2) % (ARENA - WALL_GAP_U);
  const inGap = (c) => (c >= gap1 && c <= gap1 + WALL_GAP_U) || (c >= gap2 && c <= gap2 + WALL_GAP_U);

  for (let i = 0; i < WALL_DOTS; i++) {
    const c = ((i + 0.5) * ARENA) / WALL_DOTS;
    if (inGap(c)) continue;
    let f;
    if (edge === 0) f = { x: c, y: LO, vx: 0, vy: speed };
    else if (edge === 1) f = { x: c, y: HI, vx: 0, vy: -speed };
    else if (edge === 2) f = { x: LO, y: c, vx: speed, vy: 0 };
    else f = { x: HI, y: c, vx: -speed, vy: 0 };
    telegraphDot(state, { mode: MODE_WALL, ...f });
  }
}

function spawnRing(state, director) {
  // Contracting circle around one player, chosen round-robin so pressure is
  // shared — always targeting the leader would snowball eliminations.
  const living = livingPlayers(state);
  if (!living.length) return;
  const target = living[director.ringRR++ % living.length];
  for (let i = 0; i < RING_DOTS; i++) {
    const a = (i * 2 * Math.PI) / RING_DOTS;
    telegraphDot(state, {
      mode: MODE_RING,
      x: target.x + Math.cos(a) * RING_RADIUS,
      y: target.y + Math.sin(a) * RING_RADIUS,
      targetSlot: target.slot, ringAngle: a, ringR: RING_RADIUS,
    });
  }
}

function spawnWedge(state) {
  // V formation that hunts the score leader for 2 s, then commits to a
  // straight charge. Each dot homes individually with a capped turn rate —
  // cheaper and flatter than shared group state, and the identical initial
  // headings + gentle cap keep the V visually coherent.
  const living = livingPlayers(state);
  if (!living.length) return;
  const leader = living.reduce((a, b) => (b.score > a.score ? b : a));
  const apex = edgePoint(state);
  const heading = Math.atan2(leader.y - apex.y, leader.x - apex.x);
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  const px = -hy; // perpendicular (leg spread)
  const py = hx;
  for (let i = 0; i < WEDGE_DOTS; i++) {
    const leg = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1);
    const k = Math.ceil(i / 2);
    telegraphDot(state, {
      mode: MODE_WEDGE,
      x: apex.x - hx * k * 2.2 + px * leg * k * 1.8,
      y: apex.y - hy * k * 2.2 + py * leg * k * 1.8,
      hx, hy, homingUntilMs: state.timeMs + DOT_TELEGRAPH_MS + WEDGE_HOMING_MS,
    });
  }
}

function spawnPinwheel(state) {
  // Four rotating arms whose center drifts — positions are a closed-form
  // function of time (no per-dot integration), so 40 dots cost almost
  // nothing and the whole formation stays perfectly rigid.
  const driftA = nextRand(state) * Math.PI * 2;
  const base = {
    mode: MODE_PINWHEEL,
    cx0: ARENA / 2, cy0: ARENA / 2,
    cvx: Math.cos(driftA) * PINWHEEL_DRIFT_PER_S,
    cvy: Math.sin(driftA) * PINWHEEL_DRIFT_PER_S,
    bornMs: state.timeMs + DOT_TELEGRAPH_MS,
  };
  for (let arm = 0; arm < PINWHEEL_ARMS; arm++) {
    for (let k = 0; k < PINWHEEL_DOTS_PER_ARM; k++) {
      const r = PINWHEEL_ARM_BASE + k * PINWHEEL_ARM_STEP;
      const a = (arm * 2 * Math.PI) / PINWHEEL_ARMS;
      telegraphDot(state, {
        ...base, arm, armDist: r,
        x: base.cx0 + Math.cos(a) * r,
        y: base.cy0 + Math.sin(a) * r,
      });
    }
  }
}

const FORMATIONS = [spawnWall, spawnRing, spawnWedge, spawnPinwheel];

/** Spawn one formation by index (round-robin from the director; direct in tests). */
export function spawnFormation(state, idx) {
  FORMATIONS[idx % FORMATIONS.length](state, state.director);
}

// -------------------------------------------------------------- stepping ----

function moveDot(state, d, dtSec) {
  const speed = dotSpeed(state);
  if (d.mode === MODE_HUNTER) {
    const living = livingPlayers(state);
    if (!living.length) return;
    let best = living[0];
    let bestD = Infinity;
    for (const p of living) {
      const dd = dist(p.x, p.y, d.x, d.y);
      if (dd < bestD) { bestD = dd; best = p; }
    }
    const noise = Math.sin((state.timeMs / 1000) * d.noiseF + d.noiseP) * HUNTER_NOISE_AMP;
    const a = Math.atan2(best.y - d.y, best.x - d.x) + noise;
    d.x = clampArena(d.x + Math.cos(a) * speed * dtSec);
    d.y = clampArena(d.y + Math.sin(a) * speed * dtSec);
    return;
  }

  if (d.mode === MODE_WALL) {
    d.x += d.vx * dtSec;
    d.y += d.vy * dtSec;
    // Script complete: reached the far side → hunt.
    if (d.x <= LO || d.x >= HI || d.y <= LO || d.y >= HI) {
      d.x = clampArena(d.x); d.y = clampArena(d.y);
      if ((d.vx > 0 && d.x >= HI) || (d.vx < 0 && d.x <= LO) ||
          (d.vy > 0 && d.y >= HI) || (d.vy < 0 && d.y <= LO)) {
        convertToHunter(state, d);
      }
    }
    return;
  }

  if (d.mode === MODE_RING) {
    const target = state.players[d.targetSlot];
    if (!target || !target.alive) { convertToHunter(state, d); return; }
    d.ringR -= RING_CONTRACT_PER_S * dtSec;
    if (d.ringR <= RING_RELEASE_RADIUS) { convertToHunter(state, d); return; }
    d.x = clampArena(target.x + Math.cos(d.ringAngle) * d.ringR);
    d.y = clampArena(target.y + Math.sin(d.ringAngle) * d.ringR);
    return;
  }

  if (d.mode === MODE_WEDGE) {
    if (state.timeMs < d.homingUntilMs) {
      const living = livingPlayers(state);
      if (living.length) {
        const leader = living.reduce((a, b) => (b.score > a.score ? b : a));
        const cur = Math.atan2(d.hy, d.hx);
        const want = Math.atan2(leader.y - d.y, leader.x - d.x);
        const turn = clamp(angleDiff(cur, want), -WEDGE_TURN_RAD_PER_S * dtSec, WEDGE_TURN_RAD_PER_S * dtSec);
        d.hx = Math.cos(cur + turn);
        d.hy = Math.sin(cur + turn);
      }
    }
    const sp = speed * WEDGE_SPEED_MULT;
    d.x += d.hx * sp * dtSec;
    d.y += d.hy * sp * dtSec;
    if (d.x <= LO || d.x >= HI || d.y <= LO || d.y >= HI) {
      d.x = clampArena(d.x); d.y = clampArena(d.y);
      if (state.timeMs >= d.homingUntilMs) convertToHunter(state, d); // charge spent
    }
    return;
  }

  // MODE_PINWHEEL — closed-form pose from formation birth time.
  const t = (state.timeMs - d.bornMs) / 1000;
  const cx = d.cx0 + d.cvx * t;
  const cy = d.cy0 + d.cvy * t;
  const a = (d.arm * 2 * Math.PI) / PINWHEEL_ARMS + PINWHEEL_OMEGA * t;
  const x = cx + Math.cos(a) * d.armDist;
  const y = cy + Math.sin(a) * d.armDist;
  if (x < LO || x > HI || y < LO || y > HI || state.timeMs - d.bornMs > PINWHEEL_MAX_MS) {
    d.x = clampArena(x); d.y = clampArena(y);
    convertToHunter(state, d);
    return;
  }
  d.x = x; d.y = y;
}

/**
 * One sim step of the director + all dots: spawn ambient/formation
 * telegraphs, promote due telegraphs to live dots, move everything.
 */
export function step(state, dtMs) {
  const dtSec = dtMs / 1000;
  const dir = state.director;
  const [, ambientPerSec, formationEveryMs] = phaseRow(state.timeMs);

  // Ambient spawner — accumulator so fractional rates work at any dt.
  if (state.timeMs >= NO_DOTS_AT_START_MS) {
    dir.ambientAcc += ambientPerSec * dtSec;
    while (dir.ambientAcc >= 1) {
      dir.ambientAcc -= 1;
      const p = edgePoint(state);
      telegraphDot(state, hunterFields(state, p.x, p.y));
    }
  }

  // Formation cadence. Warmup (everyMs=0) keeps pushing the clock forward so
  // the first formation lands exactly when the phase allows it.
  if (formationEveryMs === 0) {
    dir.nextFormationAtMs = state.timeMs + 1;
  } else if (state.timeMs >= dir.nextFormationAtMs) {
    spawnFormation(state, dir.formationIdx++);
    dir.nextFormationAtMs = state.timeMs + formationEveryMs;
  }

  // Promote due telegraphs (FIFO keeps id allocation monotonic).
  while (state.pendingDots.length && state.pendingDots[0].goLiveAtMs <= state.timeMs) {
    goLive(state, state.pendingDots.shift());
  }

  for (const d of state.dots) moveDot(state, d, dtSec);
}
