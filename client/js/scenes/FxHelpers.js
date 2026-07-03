/**
 * Tilt Royale — juice layer: particles, shakes, floaters, hit-stop, and the
 * server-event → VFX fan-out. Pure cosmetics: nothing here feeds back into
 * netcode state.
 *
 * HIT-STOP RULE: slow-mo scales RENDER time only (tween/particle/emitter
 * timescales + the delta we hand to cosmetic sims). It must NEVER touch the
 * predictor accumulator, the input-sender cadence, or the interpolation
 * clocks — those run on wall time; slowing them would desync prediction from
 * the server and corrupt RTT/jitter measurement. Freeze the paint, not the
 * simulation.
 */
import { dqPos, dqAng, EV } from '/shared/wire.js';
import {
  WAVE, CORPSE_CLEAR_RADIUS, WEAPON_SCATTER, WEAPON_SEEKER, DOT_TELEGRAPH_MS,
} from '/shared/constants.js';
import { fmtNum } from '../i18n.js';

const OWN_WAVE_DEDUPE_MS = 450; // skip the echo of a wave we already played

export function createFx(scene, sfx, world) {
  // world: { toX(wx), toY(wy), scale(), getPlayerPos(slot) → {x,y}|null, mySlot() }
  let emitters = {};
  let floaterPool = [];
  let ghostPool = [];
  let renderScale = 1;          // hit-stop factor, recovers toward 1
  let renderScaleUntil = 0;
  let lastOwnWaveAt = 0;

  function makeEmitters() {
    const mk = (tex, cfg) => scene.add.particles(0, 0, tex, { emitting: false, ...cfg }).setDepth(50);
    emitters = {
      pop: mk('spark', { speed: { min: 40, max: 140 }, lifespan: 350, scale: { start: 0.9, end: 0 }, tint: 0xf43f5e, quantity: 1 }),
      death: mk('spark', { speed: { min: 80, max: 320 }, lifespan: 650, scale: { start: 1.4, end: 0 }, quantity: 1 }),
      impact: mk('spark', { speed: { min: 30, max: 90 }, lifespan: 220, scale: { start: 0.6, end: 0 }, tint: 0xf59e0b, quantity: 1 }),
      blast: mk('spark', { speed: { min: 60, max: 260 }, lifespan: 500, scale: { start: 1.1, end: 0 }, tint: 0xa78bfa, quantity: 1 }),
    };
  }

  /* ------------------------------------------------------------ helpers -- */

  function shakePx(px, ms = 120) {
    const cam = scene.cameras.main;
    cam.shake(ms, px / Math.max(1, cam.height));
  }

  function flash(ms = 90, r = 255, g = 255, b = 255) {
    scene.cameras.main.flash(ms, r, g, b, false);
  }

  /** Render-time slow-mo (see header). factor≈0.15 for a beat of hit-stop. */
  function hitStop(ms = 90, factor = 0.2) {
    renderScale = factor;
    renderScaleUntil = Date.now() + ms;
    scene.tweens.timeScale = factor;
    for (const key of Object.keys(emitters)) {
      if ('timeScale' in emitters[key]) emitters[key].timeScale = factor;
    }
  }

  /** Cosmetic delta for this frame; also recovers from hit-stop. */
  function renderDelta(deltaMs) {
    if (renderScale < 1 && Date.now() >= renderScaleUntil) {
      renderScale = 1;
      scene.tweens.timeScale = 1;
      for (const key of Object.keys(emitters)) {
        if ('timeScale' in emitters[key]) emitters[key].timeScale = 1;
      }
    }
    return deltaMs * renderScale;
  }

  /** Pooled rising score floater (never allocate Text mid-round). */
  function floater(text, x, y, color = '#ffffff') {
    let txt = floaterPool.pop();
    if (!txt) {
      txt = scene.add.text(0, 0, '', {
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '16px', fontStyle: 'bold',
      }).setDepth(60).setOrigin(0.5);
    }
    txt.setText(text).setColor(color).setPosition(x, y).setAlpha(1).setVisible(true);
    scene.tweens.add({
      targets: txt, y: y - 42, alpha: 0, duration: 700, ease: 'Cubic.easeOut',
      onComplete: () => { txt.setVisible(false); floaterPool.push(txt); },
    });
  }

  /** Telegraph ghost: 1 s harmless warning where a dot will spawn. */
  function telegraph(x, y) {
    let g = ghostPool.pop();
    if (!g) g = scene.add.image(0, 0, 'ghost').setDepth(5);
    g.setPosition(x, y).setAlpha(0).setScale(1.4).setVisible(true);
    scene.tweens.add({
      targets: g, alpha: { from: 0.15, to: 0.6 }, scale: 0.8,
      duration: DOT_TELEGRAPH_MS, ease: 'Sine.easeIn',
      onComplete: () => { g.setVisible(false); ghostPool.push(g); },
    });
  }

  /** Expanding 120° shockwave arc, rotated to the firing angle. */
  function waveArc(x, y, angle) {
    const img = scene.add.image(x, y, 'wavearc').setDepth(45).setRotation(angle);
    const target = (WAVE.RADIUS * world.scale()) / 64; // texture radius = 64px
    img.setScale(0.15).setAlpha(0.9);
    scene.tweens.add({
      targets: img, scale: target, alpha: 0, duration: 320, ease: 'Cubic.easeOut',
      onComplete: () => img.destroy(),
    });
  }

  function ringAt(x, y, worldRadius, color = 0xffffff, ms = 400) {
    const img = scene.add.image(x, y, 'ring').setDepth(44).setTint(color);
    img.setScale(0.1).setAlpha(0.7);
    scene.tweens.add({
      targets: img, scale: (worldRadius * world.scale()) / 64, alpha: 0,
      duration: ms, ease: 'Cubic.easeOut', onComplete: () => img.destroy(),
    });
  }

  /** Called by the scene when the local player taps a wave — instant juice;
   *  the authoritative 'wv' echo within OWN_WAVE_DEDUPE_MS is skipped. */
  function localWave(x, y, angle) {
    lastOwnWaveAt = Date.now();
    waveArc(x, y, angle);
    sfx.wave();
    shakePx(6, 160);
  }

  /* ------------------------------------------------- server event tuples -- */

  function handleEvent(ev) {
    const code = ev[0];
    const mySlot = world.mySlot();
    switch (code) {
      case EV.DOT_KILLS: { // ['dk', slot, n, xq, yq]
        const [, slot, n, xq, yq] = ev;
        const x = world.toX(dqPos(xq));
        const y = world.toY(dqPos(yq));
        emitters.pop.explode(Math.min(6 + n * 3, 40), x, y);
        floater('+' + fmtNum(n), x, y, slot === mySlot ? '#ffffff' : '#9ca3af');
        sfx.pop(n);
        if (n >= 8) { shakePx(2, 100); hitStop(70, 0.3); } // big scatter/wave haul
        break;
      }
      case EV.DEATH: { // ['de', slot, cause, killerSlot]
        const [, slot] = ev;
        const p = world.getPlayerPos(slot);
        if (p) {
          emitters.death.explode(60, p.x, p.y);
          ringAt(p.x, p.y, CORPSE_CLEAR_RADIUS, 0xffffff, 500); // mercy vaporize radius
        }
        sfx.death();
        shakePx(6, 220);
        hitStop(110, 0.15);
        if (slot === mySlot) flash(120, 244, 63, 94);
        break;
      }
      case EV.WAVE: { // ['wv', slot, xq, yq, angleq]
        const [, slot, xq, yq, angleq] = ev;
        if (slot === mySlot && Date.now() - lastOwnWaveAt < OWN_WAVE_DEDUPE_MS) break;
        waveArc(world.toX(dqPos(xq)), world.toY(dqPos(yq)), dqAng(angleq));
        sfx.wave();
        shakePx(slot === mySlot ? 6 : 3, 150);
        break;
      }
      case EV.FIRE: { // ['fi', slot, weapon, fireSeq] — muzzle flash
        const [, slot, weapon, fireSeq] = ev;
        if (slot === mySlot && world.ownFireSeqs().has(fireSeq)) break; // already flashed locally
        const p = world.getPlayerPos(slot);
        if (p) emitters.impact.explode(weapon === WEAPON_SEEKER ? 10 : 6, p.x, p.y);
        if (weapon === WEAPON_SCATTER) sfx.scatter(); else sfx.missile();
        break;
      }
      case EV.PICKUP: { // ['pk', slot, orbType]
        const [, slot] = ev;
        const p = world.getPlayerPos(slot);
        if (p) emitters.impact.explode(12, p.x, p.y);
        sfx.pickup();
        break;
      }
      case EV.COMBO: { // ['cb', slot, chain] — milestone (>= 5)
        const [, slot, chain] = ev;
        const p = world.getPlayerPos(slot);
        if (p) floater('×' + chain, p.x, p.y - 14, '#22d3ee');
        if (slot === mySlot) sfx.combo(chain); // rising pitch ladder
        break;
      }
      case EV.TELEGRAPH: { // ['tg', xq, yq]
        telegraph(world.toX(dqPos(ev[1])), world.toY(dqPos(ev[2])));
        break;
      }
      case EV.STAGGER: { // ['st', slot]
        const p = world.getPlayerPos(ev[1]);
        if (p) emitters.blast.explode(20, p.x, p.y);
        sfx.boom();
        if (ev[1] === mySlot) { shakePx(4, 180); sfx.stagger(); }
        break;
      }
      case EV.KNOCKBACK: { // ['kb', slot]
        const p = world.getPlayerPos(ev[1]);
        if (p) emitters.impact.explode(8, p.x, p.y);
        break;
      }
      default: break; // forward-compatible: unknown events are ignored
    }
  }

  /** One spark behind a live missile (scene calls this ~every 40 ms). */
  function missileTrail(x, y) { emitters.blast.explode(1, x, y); }

  /** Instant local muzzle burst for our own tap (event echo is deduped). */
  function muzzle(x, y, big) { emitters.impact.explode(big ? 10 : 6, x, y); }

  return {
    makeEmitters, handleEvent, renderDelta, localWave, floater, shakePx,
    flash, hitStop, missileTrail, muzzle,
  };
}
