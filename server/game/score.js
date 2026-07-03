// Scoring, chains, death bookkeeping, and the end-of-match builders.
// Pure state mutation — no I/O. Every score-affecting rule lives here so the
// wire (snapshot.js) and the results webhook read one consistent source.
import {
  SCORE_DOT_KILL, SCORE_PLAYER_KILL, SCORE_SURVIVE_PER_SEC,
  CHAIN_WINDOW_MS, CHAIN_CAP, CORPSE_CLEAR_RADIUS, ROUND_MS,
} from '../../shared/constants.js';
import { EV, DEATH_CAUSE_NAMES } from '../../shared/wire.js';
import { removeDotIds } from './dots.js';
import { dist } from './util.js';

/**
 * Award `n` dot kills to a player, advancing the chain per kill:
 * kill k inside the window scores SCORE_DOT_KILL * chain (10, 20, 30, …
 * capped at CHAIN_CAP). Caller emits the positional 'dk' event — stats and
 * 'dk' event counts must stay 1:1 (asserted by the round-invariant test).
 * @param {object} state @param {object} p killer @param {number} n dots killed
 */
export function awardDotKills(state, p, n) {
  for (let i = 0; i < n; i++) {
    if (state.timeMs > p.chainUntilMs) p.chain = 0;
    p.chain = Math.min(p.chain + 1, CHAIN_CAP);
    p.chainUntilMs = state.timeMs + CHAIN_WINDOW_MS;
    p.score += SCORE_DOT_KILL * p.chain;
    p.stats.dotKills += 1;
    if (p.chain > p.bestCombo) p.bestCombo = p.chain;
    // Milestone events only (5 and cap) — a 30-dot wave would otherwise spam
    // one 'cb' per kill and waste snapshot bytes on redundant VFX triggers.
    if (p.chain === 5 || p.chain === CHAIN_CAP) {
      state.events.push([EV.COMBO, p.slot, p.chain]);
    }
  }
}

/**
 * Kill a player: record cause, vaporize nearby dots (mercy VFX — unscored,
 * so 'dk' events keep matching dot_kills stats), emit 'de', credit the
 * killer. Dead players become spectators client-side; the slot stays.
 * @param {object} state @param {object} victim
 * @param {number} cause DEATH_CAUSE.* code
 * @param {number} killerSlot slot of the killer, or -1 for environment (dots)
 */
export function killPlayer(state, victim, cause, killerSlot = -1) {
  if (!victim.alive) return;
  victim.alive = false;
  victim.deathCause = cause;
  victim.diedAtMs = state.timeMs;
  victim.vx = 0; victim.vy = 0;
  victim.input = { mx: 0, my: 0 };
  victim.fires = [];
  victim.weapon = 0; victim.ammo = 0;

  const cleared = [];
  for (const d of state.dots) {
    if (dist(d.x, d.y, victim.x, victim.y) <= CORPSE_CLEAR_RADIUS) cleared.push(d.id);
  }
  if (cleared.length) removeDotIds(state, cleared);

  state.events.push([EV.DEATH, victim.slot, cause, killerSlot]);

  if (killerSlot >= 0 && killerSlot !== victim.slot) {
    const killer = state.players[killerSlot];
    if (killer) {
      killer.score += SCORE_PLAYER_KILL;
      killer.stats.kills += 1;
    }
  }
}

/**
 * Survival accrual: +SCORE_SURVIVE_PER_SEC per second alive. Fractional
 * accumulator keeps wire scores integers without losing sub-tick remainder.
 */
export function accrueSurvival(state, dtMs) {
  for (const p of state.players) {
    if (!p.alive) continue;
    p.scoreFrac += (SCORE_SURVIVE_PER_SEC * dtMs) / 1000;
    const whole = Math.floor(p.scoreFrac);
    if (whole > 0) { p.score += whole; p.scoreFrac -= whole; }
  }
}

const survivalMs = (state, p) =>
  Math.round(p.alive ? Math.min(state.timeMs, ROUND_MS) : p.diedAtMs);

/** final_stats for the results webhook, keyed by user id (see PROTOCOL.md). */
export function buildFinalStats(state) {
  const out = {};
  for (const p of state.players) {
    out[p.userId] = {
      slot: p.slot,
      score: p.score,
      kills: p.stats.kills,
      dot_kills: p.stats.dotKills,
      pickups: p.stats.pickups,
      survival_ms: survivalMs(state, p),
      best_combo: p.bestCombo,
      shots_fired: p.stats.shotsFired,
      death_cause: p.deathCause == null ? null : DEATH_CAUSE_NAMES[p.deathCause],
    };
  }
  return out;
}

/**
 * Placements for match_end: winners first (in the order the terminal check
 * ranked them), everyone else by score, then by how long they survived.
 * @param {object} state @param {number[]} winnerSlots
 */
export function buildPlacements(state, winnerSlots) {
  const winnerRank = new Map(winnerSlots.map((s, i) => [s, i]));
  const rows = state.players.map((p) => ({
    slot: p.slot,
    user_id: p.userId,
    name: p.name,
    score: p.score,
    kills: p.stats.kills,
    dot_kills: p.stats.dotKills,
    survival_ms: survivalMs(state, p),
    best_combo: p.bestCombo,
  }));
  rows.sort((a, b) => {
    const wa = winnerRank.has(a.slot) ? winnerRank.get(a.slot) : Infinity;
    const wb = winnerRank.has(b.slot) ? winnerRank.get(b.slot) : Infinity;
    if (wa !== wb) return wa - wb;
    if (a.score !== b.score) return b.score - a.score;
    return b.survival_ms - a.survival_ms;
  });
  return rows;
}
