/**
 * Tilt Royale — snapshot interpolation groups (SDK SnapshotInterpolation).
 *
 * Remote entities render slightly in the past, blended between the two
 * snapshots straddling render time — 20 Hz network updates become fluid
 * 60 fps motion, and late/dropped packets are absorbed by the buffer.
 *
 * Three independent groups (players / dots / projectiles) because their
 * populations churn differently: one group with a shared entity array would
 * make a dot-membership change perturb player blending.
 *
 * Options (same for all three):
 *  - serverFps 20        matches NET_EVERY_SIM_TICKS (snapshot cadence)
 *  - adaptive + 60..200  buffer grows with measured jitter (Valve
 *                        cl_interp_ratio idea) instead of a fixed worst case
 *  - extrapolationMs 120 short velocity projection on underruns — dots keep
 *                        drifting through a lost packet instead of freezing
 *  - serverTime true     snapshots carry server_ts; rendering against an
 *                        estimated server clock is robust to bursty arrival
 */
const OPTS = {
  serverFps: 20,
  adaptive: true,
  minBufferMs: 60,
  maxBufferMs: 200,
  extrapolationMs: 120,
  serverTime: true,
};

export function createInterpGroups() {
  const players = Usion.game.createInterpolation({ ...OPTS });
  const dots = Usion.game.createInterpolation({ ...OPTS });
  const projs = Usion.game.createInterpolation({ ...OPTS });

  return {
    /**
     * Feed one decoded snapshot. `time` must be the SERVER timestamp — the
     * vault interpolates in the server-clock domain (see serverTime above).
     * @param {{serverTs:number, players:Array, dots:Array, projs:Array}} s
     */
    addSnapshot(s) {
      players.add({ state: s.players, time: s.serverTs });
      dots.add({ state: s.dots, time: s.serverTs });
      projs.add({ state: s.projs, time: s.serverTs });
    },

    /** Per-render-frame views. Angle blends on the shortest arc. */
    viewPlayers: () => players.calc('x y angle(rad)') || [],
    viewDots: () => dots.calc('x y') || [],
    viewProjs: () => projs.calc('x y') || [],

    /** Current player-group buffer (ms) — reported as `interp_ms` so the
     *  server lag-compensates hits against what we actually rendered. */
    bufferMs: () => players.getBufferMs(),
    jitterMs: () => players.getJitter(),
  };
}
