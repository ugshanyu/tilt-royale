/**
 * Tilt Royale — outbound input stream. 30 Hz `input` messages, payload per
 * PROTOCOL.md: { mx, my, iseq, fires, interp_ms, csa }.
 *
 * Scheduling:
 *  - PLATFORM: the SDK Coalescer (Usion.game.createSender) drives the tick.
 *    We queue() a marker every rendered frame (latest-wins) and COMPOSE the
 *    payload at flush time, so tilt is always the freshest sample and fires
 *    accumulated between ticks are folded in — never dropped by latest-wins.
 *  - LOCAL: a plain setInterval with identical compose/flush semantics.
 *
 * Fires flush immediately on tap (min 33 ms gap — stays inside the server's
 * 60 msg/s token bucket even while spamming), otherwise ride the next tick.
 * When smoothed RTT > 250 ms we degrade to 20 Hz (fewer, same-sized packets
 * beat a growing queue on a saturated uplink); restore below 200 ms.
 */
import { INPUT_HZ, INPUT_HZ_DEGRADED } from '/shared/constants.js';

const MIN_FIRE_FLUSH_GAP_MS = 33;
const DEGRADE_RTT_MS = 250;
const RESTORE_RTT_MS = 200;   // hysteresis so a jittery link doesn't flap rates

/**
 * @param {{ connection: object, clock: {getRtt:()=>number|null},
 *           getPayloadParts: () => {mx:number,my:number,iseq:number,interpMs:number} }} deps
 */
export function createInputSender({ connection, clock, getPayloadParts }) {
  let pendingFires = [];       // [{fs}] accumulated since last flush
  let dirty = false;           // tick() called since last flush?
  let lastSendAt = 0;
  let hz = INPUT_HZ;
  let running = false;
  let sdkSender = null;        // platform-mode Coalescer
  let localTimer = null;

  function compose() {
    const parts = getPayloadParts();
    return {
      mx: parts.mx,
      my: parts.my,
      iseq: parts.iseq,
      fires: pendingFires.splice(0, pendingFires.length),
      // Our interp buffer, so the server rewinds hit tests to what WE saw.
      interp_ms: Math.max(0, Math.min(250, Math.round(parts.interpMs))),
      csa: Date.now(),         // client_sent_at → server's one-way delay EWMA
    };
  }

  function flush() {
    if (!dirty && pendingFires.length === 0) return; // nothing new — server reuses last input
    dirty = false;
    lastSendAt = Date.now();
    connection.send('input', compose());
  }

  function startScheduler() {
    stopScheduler();
    if (connection.mode === 'platform') {
      // The Coalescer's queued data is a throwaway marker; `send` recomposes
      // from live state so the payload is as fresh as the flush instant.
      sdkSender = Usion.game.createSender({ hz, send: () => flush() });
    } else {
      localTimer = setInterval(() => { if (dirty || pendingFires.length) flush(); }, Math.round(1000 / hz));
    }
  }

  function stopScheduler() {
    if (sdkSender) { sdkSender.stop(); sdkSender = null; }
    if (localTimer) { clearInterval(localTimer); localTimer = null; }
  }

  return {
    /** Call once per rendered frame while input should stream. */
    tick() {
      if (!running) return;
      dirty = true;
      if (sdkSender) sdkSender.queue('input', 1); // marker: "flush next tick"
      // Rate adaptation rides the same cadence checks as the tick.
      const rtt = clock.getRtt();
      if (rtt != null) {
        if (hz === INPUT_HZ && rtt > DEGRADE_RTT_MS) { hz = INPUT_HZ_DEGRADED; if (running) startScheduler(); }
        else if (hz === INPUT_HZ_DEGRADED && rtt < RESTORE_RTT_MS) { hz = INPUT_HZ; if (running) startScheduler(); }
      }
    },

    /** Fold a fire tap; flushes immediately when the 33 ms gap allows. */
    fire(fs) {
      pendingFires.push({ fs });
      if (!running) return;
      if (Date.now() - lastSendAt >= MIN_FIRE_FLUSH_GAP_MS) {
        dirty = true;
        flush();
        if (sdkSender) sdkSender.flush(); // clear the queued marker too
      }
    },

    start() {
      if (running) return;
      running = true;
      startScheduler();
    },

    stop() {
      running = false;
      stopScheduler();
      pendingFires = [];
      dirty = false;
    },

    /** Backgrounded / paused: park the arrow instead of ghost-drifting on
     *  our stale last tilt (the server reuses the latest input forever). */
    sendNeutral() {
      pendingFires = [];
      dirty = false;
      lastSendAt = Date.now();
      connection.send('input', { ...compose(), mx: 0, my: 0 });
    },

    isRunning: () => running,
    currentHz: () => hz,
  };
}
