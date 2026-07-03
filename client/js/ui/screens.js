/**
 * Tilt Royale — DOM overlay screens (lobby / countdown / spectate / results /
 * connection banners). DOM, not canvas: free i18n + screen-reader semantics +
 * crisp text on any DPR.
 *
 * The Ready button is LOCAL-ONLY by design — there is no ready message in
 * the protocol. Its real job is the iOS motion-permission gesture + the
 * 300 ms tilt calibration; the SERVER starts the round (auto-start when
 * >= MIN_PLAYERS). One button, three jobs, zero explanation needed.
 */
import { t, fmtNum, fmtClock } from '../i18n.js';
import { MIN_PLAYERS, MAX_PLAYERS } from '/shared/constants.js';

const SLOT_COLORS = ['#ffffff', '#60a5fa', '#f59e0b', '#f472b6'];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export function createScreens({ bus, receiver, tilt, sfx, mode, onArmed }) {
  const root = document.getElementById('screens');
  const banner = document.getElementById('banner');
  let current = null;          // mounted screen element
  let armed = false;           // user tapped Ready (tilt requested + calibrated)
  let lastCountdownN = null;

  function mount(node) {
    root.textContent = '';
    current = node;
    if (node) root.appendChild(node);
  }

  function showBanner(text, warn) {
    banner.hidden = false;
    banner.textContent = text;
    banner.classList.toggle('warn', !!warn);
  }
  function hideBanner() { banner.hidden = true; }

  /* -------------------------------------------------------------- lobby -- */

  function lobbyScreen() {
    const s = el('div', 'screen');
    s.appendChild(el('div', 'title', t('app.title')));
    s.appendChild(el('div', 'subtitle', t('lobby.subtitle')));

    const roster = el('div', 'roster');
    roster.id = 'lobby-roster';
    s.appendChild(roster);

    const count = el('div', 'hint');
    count.id = 'lobby-players';
    s.appendChild(count);

    const status = el('div', 'status-line');
    status.id = 'lobby-status';
    s.appendChild(status);

    const ready = el('button', 'btn clickable', t('lobby.ready'));
    ready.addEventListener('click', () => onReadyTap(ready, status));
    s.appendChild(ready);

    if (mode === 'platform') s.appendChild(el('div', 'hint', t('lobby.inviteHint')));

    const mute = el('button', 'btn ghost clickable', sfx.isMuted() ? '🔇' : '🔊');
    mute.setAttribute('aria-label', t('hud.mute'));
    mute.style.minWidth = '44px';
    mute.addEventListener('click', () => { mute.textContent = sfx.toggleMute() ? '🔇' : '🔊'; });
    s.appendChild(mute);
    return s;
  }

  async function onReadyTap(button, status) {
    button.disabled = true;
    sfx.ensure(); // first gesture unlocks WebAudio
    // iOS motion permission MUST happen inside this tap, every page load.
    const perm = await tilt.requestPermission();
    if (perm === 'granted') {
      status.textContent = t('calib.hold');
      tilt.startCalibration();
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          if (!tilt.isCalibrating() && tilt.isCalibrated()) { clearInterval(iv); resolve(); }
        }, 50);
        setTimeout(() => { clearInterval(iv); resolve(); }, 2500); // sensor never ticked — bail
      });
      status.textContent = t('calib.done');
    } else if (perm === 'insecure') {
      status.textContent = t('tilt.insecure');
    } else {
      status.textContent = t('tilt.denied'); // touch-drag / WASD still work
    }
    armed = true;
    if (onArmed) onArmed();
    setTimeout(() => refresh(), 600); // let the user read the calib result
  }

  function renderRoster() {
    const box = document.getElementById('lobby-roster');
    const status = document.getElementById('lobby-status');
    if (!box) return;
    const roster = receiver.getRoster();
    box.textContent = '';
    for (const r of roster) {
      const chip = el('span', 'chip');
      const dot = el('span', 'dot');
      dot.style.background = SLOT_COLORS[r.slot] || '#fff';
      chip.appendChild(dot);
      chip.appendChild(el('span', null, r.name || '…'));
      if (r.slot === receiver.mySlot()) chip.appendChild(el('span', 'you', '(' + t('lobby.you') + ')'));
      box.appendChild(chip);
    }
    for (let i = roster.length; i < MIN_PLAYERS; i++) {
      box.appendChild(el('span', 'chip empty', t('lobby.openSeat')));
    }
    if (status && armed) {
      status.textContent = roster.length >= MIN_PLAYERS ? t('lobby.starting') : t('lobby.waiting');
    }
    const players = document.getElementById('lobby-players');
    if (players) players.textContent = t('lobby.players', { n: roster.length, max: MAX_PLAYERS });
  }

  /* ---------------------------------------------------------- countdown -- */

  function countdownScreen() {
    const s = el('div', 'screen');
    s.style.background = 'transparent';
    s.style.backdropFilter = 'none';
    const num = el('div', null, '');
    num.id = 'countdown-num';
    s.appendChild(num);
    return s;
  }

  function tickCountdown() {
    if (!current || !document.getElementById('countdown-num')) return;
    const msLeft = receiver.countdownMsLeft(); // receiver guarantees a deadline
    const n = Math.max(1, Math.ceil(msLeft / 1000));
    const node = document.getElementById('countdown-num');
    const label = msLeft <= 120 ? t('countdown.go') : String(n);
    if (node.textContent !== label) {
      node.textContent = label;
      node.style.animation = 'none';
      void node.offsetWidth; // restart the punch animation
      node.style.animation = '';
      if (lastCountdownN !== label) { sfx.countdown(label === t('countdown.go')); lastCountdownN = label; }
    }
  }

  /* ------------------------------------------------------------ results -- */

  function resultsScreen(data) {
    const s = el('div', 'screen');
    const winners = data.winner_ids || [];
    s.appendChild(el('div', 'title', winners.length ? t('results.winner') : t('results.draw')));
    s.appendChild(el('div', 'subtitle', t('results.reason.' + (data.reason || 'error'))));

    const table = el('table', 'results-table');
    const head = el('tr');
    for (const k of ['results.player', 'results.score', 'results.kos', 'results.dots', 'results.combo', 'results.survival']) {
      head.appendChild(el('th', null, t(k)));
    }
    table.appendChild(head);
    const placements = (data.placements || []);
    for (const p of placements) {
      const tr = el('tr');
      if (winners.includes(p.user_id)) tr.classList.add('winner');
      if (p.slot === receiver.mySlot()) tr.classList.add('me');
      const nameCell = el('td');
      if (winners.includes(p.user_id)) nameCell.appendChild(el('span', 'crown', '👑'));
      nameCell.appendChild(document.createTextNode(p.name || p.user_id));
      tr.appendChild(nameCell);
      tr.appendChild(el('td', null, fmtNum(p.score || 0)));
      tr.appendChild(el('td', null, fmtNum(p.kills || 0)));
      tr.appendChild(el('td', null, fmtNum(p.dot_kills || 0)));
      tr.appendChild(el('td', null, '×' + fmtNum(p.best_combo || 0)));
      tr.appendChild(el('td', null, fmtClock(p.survival_ms || 0)));
      table.appendChild(tr);
    }
    s.appendChild(table);

    const again = el('button', 'btn clickable',
      mode === 'platform' ? t('results.close') : t('results.playAgain'));
    again.addEventListener('click', () => {
      if (mode === 'platform') Usion.exit(); // host owns the rejoin/re-invite flow
      else location.reload();                // dev loop: fresh join, same room
    });
    s.appendChild(again);

    const won = winners.length && placements.some(
      (p) => p.slot === receiver.mySlot() && winners.includes(p.user_id));
    if (won) sfx.win();
    return s;
  }

  /* ----------------------------------------------------------- dispatch -- */

  function refresh() {
    const phase = receiver.phase();
    if (phase === 'waiting') {
      if (!armed || !receiver.getRoster().length) {
        if (!current || !document.getElementById('lobby-roster')) mount(lobbyScreen());
        renderRoster();
      } else {
        mount(null);
        showBanner(t('lobby.waiting'));
      }
    } else if (phase === 'countdown') {
      hideBanner();
      lastCountdownN = null;
      if (!document.getElementById('countdown-num')) mount(countdownScreen());
    } else if (phase === 'playing') {
      hideBanner();
      if (current) mount(null);
      if (receiver.isSpectator()) showBanner(t('spectate.watching'));
    }
    // 'finished' waits for the match_end payload (game:matchEnd below).
  }

  bus.on('game:roster', () => { if (receiver.phase() === 'waiting') refresh(); });
  bus.on('game:phase', refresh);
  bus.on('game:me', refresh);
  bus.on('game:selfDied', () => showBanner(t('spectate.banner'), true));
  bus.on('game:matchEnd', (data) => { hideBanner(); mount(resultsScreen(data)); });
  bus.on('net:status', (s) => {
    // Once a match is finished the server tears the room down after a linger
    // window; that socket close is expected cleanup, not a fault — keep the
    // results screen quiet instead of flashing "Reconnecting…".
    if (receiver.phase() === 'finished') return;
    if (s.state === 'connecting') showBanner(t('conn.connecting'));
    else if (s.state === 'idle') hideBanner(); // solo launch — lobby, no room yet
    else if (s.state === 'reconnecting') showBanner(t('conn.reconnecting'), true);
    else if (s.state === 'connected' && receiver.phase() === 'playing') hideBanner();
    else if (s.state === 'connected') refresh();
  });
  bus.on('game:error', (e) => {
    if (e && e.code === 'ROOM_FULL') showBanner(t('conn.roomFull'), true);
  });

  // Countdown numbers repaint on a light timer (no rAF needed for DOM).
  setInterval(() => { if (receiver.phase() === 'countdown') tickCountdown(); }, 100);

  return { refresh, showBanner, hideBanner, isArmed: () => armed };
}
