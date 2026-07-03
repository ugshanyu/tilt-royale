// Snapshot/delta frame builders — the only place sim state meets the wire.
//
// Format per PROTOCOL.md: keyframes carry full dot membership (id-sorted
// parallel arrays); deltas carry rm/add membership changes plus positions
// for all alive dots. Players are always full rows (≤ 4 rows is cheaper
// than diffing); projectiles and orbs are full lists (bounded by
// MAX_PROJECTILES / MAX_ORBS). The serialized frame is asserted against
// SNAPSHOT_MAX_BYTES — sim-side caps make a breach unreachable, so this is
// a tripwire, not a load-bearing mechanism.
import { SNAPSHOT_MAX_BYTES, ROUND_MS } from '../../shared/constants.js';
import {
  encodePlayerRow, encodeDotsKeyframe, encodeDotsDelta,
  encodeProjRow, encodeOrbRow,
} from '../../shared/wire.js';
import { removeDotIds, MODE_HUNTER } from '../game/dots.js';
import { isShielded, isStaggered } from '../game/sim.js';

/** Fraction of dots dropped per emergency cull pass. */
const EMERGENCY_CULL_FRACTION = 0.25;

function encodePlayers(state) {
  return state.players.map((p) => encodePlayerRow({
    slot: p.slot, x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle,
    alive: p.alive,
    shield: isShielded(state, p),
    stagger: isStaggered(state, p),
    connected: p.connected,
    weapon: p.weapon, ammo: p.ammo, score: p.score,
    // Effective chain: an expired window reads as 0 so the HUD never shows a
    // stale multiplier between kills.
    chain: state.timeMs <= p.chainUntilMs ? p.chain : 0,
  }));
}

function framePayload(state, meta, keyframe, events) {
  const payload = {
    s: meta.s,
    server_ts: meta.serverTs,
    server_tick: meta.serverTick,
    phase: meta.phase,
    remaining_ms: state.started ? Math.round(state.remainingMs) : ROUND_MS,
    ack: meta.ack,
    players: encodePlayers(state),
    dots: keyframe
      ? encodeDotsKeyframe(state.dots)
      : encodeDotsDelta(state.dots, state.dotRm, state.dotAdd),
    projs: state.projs.map(encodeProjRow),
    orbs: state.orbs.map(encodeOrbRow),
    events,
  };
  if (keyframe) payload.k = true;
  return payload;
}

/**
 * Build one net frame and its serialized form.
 *
 * @param {object} state sim state
 * @param {{s:number, serverTs:number, serverTick:number, phase:string,
 *          ack:Object<string,number>}} meta header fields (s is monotonic
 *          across keyframes AND deltas — receivers drop stale s)
 * @param {{keyframe?:boolean, consume?:boolean}} [opts]
 *   keyframe — full dot membership vs rm/add delta.
 *   consume — drain the event queue and reset dot delta tracking. True for
 *   the broadcast stream; FALSE for unicast resync keyframes, which must not
 *   steal events or membership diffs from receivers of the next broadcast
 *   delta.
 * @returns {{ type:'state_snapshot'|'state_delta', payload:object, json:string }}
 */
export function buildFrame(state, meta, { keyframe = false, consume = true } = {}) {
  const events = consume ? state.events.splice(0, state.events.length) : [];
  const type = keyframe ? 'state_snapshot' : 'state_delta';

  let payload = framePayload(state, meta, keyframe, events);
  let json = JSON.stringify({ type, payload });

  if (json.length > SNAPSHOT_MAX_BYTES) {
    // Tripwire: sim caps (MAX_DOTS/MAX_PROJECTILES/event dedup) should make
    // this unreachable. If it fires anyway, shed the oldest hunters (least
    // choreographed, least missed) through the normal removal path so delta
    // receivers stay consistent, and rebuild ONCE.
    const hunters = state.dots.filter((d) => d.mode === MODE_HUNTER);
    const cullCount = Math.max(1, Math.floor(state.dots.length * EMERGENCY_CULL_FRACTION));
    const cullIds = hunters.slice(0, cullCount).map((d) => d.id);
    console.error(
      `[SNAPSHOT] size breach ${json.length}B > ${SNAPSHOT_MAX_BYTES}B ` +
      `(dots=${state.dots.length} projs=${state.projs.length} events=${events.length}) — ` +
      `emergency-culling ${cullIds.length} oldest hunter dots`
    );
    if (cullIds.length) {
      removeDotIds(state, cullIds);
      payload = framePayload(state, meta, keyframe, events);
      json = JSON.stringify({ type, payload });
    }
  }

  if (consume) {
    // A consumed frame resets membership tracking: a keyframe re-lists all
    // ids anyway, and a delta has just shipped the diffs.
    state.dotRm = [];
    state.dotAdd = [];
  }
  return { type, payload, json };
}
