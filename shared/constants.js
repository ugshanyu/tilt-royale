// Every gameplay + netcode number lives here — single source of truth for
// server sim AND client prediction. Native ESM, imported by both runtimes.
// If you tune game feel, tune it here; modules must not carry magic numbers.

// ---------------------------------------------------------------- arena ----
export const ARENA = 120;              // world units, square, fixed screen
export const PLAYER_RADIUS = 1.6;
export const DOT_RADIUS = 0.9;
export const ORB_RADIUS = 2.6;
export const PELLET_RADIUS = 0.6;
export const MISSILE_RADIUS = 0.8;
// Dot-kills-player circle gets a forgiveness factor — tight hitboxes are what
// make "one more dodge" feel fair (Tilt to Live rule).
export const KILL_CIRCLE_FACTOR = 0.75;

// ------------------------------------------------------------- movement ----
export const ACCEL = 90;               // u/s^2 at full tilt
export const DRAG = 2.6;               // exponential drag, /s
export const MAX_SPEED = 40;           // u/s hard cap
export const FACING_MIN_SPEED = 1.5;   // below this, keep last facing
export const STATE_PRECISION = 1e4;    // shared rounding: 1e-4 units

// ---------------------------------------------------------------- round ----
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const ROUND_MS = 150_000;       // 150 s hard cap
export const COUNTDOWN_MS = 3_000;
export const AUTO_START_MS = 10_000;   // waiting room arms auto-start at >= MIN_PLAYERS
export const SPAWN_SHIELD_MS = 1_500;  // dot-immunity after countdown (not weapon-immunity)
export const NO_DOTS_AT_START_MS = 2_000;
export const RESULTS_LINGER_MS = 30_000; // keep sockets open for results screen

// ----------------------------------------------------------------- dots ----
export const MAX_DOTS = 220;           // HARD cap — snapshot-size constraint (R1), not CPU
export const DOT_SPEED_MIN = 9;        // u/s at round start
export const DOT_SPEED_MAX = 16;       // u/s in sudden death
export const DOT_TELEGRAPH_MS = 1_000; // harmless ghost before a dot goes live
export const DOT_EDGE_BAND = 2;        // spawn band width along arena edges
export const CORPSE_CLEAR_RADIUS = 8;  // dots vaporized around a death (mercy VFX)
// Difficulty ramp phases: [untilMs, ambientDotsPerSec, formationEveryMs]
export const DOT_PHASES = [
  [15_000, 2, 0],        // warmup — no formations
  [60_000, 4, 12_000],   // build
  [120_000, 6, 8_000],   // pressure
  [150_000, 10, 5_000],  // sudden death
];

// -------------------------------------------------------------- weapons ----
// Weapon ids double as orb types on the wire. 0 = unarmed.
export const WEAPON_NONE = 0;
export const WEAPON_WAVE = 1;          // W1 Shockwave  — hitscan arc (lag-compensated)
export const WEAPON_SCATTER = 2;       // W2 Scatter    — predicted ballistic pellets
export const WEAPON_SEEKER = 3;        // W3 Seeker     — server-steered homing (not predicted)

export const WAVE = {
  ARC_RAD: (120 * Math.PI) / 180,      // 120° centered on facing
  RADIUS: 34,
  KILL_RADIUS: 22,                     // players die inside this; knockback beyond
  KNOCKBACK: 30,                       // impulse u/s applied outward
  AMMO: 3,
  COOLDOWN_MS: 900,
};
export const SCATTER = {
  PELLETS: 5,
  FAN_RAD: (30 * Math.PI) / 180,
  SPEED: 65,
  TTL_MS: 700,
  AMMO: 8,                             // bursts
  COOLDOWN_MS: 250,
};
export const SEEKER = {
  MISSILES: 3,
  SPEED: 40,
  TURN_RAD_PER_S: (240 * Math.PI) / 180,
  TTL_MS: 2_500,
  BLAST_RADIUS: 6,
  STAGGER_MS: 500,                     // blast (non-direct) freezes rival input
  AMMO: 2,                             // salvos
  COOLDOWN_MS: 1_200,
};
export const MAX_PROJECTILES = 48;     // wire + sim cap

// ----------------------------------------------------------------- orbs ----
export const ORB_SPAWN_EVERY_MS = 7_000;
export const MAX_ORBS = 3;
export const ORB_MIN_PLAYER_DIST = 20;

// ---------------------------------------------------------------- score ----
export const SCORE_DOT_KILL = 10;      // × chain
export const SCORE_PLAYER_KILL = 500;
export const SCORE_SURVIVE_PER_SEC = 5;
export const CHAIN_WINDOW_MS = 1_000;
export const CHAIN_CAP = 10;

// -------------------------------------------------------------- netcode ----
export const SIM_HZ = 60;
export const SIM_DT_MS = 1000 / SIM_HZ;
export const NET_EVERY_SIM_TICKS = 3;  // → 20 Hz snapshots
export const KEYFRAME_EVERY_NET_TICKS = 20; // → full keyframe every 1 s
export const INPUT_HZ = 30;            // client send rate (SDK Coalescer)
export const INPUT_HZ_DEGRADED = 20;   // when RTT > 250 ms
export const POS_QUANT = 0.25;         // wire position cell, world units
export const VEL_QUANT = 0.1;          // wire velocity cell
export const ANGLE_QUANT = 0.01;       // wire angle cell, radians
export const SNAPSHOT_MAX_BYTES = 7_500; // serializer tripwire (< platform 8192 cap)
export const DOT_POS_DIVISOR = 1;      // 2 → dot positions every other net tick (bandwidth fallback)
export const MAX_REWIND_MS = 250;      // lag-compensation cap (Valve-style)
export const LAGCOMP_HISTORY_MS = 500;
export const DESYNC_SNAP_UNITS = 12;   // predictor hard-snap threshold
export const INPUT_RATE_LIMIT_PER_S = 60; // matches registry rate_limits.input_per_sec
export const SESSION_SILENT_TIMEOUT_MS = 45_000;
export const LONE_PLAYER_END_MS = 20_000; // all-but-one disconnected this long → early end
