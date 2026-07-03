/**
 * Tilt Royale — predicted projectiles. What we predict, and what we DON'T:
 *
 *  W2 SCATTER — predicted. Ballistic pellets are pure functions of the fire
 *    pose: we spawn 5 local pellets instantly (zero-latency feel), tagged
 *    with the client fire_seq. When authoritative `projs` rows arrive
 *    carrying the same fireSeq for our slot, the prediction is confirmed:
 *    predicted pellets fade out and the interpolated server pellets take
 *    over (they are the ones that can actually kill). Same reconcile-by-
 *    fire_seq pattern as space-craft-direct.
 *
 *  W1 WAVE — NOT simulated here. It's server-side hitscan (lag-compensated);
 *    the client plays an instant cosmetic ring at the predicted pose on tap
 *    (FxHelpers) and the truth arrives as 'wv'/'dk'/'de' events.
 *
 *  W3 SEEKER — NOT predicted, muzzle flash only. Homing steers toward a
 *    target the SERVER picks with server-side knowledge; a client guess
 *    would visibly veer once the real missile arrives. Rule of thumb: only
 *    predict what is a pure function of local input + shared constants.
 */
import {
  SCATTER, ARENA, PELLET_RADIUS, PLAYER_RADIUS, WEAPON_SCATTER,
} from '/shared/constants.js';

const BRIDGE_TTL_MS = 450;   // predicted pellets only bridge ~RTT until the
                             // authoritative rows land, never a full lifetime
const FADE_MS = 120;         // confirm → fade, overlapping the server pellets
const SUPPRESS_ALPHA = 0.5;  // while a batch is more solid than this, hide
                             // its authoritative twins (avoid double pellets)

export function createPredictedShots() {
  /** @type {Array<{fs:number, alpha:number, fading:boolean, pellets:Array}>} */
  let batches = [];

  return {
    /**
     * Spawn a predicted 5-pellet fan from the predicted fire pose.
     * Caller has already checked weapon/ammo/cooldown against the latest
     * authoritative row — never predict a shot the server would reject.
     * @param {{x:number,y:number,angle:number}} pose
     * @param {number} fs client fire_seq (matches `fires[].fs` on the wire)
     */
    onFire(pose, fs) {
      const pellets = [];
      const muzzle = PLAYER_RADIUS + PELLET_RADIUS;
      for (let i = 0; i < SCATTER.PELLETS; i++) {
        const a = pose.angle + SCATTER.FAN_RAD * (i / (SCATTER.PELLETS - 1) - 0.5);
        pellets.push({
          x: pose.x + Math.cos(a) * muzzle,
          y: pose.y + Math.sin(a) * muzzle,
          vx: Math.cos(a) * SCATTER.SPEED,
          vy: Math.sin(a) * SCATTER.SPEED,
          ttl: Math.min(SCATTER.TTL_MS, BRIDGE_TTL_MS),
        });
      }
      batches.push({ fs, alpha: 1, fading: false, pellets });
    },

    /** Integrate + fade. dtMs is RENDER delta (cosmetic-only simulation). */
    step(dtMs) {
      const dt = dtMs / 1000;
      for (const b of batches) {
        if (b.fading) b.alpha = Math.max(0, b.alpha - dtMs / FADE_MS);
        for (const p of b.pellets) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.ttl -= dtMs;
          if (p.x < -PELLET_RADIUS || p.x > ARENA + PELLET_RADIUS ||
              p.y < -PELLET_RADIUS || p.y > ARENA + PELLET_RADIUS) p.ttl = 0;
        }
        b.pellets = b.pellets.filter((p) => p.ttl > 0);
      }
      batches = batches.filter((b) => b.alpha > 0 && b.pellets.length > 0);
    },

    /**
     * Authoritative projs arrived: any row for OUR slot carrying a fireSeq we
     * predicted confirms that batch → start its fade. A batch whose TTL
     * expires unconfirmed simply dies (server rejected the shot; rare, since
     * the caller pre-checks ammo).
     * @param {Array<{kind:number,owner:number,fireSeq:number}>} projRows
     * @param {number|null} mySlot
     */
    reconcile(projRows, mySlot) {
      if (mySlot == null || batches.length === 0) return;
      for (const pr of projRows) {
        if (pr.owner !== mySlot || pr.kind !== WEAPON_SCATTER || !pr.fireSeq) continue;
        const b = batches.find((x) => x.fs === pr.fireSeq);
        if (b && !b.fading) b.fading = true;
      }
    },

    /**
     * Filter the interpolated authoritative projectile view: while one of our
     * predicted batches is still solid, hide the server rows with the same
     * fireSeq so pellets don't render twice. Cross-fade handles the handoff.
     */
    filterAuth(projView, mySlot) {
      if (mySlot == null || batches.length === 0) return projView;
      const suppressed = new Set();
      for (const b of batches) {
        if (b.alpha > SUPPRESS_ALPHA) suppressed.add(b.fs);
      }
      if (suppressed.size === 0) return projView;
      return projView.filter((pr) =>
        !(pr.owner === mySlot && pr.kind === WEAPON_SCATTER && suppressed.has(pr.fireSeq)));
    },

    /** Flat render list. */
    view() {
      const out = [];
      for (const b of batches) {
        for (const p of b.pellets) out.push({ x: p.x, y: p.y, alpha: b.alpha });
      }
      return out;
    },

    /** fire_seqs with a live batch — FxHelpers skips duplicate muzzle flash
     *  when our own 'fi' event echoes back. */
    liveFireSeqs() {
      const s = new Set();
      for (const b of batches) s.add(b.fs);
      return s;
    },

    reset() { batches = []; },
  };
}
