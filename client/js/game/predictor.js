/**
 * Tilt Royale — own-arrow client prediction, wrapped around the SDK's
 * Predictor (Usion.game.createPredictor). Verified in the SDK source: the
 * netcode factories are plain classes attached at bundle load — they work
 * with NO platform connection, so this exact code runs in local-dev mode too.
 *
 * The `apply` function is shared/movement.js stepPlayer — the SAME code the
 * server sim runs. Bit-identical math on both sides is what makes
 * reconciliation invisible: replaying unacked inputs on top of the server
 * pose reproduces the server's future almost exactly.
 *
 * We advance in fixed SIM_DT steps (accumulator), matching the server's
 * 60 Hz fixed-step — variable-dt prediction would drift from the server even
 * with identical code. Each step gets an input sequence (iseq) from the SDK
 * predictor; the freshest iseq rides every input message and comes back in
 * snapshot `ack[mySlot]`.
 *
 * Error smoothing: SDK `smooth` keys x/y decay corrections over a few frames
 * (Overwatch-style). When a correction exceeds DESYNC_SNAP_UNITS we HARD
 * SNAP instead of gliding across the arena: predictor.view(1) applies and
 * fully decays the error offset in one call (rate=1 → residual 0), using
 * only public API — the next rendered view() is the corrected pose exactly.
 */
import { stepPlayer } from '/shared/movement.js';
import { SIM_DT_MS, DESYNC_SNAP_UNITS } from '/shared/constants.js';

const MAX_CATCHUP_MS = 250; // cap the accumulator — after a tab freeze we
                            // resync from the server rather than fast-forward

export function createOwnPredictor() {
  const core = Usion.game.createPredictor({
    apply: (s, inp) => {
      const next = stepPlayer(s, inp, inp.dt);
      // Carry non-physics fields (slot etc.) through untouched.
      return { ...s, ...next };
    },
    smooth: { keys: 'x y', rate: 0.25, snapTo: 0.001 },
  });

  let inited = false;
  let lastAdvanceAt = 0;
  let acc = 0;
  let lastCorrection = 0; // units — surfaced in the debug panel

  return {
    /** Seed / re-seed from an authoritative pose (join, respawn, rematch). */
    reset(pose) {
      core.reset({ x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy, angle: pose.angle });
      inited = true;
      lastAdvanceAt = 0;
      acc = 0;
    },

    /**
     * Advance prediction to `nowMs` in fixed SIM_DT steps using the current
     * merged input. Returns the latest iseq (what the sender should stamp).
     * @param {number} nowMs
     * @param {{mx:number,my:number}} input
     */
    advance(nowMs, input) {
      if (!inited) return 0;
      if (lastAdvanceAt === 0) lastAdvanceAt = nowMs;
      acc = Math.min(acc + (nowMs - lastAdvanceAt), MAX_CATCHUP_MS);
      lastAdvanceAt = nowMs;
      while (acc >= SIM_DT_MS) {
        acc -= SIM_DT_MS;
        core.predict({ mx: input.mx, my: input.my, dt: SIM_DT_MS / 1000 });
      }
      return core.lastSeq;
    },

    /**
     * Reconcile against the server row for our slot + its input ack.
     * @param {{x,y,vx,vy,angle}} serverPose  decoded player row
     * @param {number} ackIseq                highest applied input iseq
     */
    reconcile(serverPose, ackIseq) {
      if (!inited) { this.reset(serverPose); return; }
      const before = core.state;
      const after = core.reconcile(
        { x: serverPose.x, y: serverPose.y, vx: serverPose.vx, vy: serverPose.vy, angle: serverPose.angle },
        ackIseq,
      );
      if (before && after) {
        lastCorrection = Math.hypot(before.x - after.x, before.y - after.y);
        if (lastCorrection > DESYNC_SNAP_UNITS) {
          core.view(1); // hard snap: rate=1 zeroes the smoothing offset now
        }
      }
    },

    /** Render pose for this frame (corrected + decaying error offset). */
    view() { return inited ? core.view() : null; },

    /** Latest input sequence — stamped on outgoing input payloads. */
    iseq() { return core.lastSeq; },

    /** Last correction magnitude in world units (debug HUD). */
    lastCorrection: () => lastCorrection,
    isInited: () => inited,
  };
}
