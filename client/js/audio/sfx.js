/**
 * Tilt Royale — WebAudio synth SFX. Zero assets: every sound is oscillators
 * + shaped noise, so the client stays a handful of tiny text files and
 * first-load on a 4G phone is instant.
 *
 * Graph: voices → master gain → soft limiter (DynamicsCompressor) → out.
 * The limiter is what lets a 40-dot mega-burst stack pops without clipping.
 *
 * Autoplay policy: the context is created lazily and resume()d on the first
 * user gesture (Ready tap / first tap-to-fire).
 */
const MUTE_KEY = 'tiltroyale.muted';

export function createSfx() {
  let ctx = null;
  let master = null;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* private mode */ }

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 24;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    return true;
  }

  /** One enveloped oscillator voice. */
  function tone({ type = 'sine', from = 440, to = from, dur = 0.12, gain = 0.3, delay = 0 }) {
    if (!ensure() || muted) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Filtered white-noise burst (impacts, explosions). */
  function noise({ dur = 0.15, gain = 0.25, freq = 1200, q = 1, delay = 0 }) {
    if (!ensure() || muted) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0);
  }

  return {
    /** Call from the first user gesture — unlocks the AudioContext. */
    ensure,

    isMuted: () => muted,
    toggleMute() {
      muted = !muted;
      try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
      if (master) master.gain.value = muted ? 0 : 0.6;
      return muted;
    },

    /* ------------------------------------------------ gameplay sounds -- */
    pop(n = 1) { // dot kill; stack a couple voices for multi-kills
      tone({ type: 'square', from: 520, to: 780, dur: 0.06, gain: 0.16 });
      if (n > 2) tone({ type: 'square', from: 640, to: 940, dur: 0.06, gain: 0.12, delay: 0.03 });
    },
    pickup() { // orb honk — two quick rising fifths
      tone({ type: 'triangle', from: 392, to: 392, dur: 0.09, gain: 0.25 });
      tone({ type: 'triangle', from: 587, to: 587, dur: 0.12, gain: 0.25, delay: 0.08 });
    },
    wave() { // shockwave whoomp — sub sweep + low noise
      tone({ type: 'sine', from: 220, to: 40, dur: 0.4, gain: 0.5 });
      noise({ dur: 0.3, gain: 0.2, freq: 300, q: 0.7 });
    },
    scatter() { // pellet burst crack
      noise({ dur: 0.08, gain: 0.3, freq: 2400, q: 0.8 });
      tone({ type: 'sawtooth', from: 300, to: 120, dur: 0.08, gain: 0.15 });
    },
    missile() { // launch whoosh
      noise({ dur: 0.35, gain: 0.18, freq: 900, q: 2 });
      tone({ type: 'sawtooth', from: 180, to: 420, dur: 0.3, gain: 0.1 });
    },
    boom() { // seeker blast
      tone({ type: 'sine', from: 140, to: 30, dur: 0.5, gain: 0.5 });
      noise({ dur: 0.4, gain: 0.3, freq: 500, q: 0.6 });
    },
    death() { // player down — descending minor arc + debris noise
      tone({ type: 'sawtooth', from: 660, to: 110, dur: 0.5, gain: 0.3 });
      noise({ dur: 0.5, gain: 0.25, freq: 800, q: 0.5, delay: 0.05 });
    },
    stagger() {
      tone({ type: 'square', from: 200, to: 160, dur: 0.15, gain: 0.2 });
    },
    countdown(final = false) { // 3-2-1 blips, GO! a fourth up
      tone({ type: 'sine', from: final ? 880 : 660, to: final ? 880 : 660, dur: final ? 0.3 : 0.1, gain: 0.3 });
    },
    /** Combo ladder: pitch climbs a semitone per chain step (capped). */
    combo(chain) {
      const semis = Math.min(12, chain);
      tone({ type: 'triangle', from: 523 * Math.pow(2, semis / 12), dur: 0.08, gain: 0.22 });
    },
    win() {
      [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', from: f, dur: 0.18, gain: 0.25, delay: i * 0.12 }));
    },
  };
}
