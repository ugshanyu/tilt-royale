/**
 * Tilt Royale — boot orchestrator. Builds the modules, wires the bus, runs
 * the phase state machine. All the interesting logic lives in the modules;
 * this file should read like a table of contents.
 *
 * Connection modes:
 *  - PLATFORM: embedded in the Usion host (iframe/WebView) → SDK direct-mode
 *    socket (see net/connection.js).
 *  - LOCAL: opened straight in a browser against `npm run dev` → raw WS with
 *    a dev token, identical server code paths.
 */
import { initI18n, t } from './i18n.js';
import { createBus, createConnection } from './net/connection.js';
import { createReceiver } from './net/receiver.js';
import { createInputSender } from './net/input-sender.js';
import { createClock } from './net/clock.js';
import { createOwnPredictor } from './game/predictor.js';
import { createInterpGroups } from './game/interp.js';
import { createPredictedShots } from './game/predicted-shots.js';
import { createTilt } from './input/tilt.js';
import { createKeyboard } from './input/keyboard.js';
import { createSfx } from './audio/sfx.js';
import { createScreens } from './ui/screens.js';
import { createHud } from './ui/hud.js';
import { ArenaScene } from './scenes/ArenaScene.js';
import {
  WEAPON_NONE, WEAPON_WAVE, WEAPON_SCATTER, WEAPON_SEEKER, WAVE, SCATTER, SEEKER,
} from '/shared/constants.js';

const COOLDOWNS = {
  [WEAPON_WAVE]: WAVE.COOLDOWN_MS,
  [WEAPON_SCATTER]: SCATTER.COOLDOWN_MS,
  [WEAPON_SEEKER]: SEEKER.COOLDOWN_MS,
};
const RECENT_FS_MS = 1_000; // window for deduping our own 'fi' event echoes

function fatal(message) {
  const b = document.getElementById('banner');
  b.hidden = false;
  b.classList.add('warn');
  b.textContent = message;
}

