/**
 * Tilt Royale — device-tilt input (the game's namesake).
 *
 * Ported from the battle-tested space-craft-direct / tilt-arena pipeline:
 *  - iOS: DeviceOrientationEvent.requestPermission() MUST run inside a user
 *    gesture, EVERY page load — we call it from the Ready button tap.
 *  - 300 ms calibration window right after enabling: average gamma/beta →
 *    that pose becomes the neutral "no input" grip (nobody holds a phone
 *    perfectly flat; calibrating to the natural grip is what makes tilt
 *    feel effortless).
 *  - Angles are taken RELATIVE to neutral, clamped to ±45° → [-1, 1].
 *  - Low-pass filter α=0.2 kills sensor noise without adding felt latency.
 *  - Spike detection (≥18° jumps between close samples) flags flaky sensors;
 *    we log and auto-recalibrate after a burst rather than fight bad data.
 *  - Orientation-aware axis mapping (portrait/landscape via
 *    screen.orientation.angle, window.orientation fallback).
 */
const TILT_MAX_DEG = 45;
const LPF_ALPHA = 0.2;
const CALIBRATION_MS = 300;
const NEUTRAL_BETA_DEG = 50;      // typical in-hand pitch before calibration
const SPIKE_DEG = 18;
const SPIKE_SAMPLE_GAP_MS = 80;
const SPIKE_WINDOW_MS = 1500;
const SPIKE_COUNT_THRESHOLD = 4;
const STALE_MS = 1000;            // no events for 1 s → sensor inactive

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createTilt({ onCalibrated, onLog } = {}) {
  let listening = false;
  let neutral = { gamma: 0, beta: NEUTRAL_BETA_DEG, calibrated: false };
  let calib = null;               // {startedAt, sumG, sumB, n} while calibrating
  let filtered = { x: 0, y: 0 };
  let lastEventAt = 0;
  let lastSample = null;          // {at, gamma, beta}
  let spikeWindowStart = 0;
  let spikeCount = 0;

  const log = (msg) => { if (onLog) onLog(msg); };

  function orientationAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }

  function handleOrientation(e) {
    const now = Date.now();
    const gamma = clamp(Number(e.gamma ?? 0), -90, 90);
    const beta = clamp(Number(e.beta ?? NEUTRAL_BETA_DEG), -180, 180);
    lastEventAt = now;

    if (calib) {
      if (!calib.startedAt) calib.startedAt = now;
      calib.sumG += gamma; calib.sumB += beta; calib.n += 1;
      if (now - calib.startedAt >= CALIBRATION_MS && calib.n > 0) {
        neutral = { gamma: calib.sumG / calib.n, beta: calib.sumB / calib.n, calibrated: true };
        calib = null;
        filtered = { x: 0, y: 0 };
        if (onCalibrated) onCalibrated();
      }
      return;
    }
    if (!neutral.calibrated) return;

    // Flaky-sensor detection: big jumps between temporally-close samples.
    if (lastSample && now - lastSample.at <= SPIKE_SAMPLE_GAP_MS) {
      if (Math.abs(gamma - lastSample.gamma) >= SPIKE_DEG ||
          Math.abs(beta - lastSample.beta) >= SPIKE_DEG) {
        if (now - spikeWindowStart > SPIKE_WINDOW_MS) { spikeWindowStart = now; spikeCount = 0; }
        spikeCount += 1;
        if (spikeCount >= SPIKE_COUNT_THRESHOLD) {
          log('tilt: unstable sensor burst — recalibrating');
          spikeCount = 0;
          startCalibration();
          return;
        }
      }
    }
    lastSample = { at: now, gamma, beta };

    // Relative to neutral, clamped to the ±45° comfort cone → [-1, 1].
    const dG = gamma - neutral.gamma;
    const dB = beta - neutral.beta;
    let rawX;
    let rawY;
    switch (orientationAngle()) {
      case 90: rawX = dB / TILT_MAX_DEG; rawY = -dG / TILT_MAX_DEG; break;   // landscape-left
      case -90:
      case 270: rawX = -dB / TILT_MAX_DEG; rawY = dG / TILT_MAX_DEG; break;  // landscape-right
      case 180: rawX = -dG / TILT_MAX_DEG; rawY = -dB / TILT_MAX_DEG; break; // upside down
      default: rawX = dG / TILT_MAX_DEG; rawY = dB / TILT_MAX_DEG; break;    // portrait
    }
    filtered = {
      x: clamp(filtered.x * (1 - LPF_ALPHA) + clamp(rawX, -1, 1) * LPF_ALPHA, -1, 1),
      y: clamp(filtered.y * (1 - LPF_ALPHA) + clamp(rawY, -1, 1) * LPF_ALPHA, -1, 1),
    };
  }

  function attach() {
    if (listening) return;
    window.addEventListener('deviceorientation', handleOrientation);
    listening = true;
  }

  function startCalibration() {
    neutral = { gamma: 0, beta: NEUTRAL_BETA_DEG, calibrated: false };
    calib = { startedAt: 0, sumG: 0, sumB: 0, n: 0 };
    filtered = { x: 0, y: 0 };
  }

  return {
    /**
     * Enable tilt. MUST be called from a user gesture (Ready tap) — iOS ties
     * the motion-permission prompt to gestures, and re-asks each page load.
     * @returns {Promise<'granted'|'denied'|'insecure'|'unsupported'>}
     */
    async requestPermission() {
      if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
      if (!window.isSecureContext &&
          !/^(localhost|127(?:\.\d{1,3}){3})$/i.test(location.hostname)) {
        return 'insecure'; // browsers gate motion sensors to secure contexts
      }
      const DOE = DeviceOrientationEvent;
      if (typeof DOE.requestPermission === 'function') {
        try {
          const r = await DOE.requestPermission();
          if (r !== 'granted') return 'denied';
        } catch (e) {
          return 'denied'; // thrown when not called from a gesture
        }
      }
      attach();
      return 'granted';
    },

    /** Begin the 300 ms hold-still window (also used to recalibrate). */
    startCalibration,
    isCalibrating: () => !!calib,
    isCalibrated: () => neutral.calibrated,

    /**
     * Current tilt vector. `active` = sensor is calibrated AND producing
     * fresh events — the input merger falls back to keyboard/touch when
     * false. A flat, still phone is still ACTIVE (deliberate "stop" input).
     */
    state() {
      const active = listening && neutral.calibrated &&
        Date.now() - lastEventAt < STALE_MS;
      return active
        ? { mx: filtered.x, my: filtered.y, active: true }
        : { mx: 0, my: 0, active: false };
    },

    stop() {
      if (listening) window.removeEventListener('deviceorientation', handleOrientation);
      listening = false;
    },
  };
}
