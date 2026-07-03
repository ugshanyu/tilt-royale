/**
 * Tilt Royale — RTT clock. Pings every 2 s; exposes a smoothed RTT + jitter
 * for the HUD, the input-rate degrade decision, and lag-comp `interp_ms`
 * sanity checks.
 *
 * PLATFORM mode: Usion.game.ping() (protocol ping/pong, single outstanding
 * probe) + Usion.game.getRtt() — the SDK PingMeter (EWMA α=0.2) does the
 * smoothing.
 * LOCAL mode: connection.ping() resolves raw ms; the SDK does not export
 * PingMeter standalone, so we mirror its exact EWMA math here (α=0.2) —
 * documented divergence, kept tiny on purpose.
 */
const PING_EVERY_MS = 2_000;
const ALPHA = 0.2; // matches netcode/ping.js PingMeter default

export function createClock({ connection }) {
  let timer = null;
  let rtt = null;     // local-mode EWMA (platform reads the SDK's meter)
  let jitter = 0;
  let last = null;

  function sample(ms) {
    if (!(ms >= 0)) return;
    if (rtt == null) rtt = ms;
    else {
      jitter += ALPHA * (Math.abs(ms - rtt) - jitter);
      rtt += ALPHA * (ms - rtt);
    }
    last = ms;
  }

  async function probe() {
    try {
      const ms = await connection.ping(); // null when not connected / timeout
      if (ms != null) sample(ms);
    } catch (e) { /* probes are best-effort */ }
  }

  return {
    start() {
      if (timer) return;
      probe(); // first sample ASAP — the HUD shouldn't sit on "—" for 2 s
      timer = setInterval(probe, PING_EVERY_MS);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },

    /** Smoothed RTT ms (null until the first pong). */
    getRtt() {
      if (connection.mode === 'platform') {
        const v = Usion.game.getRtt();
        return v == null ? rtt : v;
      }
      return rtt;
    },
    /** Smoothed |sample - rtt| ms — the HUD's jitter readout. */
    getJitter() {
      if (connection.mode === 'platform' && Usion.game._pingMeter) {
        // Read-only peek at the SDK meter's jitter (no setter, no behavior
        // dependence — worst case we fall back to our own estimate).
        const j = Usion.game._pingMeter.jitter;
        if (typeof j === 'number') return j;
      }
      return jitter;
    },
    getLastSample: () => last,
  };
}
