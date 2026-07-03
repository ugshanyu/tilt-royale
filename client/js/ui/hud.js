/**
 * Tilt Royale — DOM HUD (round timer, weapon + ammo pips, players-left, RTT)
 * plus the ?debug=1 netcode panel: live RTT/jitter, prediction error,
 * snapshot rate/bytes, interp buffer, and chaos sliders
 * (Usion.game.simulateNetwork) with one-tap presets so anyone can feel the
 * game on "MN 4G" or "hotel wifi" before shipping.
 */
import { t, fmtClock } from '../i18n.js';
import {
  WEAPON_NONE, WEAPON_WAVE, WEAPON_SCATTER, WEAPON_SEEKER, WAVE, SCATTER, SEEKER,
} from '/shared/constants.js';

const WEAPON_META = {
  [WEAPON_NONE]: { key: 'weapon.none', color: '#52525b', max: 0 },
  [WEAPON_WAVE]: { key: 'weapon.wave', color: '#22d3ee', max: WAVE.AMMO },
  [WEAPON_SCATTER]: { key: 'weapon.scatter', color: '#f59e0b', max: SCATTER.AMMO },
  [WEAPON_SEEKER]: { key: 'weapon.seeker', color: '#a78bfa', max: SEEKER.AMMO },
};

const PRESETS = [ // label → simulateNetwork opts (null = off)
  { label: 'MN 4G', opts: { latencyMs: 120, jitterMs: 40, lossPct: 2 } },
  { label: 'hotel wifi', opts: { latencyMs: 300, jitterMs: 120, lossPct: 8 } },
  { label: 'off', opts: null },
];

export function createHud({ bus, receiver, clock, predictor, interp, connection, sfx, inputSender }) {
  const hud = document.getElementById('hud');
  const debugBox = document.getElementById('debug');
  const debugOn = new URLSearchParams(location.search).get('debug') === '1';

  hud.innerHTML = `
    <div class="hud-top">
      <span class="hud-pill" id="hud-players"></span>
      <span class="hud-pill" id="hud-timer">--:--</span>
      <span class="hud-pill" id="hud-rtt">—</span>
    </div>
    <div class="hud-bottom">
      <span class="hud-pill" id="hud-weapon">
        <span class="wdot"></span><span id="hud-weapon-name"></span>
        <span class="pips" id="hud-pips"></span>
      </span>
      <button class="icon-btn clickable" id="hud-mute"></button>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const muteBtn = $('hud-mute');
  muteBtn.setAttribute('aria-label', t('hud.mute'));
  muteBtn.textContent = sfx.isMuted() ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => { muteBtn.textContent = sfx.toggleMute() ? '🔇' : '🔊'; });

  let lastWeapon = -1;
  let lastAmmo = -1;

  function paint() {
    if (hud.hidden) return;
    const remaining = receiver.remainingMs();
    $('hud-timer').textContent = remaining == null ? '--:--' : fmtClock(remaining);
    $('hud-players').textContent = t('hud.left', { n: receiver.aliveCount() });

    const rtt = clock.getRtt();
    const rttEl = $('hud-rtt');
    rttEl.textContent = rtt == null ? '—' : t('hud.rtt', { ms: Math.round(rtt) });
    rttEl.classList.toggle('bad', rtt != null && rtt > 250);

    const row = receiver.myRow();
    const weapon = row ? row.weapon : WEAPON_NONE;
    const ammo = row ? row.ammo : 0;
    if (weapon !== lastWeapon || ammo !== lastAmmo) {
      lastWeapon = weapon;
      lastAmmo = ammo;
      const meta = WEAPON_META[weapon] || WEAPON_META[WEAPON_NONE];
      $('hud-weapon-name').textContent = t(meta.key);
      hud.querySelector('.wdot').style.background = meta.color;
      const pips = $('hud-pips');
      pips.textContent = '';
      for (let i = 0; i < meta.max; i++) {
        const pip = document.createElement('span');
        pip.className = 'pip' + (i < ammo ? '' : ' off');
        pips.appendChild(pip);
      }
    }
  }

  /* --------------------------------------------------------- debug panel -- */

  function buildDebug() {
    receiver.setStatsEnabled(true);
    const sliders = [
      { id: 'lat', label: 'latency ms', min: 0, max: 500, val: 0 },
      { id: 'jit', label: 'jitter ms', min: 0, max: 200, val: 0 },
      { id: 'loss', label: 'loss %', min: 0, max: 30, val: 0 },
    ];
    debugBox.innerHTML = `
      <div class="row"><span>rtt / jitter</span><b id="dbg-rtt">—</b></div>
      <div class="row"><span>pred err</span><b id="dbg-pred">—</b></div>
      <div class="row"><span>snapshots</span><b id="dbg-snap">—</b></div>
      <div class="row"><span>interp buf</span><b id="dbg-buf">—</b></div>
      <div class="row"><span>input hz</span><b id="dbg-hz">—</b></div>
      ${sliders.map((s) => `<label>${s.label} <b id="dbg-${s.id}-v">${s.val}</b>
        <input type="range" id="dbg-${s.id}" min="${s.min}" max="${s.max}" value="${s.val}"></label>`).join('')}
      <div class="presets">${PRESETS.map((p, i) => `<button data-preset="${i}">${p.label}</button>`).join('')}</div>`;
    debugBox.hidden = false;

    const apply = () => {
      const latencyMs = Number($('dbg-lat').value);
      const jitterMs = Number($('dbg-jit').value);
      const lossPct = Number($('dbg-loss').value);
      $('dbg-lat-v').textContent = latencyMs;
      $('dbg-jit-v').textContent = jitterMs;
      $('dbg-loss-v').textContent = lossPct;
      connection.setNetworkSim(latencyMs || jitterMs || lossPct
        ? { latencyMs, jitterMs, lossPct } : null);
    };
    for (const s of sliders) $('dbg-' + s.id).addEventListener('input', apply);
    debugBox.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = PRESETS[Number(btn.dataset.preset)];
        $('dbg-lat').value = p.opts ? p.opts.latencyMs : 0;
        $('dbg-jit').value = p.opts ? p.opts.jitterMs : 0;
        $('dbg-loss').value = p.opts ? p.opts.lossPct : 0;
        apply();
      });
    });

    setInterval(() => {
      const rtt = clock.getRtt();
      $('dbg-rtt').textContent = rtt == null ? '—'
        : `${Math.round(rtt)} / ${Math.round(clock.getJitter())} ms`;
      $('dbg-pred').textContent = predictor.lastCorrection().toFixed(2) + ' u';
      const st = receiver.drainStats();
      $('dbg-snap').textContent = `${st.hz.toFixed(1)} Hz · ${(st.bytesPerSec / 1024).toFixed(1)} KB/s`;
      $('dbg-buf').textContent = Math.round(interp.bufferMs()) + ' ms';
      $('dbg-hz').textContent = String(inputSender.currentHz());
    }, 500);
  }

  bus.on('game:phase', ({ phase }) => { hud.hidden = !(phase === 'playing' || phase === 'countdown'); });
  setInterval(paint, 250); // DOM HUD needs ~4 Hz, not 60
  if (debugOn) buildDebug();

  return { paint };
}
