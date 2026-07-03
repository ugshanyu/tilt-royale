// Deterministic sim tests — no sockets, no timers, no I/O. The sim's only
// randomness is seeded (see server/game/util.js nextRand), so full rounds
// replay bit-identically and can run at thousands of ticks per second.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARENA, DOT_RADIUS, MAX_DOTS, ROUND_MS, SIM_DT_MS, CHAIN_WINDOW_MS, CHAIN_CAP,
  SCORE_DOT_KILL, MIN_PLAYERS, SPAWN_SHIELD_MS,
} from '../shared/constants.js';
import { stepPlayer } from '../shared/movement.js';
import { EV, DEATH_CAUSE } from '../shared/wire.js';
import * as sim from '../server/game/sim.js';
import { spawnFormation, telegraphDot, MODE_HUNTER } from '../server/game/dots.js';
import { awardDotKills, buildPlacements, buildFinalStats } from '../server/game/score.js';

const DT = SIM_DT_MS;

function makeState({ seed = 1234, playerCount = 2 } = {}) {
  const state = sim.createState({ seed });
  for (let i = 0; i < playerCount; i++) {
    sim.addPlayer(state, { slot: i, userId: `u${i}`, name: `P${i}` });
  }
  return state;
}

/** Deterministic scripted tilt per slot/tick — loosely circling motion. */
function scriptedInput(slot, tick) {
  const w = 40 + slot * 9;
  return {
    mx: Math.sin(tick / w + slot),
    my: Math.cos(tick / (w + 5) + slot * 2),
  };
}

