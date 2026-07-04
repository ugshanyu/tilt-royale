/**
 * Tilt Royale — the Phaser scene. ENGINE RENDERS, SERVER SIMULATES: Phaser is
 * strictly the render/input/pooling layer. No physics plugin is configured
 * and no gameplay position is ever computed here — every coordinate comes
 * from the netcode modules (own arrow: predictor; everything else:
 * interpolation views; pellets-in-flight: predicted-shots).
 *
 * Perf discipline for low-end phones: all textures are generated once at
 * boot (Graphics.generateTexture — zero asset downloads), and every visual
 * is a POOLED sprite. The per-frame loop only sets position/visible/alpha —
 * it never allocates.
 */
import {
  ARENA, PLAYER_RADIUS, DOT_RADIUS, ORB_RADIUS, PELLET_RADIUS, MISSILE_RADIUS,
  MAX_DOTS, MAX_PROJECTILES, MAX_ORBS, MAX_PLAYERS, FACING_MIN_SPEED,
  WEAPON_WAVE, WEAPON_SCATTER, WEAPON_SEEKER,
} from '/shared/constants.js';
import { createFx } from './FxHelpers.js';

const SLOT_TINTS = [0xffffff, 0x60a5fa, 0xf59e0b, 0xf472b6];
const ORB_TINTS = { [WEAPON_WAVE]: 0x22d3ee, [WEAPON_SCATTER]: 0xf59e0b, [WEAPON_SEEKER]: 0xa78bfa };
const DOT_TINT = 0xf43f5e;
const DRAG_START_PX = 14;   // pointer move beyond this = drag (virtual tilt), else tap = fire

/** Fixed-size sprite pool: acquire by index, hide the tail. */
function makePool(scene, n, tex, depth) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(scene.add.image(-99, -99, tex).setDepth(depth).setVisible(false));
  return {
    use(i) { const s = arr[i]; s.setVisible(true); return s; },
    hideFrom(count) { for (let i = count; i < arr.length; i++) arr[i].setVisible(false); },
  };
}

export class ArenaScene extends Phaser.Scene {
  constructor(ctx) {
    super({ key: 'arena' });
    this.ctx = ctx;            // { bus, connection, receiver, predictor, interp,
    this.lastPos = [];         //   shots, tilt, keyboard, inputSender, sfx, onFireTap, onReady }
    this.trailAcc = 0;
  }

  create() {
    this.genTextures();
    this.fx = createFx(this, this.ctx.sfx, this.worldApi());
    this.fx.makeEmitters();

    this.borderG = this.add.graphics().setDepth(1);
    this.dotPool = makePool(this, MAX_DOTS, 'dot', 20);
    this.pelletPool = makePool(this, MAX_PROJECTILES, 'pellet', 30);
    this.missilePool = makePool(this, MAX_PROJECTILES, 'missile', 30);
    this.predPool = makePool(this, 48, 'pellet', 31);
    this.orbPool = makePool(this, MAX_ORBS, 'orb', 10);
    this.players = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      this.players.push({
        sprite: this.add.image(-99, -99, 'arrow').setDepth(40).setVisible(false),
        label: this.add.text(-99, -99, '', { fontFamily: 'sans-serif', fontSize: '11px', color: '#9ca3af' })
          .setOrigin(0.5, 1).setDepth(41).setVisible(false),
        ring: this.add.image(-99, -99, 'ownring').setDepth(39).setVisible(false),
      });
    }