async function boot() {
  if (typeof Phaser === 'undefined') { fatal(t('error.noPhaser')); return; }
  if (typeof Usion === 'undefined') { fatal(t('error.noSdk')); return; }

  const params = new URLSearchParams(location.search);
  // Embedded (iframe or RN WebView) → platform; a bare browser tab → local dev.
  const embedded = !!window.ReactNativeWebView || window.parent !== window;
  const mode = embedded ? 'platform' : 'local';

  let hostLang = null;
  if (mode === 'platform') {
    try { await Usion.init({ timeout: 15_000 }); } catch (e) {
      fatal(t('error.noSdk'));
      return;
    }
    hostLang = (Usion.config && Usion.config.language) ||
      (typeof Usion.getLanguage === 'function' ? Usion.getLanguage() : null);
  }
  initI18n({ urlLang: params.get('lang'), hostLang });

  // Local-dev identity: ?player= / ?room=, prompting as a last resort.
  const playerName = mode === 'local'
    ? (params.get('player') || window.prompt(t('local.enterName')) ||
       'player-' + Math.random().toString(36).slice(2, 6))
    : null;
  const roomId = mode === 'local' ? (params.get('room') || 'local-room') : null;

  /* ------------------------------------------------------- module graph -- */
  const bus = createBus();
  const sfx = createSfx();
  const tilt = createTilt({ onLog: (m) => console.warn('[tilt]', m) });
  const keyboard = createKeyboard({ onFire: () => fireAction() });
  const predictor = createOwnPredictor();
  const interp = createInterpGroups();
  const shots = createPredictedShots();
  const connection = createConnection({ mode, bus, roomId, playerName });
  const clock = createClock({ connection });

  // Last merged input sample — the scene advances it once per frame; the
  // input sender composes payloads from it at flush time.
  const controls = {
    last: { mx: 0, my: 0 },
    sample(deltaMs) {
      const ts = tilt.state();
      const kb = keyboard.tick(deltaMs);
      this.last = ts.active ? { mx: ts.mx, my: ts.my } : { mx: kb.mx, my: kb.my };
      return this.last;
    },
  };

  const inputSender = createInputSender({
    connection,
    clock,
    getPayloadParts: () => ({
      mx: controls.last.mx,
      my: controls.last.my,
      iseq: predictor.iseq(),
      interpMs: interp.bufferMs(),
    }),
  });

  const receiver = createReceiver({ bus, connection, predictor, interp, shots });
  const screens = createScreens({ bus, receiver, tilt, sfx, mode, onArmed: () => {} });
  createHud({ bus, receiver, clock, predictor, interp, connection, sfx, inputSender });

  /* ------------------------------------------------------------- firing -- */
  let fireSeq = 0;
  let lastLocalFireAt = 0;
  const recentFs = new Map(); // fs → sentAt, for own-event dedupe

  function ownFireSeqs() {
    const now = Date.now();
    const set = shots.liveFireSeqs();
    for (const [fs, at] of recentFs) {
      if (now - at > RECENT_FS_MS) recentFs.delete(fs);
      else set.add(fs);
    }
    return set;
  }

  function fireAction() {
    sfx.ensure();
    if (receiver.phase() !== 'playing' || receiver.isSpectator()) return;
    const row = receiver.myRow();
    if (!row || !row.alive || !connection.isConnected()) return;

    // The tap ALWAYS goes to the server (it may know about a pickup we
    // haven't seen yet — server state wins). Local FX/prediction only run
    // when OUR view of weapon/ammo/cooldown says the shot is legal, so we
    // never predict a shot the server would reject.
    fireSeq += 1;
    const fs = fireSeq;
    inputSender.fire(fs);

    const now = Date.now();
    const legal = row.weapon !== WEAPON_NONE && row.ammo > 0 &&
      now - lastLocalFireAt >= (COOLDOWNS[row.weapon] || 0) && !row.stagger;
    if (!legal || !sceneRef) return;
    lastLocalFireAt = now;
    recentFs.set(fs, now);

    const pose = predictor.view() || row;
    const sx = sceneRef.toX(pose.x);
    const sy = sceneRef.toY(pose.y);
    if (row.weapon === WEAPON_SCATTER) {
      shots.onFire(pose, fs);          // predicted pellets, reconciled by fire_seq
      sceneRef.fx.muzzle(sx, sy, false);
      sfx.scatter();
    } else if (row.weapon === WEAPON_WAVE) {
      sceneRef.fx.localWave(sx, sy, pose.angle); // cosmetic arc only — the wave
      // itself is server-side lag-compensated hitscan; kills arrive as events.
    } else if (row.weapon === WEAPON_SEEKER) {
      sceneRef.fx.muzzle(sx, sy, true); // muzzle flash only: NO prediction —
      sfx.missile();                    // homing targets are picked server-side.
    }
  }

  /* -------------------------------------------------------------- scene -- */
  let sceneRef = null;
  const sceneReady = new Promise((resolve) => {
    const ctx = {
      bus, connection, receiver, predictor, interp, shots,
      tilt, keyboard, controls, inputSender, sfx,
      ownFireSeqs,
      onFireTap: fireAction,
      onReady: (scene) => { sceneRef = scene; resolve(); },
    };
    new Phaser.Game({
      type: Phaser.AUTO,             // WebGL with canvas fallback
      parent: 'game',
      backgroundColor: '#000000',
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
      // Deliberately NO physics config: Phaser renders, the server simulates.
      scene: new ArenaScene(ctx),
    });
  });

  /* ------------------------------------------------------ state machine -- */
  bus.on('game:phase', ({ phase }) => {
    if (phase === 'playing' || phase === 'countdown') {
      if (connection.isConnected()) inputSender.start();
    } else {
      inputSender.stop();
    }
  });
  bus.on('net:status', ({ state }) => {
    if (state === 'reconnecting') {
      inputSender.stop(); // pause input while the SDK/backoff reconnects
    } else if (state === 'connected') {
      const phase = receiver.phase();
      if (phase === 'playing' || phase === 'countdown') inputSender.start();
    }
  });
  bus.on('game:matchEnd', () => { inputSender.stop(); clock.stop(); });

  // Backgrounded tab: park the arrow (the server replays the LAST input
  // forever) and resync on return — a hidden tab misses deltas, so ask for a
  // keyframe instead of trusting the gap.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (inputSender.isRunning()) inputSender.sendNeutral();
    } else {
      connection.requestKeyframe(Math.max(0, receiver.lastSnapshotSeq()));
    }
  });

  /* --------------------------------------------------------------- go ---- */
  screens.refresh();               // lobby paints while we connect
  // Connect and scene-boot CONCURRENTLY. Phaser only ticks (and thus only
  // fires the scene's create()) once the page renders a frame — a hidden or
  // backgrounded WebView would otherwise never connect at all. The receiver
  // owns all state and tolerates the scene booting late (it re-reads the
  // roster in create()); the scene merely renders whatever state exists.
  const connected = connection.start().catch((e) => {
    fatal(t('error.generic', { msg: (e && e.message) || 'connect failed' }));
    throw e;
  });
  try {
    await Promise.all([sceneReady, connected]);
  } catch {
    return; // fatal() already shown
  }
  clock.start();
}

boot();