test('stepPlayer replay parity: same input sequence → identical states', () => {
  const run = () => {
    let p = { x: 30, y: 30, vx: 0, vy: 0, angle: 0 };
    const trace = [];
    for (let t = 0; t < 600; t++) {
      p = stepPlayer(p, scriptedInput(0, t), DT / 1000);
      trace.push({ ...p });
    }
    return trace;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  // And the shared clamps held throughout.
  for (const s of a) {
    assert.ok(s.x >= 0 && s.x <= ARENA && s.y >= 0 && s.y <= ARENA);
  }
});

test('headless full round: terminates with valid winner, placements, stats invariants', () => {
  const state = makeState({ seed: 987, playerCount: 4 });
  sim.beginRound(state);

  const dkBySlot = [0, 0, 0, 0];
  const deadSlots = new Set();
  let nextFs = 1;
  const maxSteps = Math.ceil(ROUND_MS / DT) + 10;
  let steps = 0;

  for (; steps < maxSteps && !state.over; steps++) {
    for (const p of state.players) {
      if (!p.alive) continue;
      p.input = scriptedInput(p.slot, steps);
      if (p.weapon && steps % 40 === p.slot * 7) p.fires.push({ fs: nextFs++ });
    }
    sim.step(state, DT);
    // Drain events like the net layer would, tallying the invariants.
    for (const ev of state.events.splice(0)) {
      if (ev[0] === EV.DOT_KILLS) dkBySlot[ev[1]] += ev[2];
      if (ev[0] === EV.DEATH) deadSlots.add(ev[1]);
    }
  }

  assert.ok(state.over, `round did not terminate in ${maxSteps} steps`);
  assert.ok(['elimination', 'timeout'].includes(state.over.reason), state.over.reason);
  assert.ok(state.over.winnerSlots.length >= 1);
  for (const s of state.over.winnerSlots) assert.ok(s >= 0 && s < 4);

  const placements = buildPlacements(state, state.over.winnerSlots);
  assert.equal(placements.length, 4);
  assert.equal(placements[0].slot, state.over.winnerSlots[0], 'winner ranks first');

  const stats = buildFinalStats(state);
  for (const p of state.players) {
    const st = stats[p.userId];
    assert.ok(st.score >= 0, 'score >= 0');
    assert.equal(st.dot_kills, dkBySlot[p.slot], `dot_kills matches dk events for slot ${p.slot}`);
    assert.ok(st.survival_ms >= 0 && st.survival_ms <= ROUND_MS + DT);
    assert.ok(st.best_combo <= CHAIN_CAP);
    assert.equal(st.death_cause === null, p.alive, 'death_cause null iff alive');
    assert.equal(deadSlots.has(p.slot), !p.alive, 'de events match dead players');
  }
  // Dot budget held for the entire round.
  assert.ok(state.dots.length + state.pendingDots.length <= MAX_DOTS);
});

test('formations spawn within arena bounds and respect MAX_DOTS', () => {
  const state = makeState({ seed: 55, playerCount: 2 });
  sim.beginRound(state);

  for (let idx = 0; idx < 4; idx++) spawnFormation(state, idx);
  assert.ok(state.pendingDots.length > 0, 'formations queued telegraphs');
  for (const d of state.pendingDots) {
    assert.ok(d.x >= DOT_RADIUS && d.x <= ARENA - DOT_RADIUS, `x in bounds: ${d.x}`);
    assert.ok(d.y >= DOT_RADIUS && d.y <= ARENA - DOT_RADIUS, `y in bounds: ${d.y}`);
  }

  // Promote telegraphs and run the scripts for a while — every live dot must
  // stay inside the arena through movement and conversions.
  const ticks = Math.ceil(2000 / DT);
  for (let t = 0; t < ticks; t++) {
    sim.step(state, DT);
    state.events.length = 0;
    for (const d of state.dots) {
      assert.ok(d.x >= DOT_RADIUS - 1e-9 && d.x <= ARENA - DOT_RADIUS + 1e-9, `live x in bounds: ${d.x}`);
      assert.ok(d.y >= DOT_RADIUS - 1e-9 && d.y <= ARENA - DOT_RADIUS + 1e-9, `live y in bounds: ${d.y}`);
    }
  }

  // Hammer the budget: MAX_DOTS is a hard cap enforced at telegraph time.
  for (let i = 0; i < 30; i++) spawnFormation(state, i);
  for (let i = 0; i < 100; i++) telegraphDot(state, { mode: MODE_HUNTER, x: 60, y: 60, noiseF: 1, noiseP: 0 });
  assert.ok(
    state.dots.length + state.pendingDots.length <= MAX_DOTS,
    `budget held: ${state.dots.length}+${state.pendingDots.length} <= ${MAX_DOTS}`
  );
});

test('chain math: 3 kills inside the window score 10+20+30', () => {
  const state = makeState();
  sim.beginRound(state);
  const p = state.players[0];

  awardDotKills(state, p, 1);
  state.timeMs += CHAIN_WINDOW_MS / 4;
  awardDotKills(state, p, 1);
  state.timeMs += CHAIN_WINDOW_MS / 4;
  awardDotKills(state, p, 1);
  assert.equal(p.score, SCORE_DOT_KILL * (1 + 2 + 3));
  assert.equal(p.chain, 3);
  assert.equal(p.stats.dotKills, 3);
  assert.equal(p.bestCombo, 3);

  // Window expiry resets the chain: next kill is worth base value again.
  state.timeMs += CHAIN_WINDOW_MS + 1;
  awardDotKills(state, p, 1);
  assert.equal(p.score, SCORE_DOT_KILL * (1 + 2 + 3) + SCORE_DOT_KILL * 1);
  assert.equal(p.chain, 1);

  // Chain is capped.
  awardDotKills(state, p, CHAIN_CAP + 5);
  assert.equal(p.chain, CHAIN_CAP);
  assert.equal(p.bestCombo, CHAIN_CAP);
});

test('a dot kills an unshielded player; the spawn shield blocks it', () => {
  assert.ok(MIN_PLAYERS >= 2);

  // Unshielded: dot on top of player 0 → death by DOT, corpse-cleared dot.
  {
    const state = makeState({ seed: 7 });
    sim.beginRound(state);
    const p = state.players[0];
    p.shieldUntilMs = 0;
    state.dots.push({ id: state.nextDotId++, mode: MODE_HUNTER, x: p.x, y: p.y, noiseF: 1, noiseP: 0 });
    sim.step(state, DT);
    assert.equal(p.alive, false);
    assert.equal(p.deathCause, DEATH_CAUSE.DOT);
    assert.ok(state.events.some((e) => e[0] === EV.DEATH && e[1] === 0 && e[2] === DEATH_CAUSE.DOT));
    assert.equal(state.dots.length, 0, 'killer dot corpse-cleared');
    assert.deepEqual(state.over, { reason: 'elimination', winnerSlots: [1] });
  }

  // Shielded: same setup with the spawn shield active → survives.
  {
    const state = makeState({ seed: 7 });
    sim.beginRound(state);
    const p = state.players[0];
    assert.ok(p.shieldUntilMs === SPAWN_SHIELD_MS, 'beginRound grants the spawn shield');
    state.dots.push({ id: state.nextDotId++, mode: MODE_HUNTER, x: p.x, y: p.y, noiseF: 1, noiseP: 0 });
    sim.step(state, DT);
    assert.equal(p.alive, true, 'shielded player survives dot contact');
    assert.equal(state.over, null);
  }
});