    this.layout();
    this.scale.on('resize', () => this.layout());
    this.setupPointer();
    // Cache roster names by slot — the render loop must not allocate.
    const cacheNames = (list) => {
      this.names = [];
      for (const r of list) this.names[r.slot] = r.name || '';
    };
    cacheNames(this.ctx.receiver.getRoster()); // scene may boot after 'joined'
    this.ctx.bus.on('game:roster', cacheNames);
    this.ctx.bus.on('game:event', (ev) => this.fx.handleEvent(ev));
    this.ctx.bus.on('game:selfDied', () => this.applyDeathLook());
    if (this.ctx.onReady) this.ctx.onReady(this);
  }

  /** Runtime textures — white shapes, tinted at render time. */
  genTextures() {
    const g = this.add.graphics();
    const tex = (key, w, h, draw) => { g.clear(); draw(g); g.generateTexture(key, w, h); };
    tex('spark', 8, 8, (gg) => { gg.fillStyle(0xffffff); gg.fillCircle(4, 4, 4); });
    tex('dot', 16, 16, (gg) => { gg.fillStyle(0xffffff); gg.fillCircle(8, 8, 8); });
    tex('pellet', 10, 10, (gg) => { gg.fillStyle(0xffffff); gg.fillCircle(5, 5, 5); });
    tex('missile', 24, 10, (gg) => {
      gg.fillStyle(0xffffff);
      gg.fillTriangle(24, 5, 6, 0, 6, 10); gg.fillRect(0, 3, 8, 4);
    });
    tex('arrow', 32, 32, (gg) => {
      gg.fillStyle(0xffffff);
      gg.fillTriangle(32, 16, 4, 4, 4, 28);   // points +x; rotation = facing
      gg.fillStyle(0x000000); gg.fillTriangle(12, 16, 6, 8, 6, 24);
    });
    tex('ownring', 48, 48, (gg) => { gg.lineStyle(2, 0xffffff, 0.9); gg.strokeCircle(24, 24, 22); });
    tex('orb', 48, 48, (gg) => {
      gg.lineStyle(4, 0xffffff, 1); gg.strokeCircle(24, 24, 20);
      gg.fillStyle(0xffffff); gg.fillCircle(24, 24, 6);
    });
    tex('ghost', 24, 24, (gg) => { gg.lineStyle(2, 0xf43f5e, 1); gg.strokeCircle(12, 12, 10); });
    tex('ring', 128, 128, (gg) => { gg.lineStyle(5, 0xffffff, 1); gg.strokeCircle(64, 64, 62); });
    tex('wavearc', 128, 128, (gg) => {
      gg.lineStyle(8, 0x22d3ee, 1);
      gg.beginPath(); gg.arc(64, 64, 58, -Math.PI / 3, Math.PI / 3); gg.strokePath();
    });
    g.destroy();
  }

  /** Square 120×120 world letterboxed into the canvas. */
  layout() {
    const w = this.scale.width;
    const h = this.scale.height;
    const side = Math.min(w, h);
    this.s = side / ARENA;
    this.ox = (w - side) / 2;
    this.oy = (h - side) / 2;
    this.borderG.clear();
    this.borderG.fillStyle(0x0a0a0a, 1).fillRect(this.ox, this.oy, side, side);
    this.borderG.lineStyle(1, 0x27272a, 1).strokeRect(this.ox, this.oy, side, side);
  }

  toX(wx) { return this.ox + wx * this.s; }
  toY(wy) { return this.oy + wy * this.s; }
  px(worldUnits) { return worldUnits * this.s; }

  worldApi() {
    return {
      toX: (wx) => this.toX(wx),
      toY: (wy) => this.toY(wy),
      scale: () => this.s,
      getPlayerPos: (slot) => this.lastPos[slot] || null,
      mySlot: () => this.ctx.receiver.mySlot(),
      ownFireSeqs: () => this.ctx.ownFireSeqs(), // predicted + recent local fs
    };
  }

  /** Tap = fire. Drag (when tilt is off) = virtual tilt via keyboard module. */
  setupPointer() {
    const kb = this.ctx.keyboard;
    let down = null;
    this.input.on('pointerdown', (p) => {
      down = { x: p.x, y: p.y, dragging: false };
      if (this.ctx.tilt.state().active) {
        this.ctx.onFireTap();      // tilt users: fire on touch-down (lowest latency)
        down = null;
      }
    });
    this.input.on('pointermove', (p) => {
      if (!down) return;
      if (!down.dragging && Math.hypot(p.x - down.x, p.y - down.y) > DRAG_START_PX) {
        down.dragging = true;
        kb.dragStart(down.x, down.y);
      }
      if (down.dragging) kb.dragMove(p.x, p.y);
    });
    const up = () => {
      if (!down) return;
      if (down.dragging) kb.dragEnd();
      else this.ctx.onFireTap();   // clean tap without tilt = fire
      down = null;
    };
    this.input.on('pointerup', up);
    this.input.on('pointerupoutside', up);
  }

  applyDeathLook() {
    try { this.cameras.main.postFX.addColorMatrix().saturate(-0.75); }
    catch (e) { this.cameras.main.setAlpha(0.75); } // canvas-renderer fallback
  }

  update(time, delta) {
    const c = this.ctx;
    const rd = this.fx.renderDelta(delta); // render-scaled delta (hit-stop) — cosmetics ONLY
    const now = Date.now();
    window.__TR_frames = (window.__TR_frames || 0) + 1; // render watchdog (main.js)

    // ---- input → prediction → outbound stream (wall-clock, never rd) ----
    const merged = c.controls.sample(delta); // tilt when active, else keyboard/drag
    const row = c.receiver.myRow();
    const phase = c.receiver.phase();
    const driving = phase === 'playing' && row && row.alive &&
      !c.receiver.isSpectator() && c.connection.isConnected();
    if (driving) {
      // Mirror the server's stagger input-freeze so reconcile stays silent.
      c.predictor.advance(now, row.stagger ? { mx: 0, my: 0 } : merged);
    }
    if (driving || phase === 'countdown') c.inputSender.tick();

    // ---- own arrow: predictor when driving, server row otherwise ----
    const me = this.players[c.receiver.mySlot()] || null;
    if (row && me) {
      const pose = (driving && c.predictor.isInited()) ? c.predictor.view() : row;
      this.drawPlayer(me, c.receiver.mySlot(), pose.x, pose.y, pose.angle, row, true, time);
      if (!row.alive) { me.sprite.setVisible(false); me.label.setVisible(false); me.ring.setVisible(false); }
    } else if (me) {
      me.sprite.setVisible(false); me.label.setVisible(false); me.ring.setVisible(false);
    }

    // ---- remote players from interpolation ----
    // Facing is derived from interpolated velocity (facing IS velocity
    // direction, per shared/movement.js) and eased on the shortest arc —
    // never from raw/extrapolated angle, which whip-spins across the ±π wrap.
    if (!this.remoteAngle) this.remoteAngle = new Map();
    const seen = new Set([c.receiver.mySlot()]);
    for (const rp of c.interp.viewPlayers()) {
      const p = this.players[rp.id];
      if (!p) continue;
      seen.add(rp.id);
      if (!rp.alive) { p.sprite.setVisible(false); p.label.setVisible(false); continue; }
      const moving = Math.hypot(rp.vx || 0, rp.vy || 0) > FACING_MIN_SPEED;
      const target = moving ? Math.atan2(rp.vy, rp.vx)
        : (this.remoteAngle.get(rp.id) ?? rp.angle ?? 0);
      const prev = this.remoteAngle.get(rp.id) ?? target;
      let dA = target - prev;
      if (dA > Math.PI) dA -= 2 * Math.PI;
      else if (dA < -Math.PI) dA += 2 * Math.PI;
      const eased = prev + dA * 0.35;
      this.remoteAngle.set(rp.id, eased);
      this.drawPlayer(p, rp.id, rp.x, rp.y, eased, rp, false, time);
    }
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      if (!seen.has(slot)) { const p = this.players[slot]; p.sprite.setVisible(false); p.label.setVisible(false); p.ring.setVisible(false); }
    }

    // ---- dots ----
    const dots = c.interp.viewDots();
    const dotD = this.px(DOT_RADIUS * 2);
    for (let i = 0; i < dots.length && i < MAX_DOTS; i++) {
      const s = this.dotPool.use(i);
      s.setPosition(this.toX(dots[i].x), this.toY(dots[i].y)).setTint(DOT_TINT).setDisplaySize(dotD, dotD);
    }
    this.dotPool.hideFrom(Math.min(dots.length, MAX_DOTS));

    // ---- authoritative projectiles (minus ones our prediction still covers) ----
    const projs = c.shots.filterAuth(c.interp.viewProjs(), c.receiver.mySlot());
    let np = 0;
    let nm = 0;
    this.trailAcc += rd;
    const emitTrail = this.trailAcc > 40;
    if (emitTrail) this.trailAcc = 0;
    for (const pr of projs) {
      if (pr.kind === WEAPON_SEEKER) {
        if (nm >= MAX_PROJECTILES) continue;
        const s = this.missilePool.use(nm++);
        s.setPosition(this.toX(pr.x), this.toY(pr.y)).setTint(0xa78bfa)
          .setDisplaySize(this.px(MISSILE_RADIUS * 6), this.px(MISSILE_RADIUS * 2.5))
          .setRotation(Math.atan2(pr.vy ?? 0, pr.vx ?? 1));
        if (emitTrail) this.fx.missileTrail(s.x, s.y);
      } else {
        if (np >= MAX_PROJECTILES) continue;
        const s = this.pelletPool.use(np++);
        const d = this.px(PELLET_RADIUS * 2);
        s.setPosition(this.toX(pr.x), this.toY(pr.y)).setTint(0xf59e0b).setAlpha(1).setDisplaySize(d, d);
      }
    }
    this.pelletPool.hideFrom(np);
    this.missilePool.hideFrom(nm);

    // ---- predicted pellets (cosmetic sim steps on RENDER delta) ----
    c.shots.step(rd);
    const pred = c.shots.view();
    const pd = this.px(PELLET_RADIUS * 2);
    for (let i = 0; i < pred.length && i < 48; i++) {
      const s = this.predPool.use(i);
      s.setPosition(this.toX(pred[i].x), this.toY(pred[i].y)).setTint(0xfbbf24)
        .setAlpha(pred[i].alpha).setDisplaySize(pd, pd);
    }
    this.predPool.hideFrom(Math.min(pred.length, 48));

    // ---- orbs (≤3, straight from the latest snapshot — static pickups) ----
    const orbs = c.receiver.orbs();
    const od = this.px(ORB_RADIUS * 2);
    const pulse = 0.75 + 0.25 * Math.sin(time / 220);
    for (let i = 0; i < orbs.length && i < MAX_ORBS; i++) {
      const s = this.orbPool.use(i);
      s.setPosition(this.toX(orbs[i].x), this.toY(orbs[i].y))
        .setTint(ORB_TINTS[orbs[i].type] || 0xffffff).setAlpha(pulse).setDisplaySize(od, od);
    }
    this.orbPool.hideFrom(Math.min(orbs.length, MAX_ORBS));
  }

  drawPlayer(p, slot, wx, wy, angle, flags, isOwn, time) {
    const x = this.toX(wx);
    const y = this.toY(wy);
    this.lastPos[slot] = { x, y }; // FX anchor (death bursts outlive the sprite)
    const d = this.px(PLAYER_RADIUS * 2.4);
    p.sprite.setVisible(true).setPosition(x, y).setRotation(angle)
      .setTint(SLOT_TINTS[slot] || 0xffffff).setDisplaySize(d, d);
    // Spawn-shield shimmer / seeker-stagger flicker / disconnect dim.
    let alpha = 1;
    if (flags.shield) alpha = 0.55 + 0.35 * Math.sin(time / 60);
    if (flags.stagger) p.sprite.setTint((Math.floor(time / 60) % 2) ? 0xf43f5e : 0xffffff);
    if (flags.connected === false) alpha = 0.35;
    p.sprite.setAlpha(alpha);

    const name = this.names[slot] || '';
    p.label.setVisible(!isOwn && !!name).setPosition(x, y - d * 0.8).setText(name);
    p.ring.setVisible(isOwn).setPosition(x, y).setAlpha(0.7)
      .setDisplaySize(d * 1.5, d * 1.5);
  }
}
