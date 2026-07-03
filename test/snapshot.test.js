// Wire-size and codec correctness tests. The snapshot budget is the reason
// MAX_DOTS exists — this test pins the worst legal frame (max dots, max
// projectiles, full lobby, max orbs, a busy event queue, late-round ids)
// under SNAPSHOT_MAX_BYTES with margin.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARENA, MAX_DOTS, MAX_PROJECTILES, MAX_ORBS, SNAPSHOT_MAX_BYTES,
  POS_QUANT, VEL_QUANT, ANGLE_QUANT, MAX_SPEED,
} from '../shared/constants.js';
import {
  encodePlayerRow, decodePlayerRow,
  encodeDotsKeyframe, decodeDotsKeyframe, encodeDotsDelta, applyDotsDelta,
  encodeProjRow, decodeProjRow, encodeOrbRow, decodeOrbRow, EV,
} from '../shared/wire.js';
import * as sim from '../server/game/sim.js';
import { MODE_HUNTER } from '../server/game/dots.js';
import { buildFrame } from '../server/net/snapshot.js';

/** Deterministic pseudo-position spread across the arena (no RNG in tests). */
const spread = (i, salt) => 2 + (((i * 37.7 + salt * 13.3) % (ARENA - 4)));

function worstCaseState() {
  const state = sim.createState({ seed: 42 });
  for (let i = 0; i < 4; i++) sim.addPlayer(state, { slot: i, userId: `user-${i}`, name: `Player ${i}` });
  sim.beginRound(state);
  state.timeMs = 140_000; // late round: big remaining_ms digits, big scores
  state.remainingMs = 10_000;

  for (const p of state.players) {
    p.score = 9_999;
    p.chain = 9;
    p.chainUntilMs = state.timeMs + 1000;
    p.weapon = 3;
    p.ammo = 2;
    p.vx = MAX_SPEED; p.vy = -MAX_SPEED;
  }

  // Late-game dot ids are large (monotonic allocator) — model 4-digit ids.
  state.nextDotId = 2000;
  for (let i = 0; i < MAX_DOTS; i++) {
    state.dots.push({
      id: state.nextDotId++, mode: MODE_HUNTER,
      x: spread(i, 1), y: spread(i, 2), noiseF: 1, noiseP: 0,
    });
  }

  state.nextProjId = 5000;
  for (let i = 0; i < MAX_PROJECTILES; i++) {
    state.projs.push({
      id: state.nextProjId++, kind: i % 2 === 0 ? 2 : 3, owner: i % 4,
      x: spread(i, 3), y: spread(i, 4), vx: 65, vy: -65,
      ttlMs: 500, fireSeq: 900 + i,
    });
  }

  for (let i = 0; i < MAX_ORBS; i++) {
    state.orbs.push({ id: 300 + i, x: spread(i, 5), y: spread(i, 6), type: 1 + (i % 3) });
  }

  for (let i = 0; i < 10; i++) {
    state.events.push(
      i % 2 === 0
        ? [EV.DOT_KILLS, i % 4, 12, 240, 360]
        : [EV.TELEGRAPH, 100 + i, 400 - i]
    );
  }
  return state;
}

const meta = (s) => ({
  s, serverTs: 1_720_000_000_000, serverTick: 9_000, phase: 'playing',
  ack: { 0: 4500, 1: 4498, 2: 4321, 3: 4499 },
});

test('worst-case keyframe and delta stay under SNAPSHOT_MAX_BYTES', () => {
  const state = worstCaseState();

  const kf = buildFrame(state, meta(87), { keyframe: true, consume: false });
  console.log(`  keyframe bytes: ${kf.json.length} (budget ${SNAPSHOT_MAX_BYTES})`);
  assert.ok(kf.json.length < SNAPSHOT_MAX_BYTES, `keyframe ${kf.json.length}B < ${SNAPSHOT_MAX_BYTES}B`);
  assert.equal(kf.type, 'state_snapshot');
  assert.equal(kf.payload.k, true);
  assert.equal(kf.payload.dots.ids.length, MAX_DOTS);
  assert.equal(kf.payload.players.length, 4);
  assert.equal(kf.payload.projs.length, MAX_PROJECTILES);
  assert.equal(kf.payload.orbs.length, MAX_ORBS);
  assert.equal(kf.payload.events.length, 0, 'unicast keyframe must not steal events');

  // A busy delta: churned membership + all positions + the event queue.
  state.dotRm = state.dots.slice(0, 6).map((d) => d.id);
  state.dots.splice(0, 6);
  state.dotAdd = [];
  for (let i = 0; i < 6; i++) {
    const dot = { id: state.nextDotId++, mode: MODE_HUNTER, x: spread(i, 7), y: spread(i, 8), noiseF: 1, noiseP: 0 };
    state.dots.push(dot);
    state.dotAdd.push({ id: dot.id, x: dot.x, y: dot.y });
  }
  const df = buildFrame(state, meta(88), { keyframe: false, consume: true });
  console.log(`  delta bytes:    ${df.json.length} (budget ${SNAPSHOT_MAX_BYTES})`);
  assert.ok(df.json.length < SNAPSHOT_MAX_BYTES, `delta ${df.json.length}B < ${SNAPSHOT_MAX_BYTES}B`);
  assert.equal(df.type, 'state_delta');
  assert.equal(df.payload.k, undefined);
  assert.equal(df.payload.dots.rm.length, 6);
  assert.equal(df.payload.dots.add.length, 6);
  assert.equal(df.payload.events.length, 10, 'broadcast delta drains the event queue');
  assert.equal(state.events.length, 0);
  assert.equal(state.dotRm.length, 0, 'tracking consumed');
  assert.equal(state.dotAdd.length, 0, 'tracking consumed');
});

