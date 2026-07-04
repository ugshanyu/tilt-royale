// Regression: broadcast snapshot seq (`s`) must form a contiguous chain for
// EVERY client, no matter how many unicast keyframes (joins, rejoins,
// resyncs, spectators) happen in between.
//
// The v1 bug: unicast keyframes incremented the shared seq counter, so every
// join/resync manufactured a "gap" in every OTHER client's delta stream →
// each client dropped deltas + requested a resync → which burned another seq
// for everyone else → a self-sustaining ping-pong that froze remote players
// on real devices. These tests pin the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';

function fakeConn(userId) {
  const frames = [];
  return {
    userId,
    name: userId,
    sessionId: 'sess-' + userId,
    lastSeenMs: Date.now(),
    spectator: false,
    ws: {
      readyState: 1,
      send(json) { frames.push(JSON.parse(json)); },
      close() { this.readyState = 3; },
    },
    frames,
    ofType(type) { return frames.filter((f) => f.type === type); },
  };
}

function makeRoom() {
  const room = new Room('seq-test-room', { onDestroy: () => {} });
  return room;
}

test('unicast keyframes reuse the current seq — broadcast chain stays contiguous', () => {
  const room = makeRoom();
  try {
    const a = fakeConn('alice');
    const b = fakeConn('bob');
    room.handleMessage(a, { type: 'join', payload: {} });

    // A few broadcast ticks, then B joins mid-stream (unicast joined+keyframe),
    // then more broadcasts, then A fires a stale-resync ping (unicast keyframe).
    room._netTick();
    room._netTick();
    room.handleMessage(b, { type: 'join', payload: {} });
    room._netTick();
    room.handleMessage(a, { type: 'ping', payload: { last_sequence: 0 } });
    room._netTick();
    room._netTick();

    for (const conn of [a, b]) {
      const broadcast = conn.frames
        .filter((f) => f.type === 'state_snapshot' || f.type === 'state_delta')
        .map((f) => f.payload.s);
      // Broadcast `s` as seen by each client must be non-decreasing and,
      // crucially, NEVER skip a value: a skipped s is exactly the v1 bug.
      for (let i = 1; i < broadcast.length; i++) {
        const step = broadcast[i] - broadcast[i - 1];
        assert.ok(step === 0 || step === 1,
          `${conn.userId}: seq gap ${broadcast[i - 1]} → ${broadcast[i]}`);
      }
    }

    // The unicast resync keyframe must carry the CURRENT broadcast seq, not a
    // fresh one — verify against the last broadcast s at the time it was sent.
    const aKeyframes = a.ofType('state_snapshot').map((f) => f.payload.s);
    const allS = a.frames
      .filter((f) => f.type === 'state_snapshot' || f.type === 'state_delta')
      .map((f) => f.payload.s);
    assert.equal(Math.max(...allS), room.snapSeq,
      'no frame may carry a seq beyond the broadcast counter');
    assert.ok(aKeyframes.length >= 1, 'resync keyframe was sent');
  } finally {
    room.destroy();
  }
});

test('resync ping is answered only when the client is actually behind', () => {
  const room = makeRoom();
  try {
    const a = fakeConn('alice');
    room.handleMessage(a, { type: 'join', payload: {} });
    room._netTick();
    room._netTick();

    const keyframesBefore = a.ofType('state_snapshot').length;
    // Client claims it has seen everything → no keyframe, just a pong.
    room.handleMessage(a, { type: 'ping', payload: { last_sequence: room.snapSeq } });
    assert.equal(a.ofType('state_snapshot').length, keyframesBefore,
      'up-to-date client must not receive a resync keyframe');
    assert.ok(a.ofType('pong').length >= 1, 'pong still answered');

    // Client behind → keyframe, carrying the current (not advanced) seq.
    const seqBefore = room.snapSeq;
    room.handleMessage(a, { type: 'ping', payload: { last_sequence: 0 } });
    assert.equal(a.ofType('state_snapshot').length, keyframesBefore + 1);
    assert.equal(room.snapSeq, seqBefore, 'unicast must not advance the broadcast seq');
    const last = a.ofType('state_snapshot').at(-1);
    assert.equal(last.payload.s, seqBefore, 'unicast keyframe reuses current seq');
    assert.equal(last.payload.k, true);
  } finally {
    room.destroy();
  }
});