test('wire round-trip: players/dots/projs/orbs equal within quantization cell', () => {
  const player = {
    slot: 2, x: 61.13, y: 118.4, vx: -39.97, vy: 12.34, angle: -3.04,
    alive: true, shield: false, stagger: true, connected: true,
    weapon: 3, ammo: 2, score: 12345, chain: 7,
  };
  const p2 = decodePlayerRow(encodePlayerRow(player));
  assert.ok(Math.abs(p2.x - player.x) <= POS_QUANT / 2);
  assert.ok(Math.abs(p2.y - player.y) <= POS_QUANT / 2);
  assert.ok(Math.abs(p2.vx - player.vx) <= VEL_QUANT / 2);
  assert.ok(Math.abs(p2.vy - player.vy) <= VEL_QUANT / 2);
  assert.ok(Math.abs(p2.angle - player.angle) <= ANGLE_QUANT / 2);
  for (const k of ['slot', 'alive', 'shield', 'stagger', 'connected', 'weapon', 'ammo', 'score', 'chain']) {
    assert.equal(p2[k], player[k], k);
  }

  const dots = Array.from({ length: 50 }, (_, i) => ({ id: 10 + i, x: spread(i, 1), y: spread(i, 2) }));
  const dots2 = decodeDotsKeyframe(encodeDotsKeyframe(dots));
  assert.equal(dots2.length, dots.length);
  for (let i = 0; i < dots.length; i++) {
    assert.equal(dots2[i].id, dots[i].id);
    assert.ok(Math.abs(dots2[i].x - dots[i].x) <= POS_QUANT / 2);
    assert.ok(Math.abs(dots2[i].y - dots[i].y) <= POS_QUANT / 2);
  }

  const proj = { id: 77, kind: 3, owner: 1, x: 12.6, y: 99.1, vx: 40, vy: -0.05, fireSeq: 17 };
  const pr2 = decodeProjRow(encodeProjRow(proj));
  assert.equal(pr2.id, proj.id);
  assert.equal(pr2.kind, proj.kind);
  assert.equal(pr2.owner, proj.owner);
  assert.equal(pr2.fireSeq, proj.fireSeq);
  assert.ok(Math.abs(pr2.x - proj.x) <= POS_QUANT / 2);
  assert.ok(Math.abs(pr2.vy - proj.vy) <= VEL_QUANT / 2);

  const orb = { id: 5, x: 33.3, y: 66.6, type: 2 };
  const o2 = decodeOrbRow(encodeOrbRow(orb));
  assert.equal(o2.id, orb.id);
  assert.equal(o2.type, orb.type);
  assert.ok(Math.abs(o2.x - orb.x) <= POS_QUANT / 2);
  assert.ok(Math.abs(o2.y - orb.y) <= POS_QUANT / 2);
});

test('applyDotsDelta: rm + add + position update, id order preserved', () => {
  // Receiver-side list (id-sorted, dequantized).
  const list = [
    { id: 1, x: 10, y: 10 },
    { id: 3, x: 30, y: 30 },
    { id: 5, x: 50, y: 50 },
    { id: 7, x: 70, y: 70 },
  ];
  // Server side: dot 3 and 7 die, dots 8 and 9 spawn, everything moves +1u.
  const serverDots = [
    { id: 1, x: 11, y: 11 },
    { id: 5, x: 51, y: 51 },
    { id: 8, x: 80, y: 80 },
    { id: 9, x: 90, y: 90 },
  ];
  const delta = encodeDotsDelta(serverDots, [3, 7], [{ id: 8, x: 80, y: 80 }, { id: 9, x: 90, y: 90 }]);

  applyDotsDelta(list, delta);
  assert.deepEqual(list.map((d) => d.id), [1, 5, 8, 9], 'membership + order');
  for (let i = 0; i < list.length; i++) {
    assert.ok(Math.abs(list[i].x - serverDots[i].x) <= POS_QUANT / 2, `x[${i}]`);
    assert.ok(Math.abs(list[i].y - serverDots[i].y) <= POS_QUANT / 2, `y[${i}]`);
  }

  // Membership-only delta (positions omitted) leaves coordinates untouched.
  const list2 = [{ id: 2, x: 20, y: 20 }];
  applyDotsDelta(list2, encodeDotsDelta([], [2], [], false));
  assert.equal(list2.length, 0);
});
