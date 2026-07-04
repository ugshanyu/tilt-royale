/**
 * Tilt Royale — connection layer. ONE uniform event surface over two modes:
 *
 *  PLATFORM  — inside the Usion host. The SDK owns the socket
 *              (Usion.game.connectDirect): access-token fetch, join-on-open,
 *              25s heartbeat, capped-backoff auto-reconnect + requestSync.
 *  LOCAL DEV — no host. We open ws://<host>/ws?token=dev:<name>:<room> and
 *              REPLICATE the SDK's direct-mode envelope + heartbeat +
 *              reconnect behavior byte-for-byte, so both modes exercise the
 *              exact same server code paths.
 *
 * Everything downstream (receiver/sender/clock) talks only to this module.
 */
const SERVICE_ID = 'tilt-royale';
const HEARTBEAT_MS = 25_000;         // mirrors the SDK's direct-mode interval
const RECONNECT_BASE_MS = 1_000;     // mirrors _scheduleDirectReconnect
const RECONNECT_MAX_MS = 15_000;
const PING_TIMEOUT_MS = 3_000;

/** Minimal pub/sub bus shared by the whole client. */
export function createBus() {
  const map = new Map();
  return {
    on(event, cb) {
      if (!map.has(event)) map.set(event, []);
      map.get(event).push(cb);
      return () => {
        const list = map.get(event) || [];
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit(event, payload) {
      const list = map.get(event);
      if (!list) return;
      for (const cb of list.slice()) {
        try { cb(payload); } catch (e) { console.error('[bus]', event, e); }
      }
    },
  };
}

/**
 * @param {{ mode: 'platform'|'local', bus: ReturnType<createBus>,
 *           roomId?: string, playerName?: string }} opts
 * @returns {{ mode, identity:{userId:string|null,userName:string|null},
 *             start:()=>Promise<void>, send:(type:string,payload:object)=>void,
 *             requestKeyframe:(lastS:number)=>void, ping:()=>Promise<number|null>,
 *             setNetworkSim:(opts:object|null)=>void, isConnected:()=>boolean }}
 */
export function createConnection(opts) {
  return opts.mode === 'platform' ? platformConnection(opts) : localConnection(opts);
}

/* ------------------------------------------------------------- platform -- */

function platformConnection({ bus }) {
  const identity = { userId: null, userName: null };

  // The stock SDK `_handleDirectMessage` dispatches joined / player_joined /
  // player_left / snapshots / pong / match_end / error — but has NO dispatch
  // path for `phase` frames (they are silently dropped). Phase is also in
  // every snapshot header, so gameplay survives without this, but countdown_ms
  // only travels on the phase frame. We patch the handler: peek `phase`,
  // forward everything else untouched. Patch is safe any time — ws.onmessage
  // looks the method up dynamically on each frame.
  function patchPhaseDispatch() {
    const game = Usion.game;
    if (game.__tiltRoyalePhasePatch) return;
    const orig = game._handleDirectMessage.bind(game);
    game._handleDirectMessage = function (raw) {
      try {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (data && data.type === 'phase') {
          bus.emit('net:phase', data.payload || {});
          return;
        }
      } catch (e) { /* fall through — let the SDK handle/ignore it */ }
      orig(raw);
    };
    game.__tiltRoyalePhasePatch = true;
  }

  return {
    mode: 'platform',
    identity,

    async start() {
      bus.emit('net:status', { state: 'connecting' });
      await Usion.init({ timeout: 15_000 }); // rejects INIT_TIMEOUT if host silent
      identity.userId = Usion.user.getId();
      identity.userName = Usion.user.getName();
      patchPhaseDispatch();

      const g = Usion.game;
      // Snapshots MUST come via onRealtime (not game.on('realtime')): only the
      // router's _userRealtime slot passes through simulateNetwork's inbound
      // wrap, so the debug chaos panel degrades what we actually render.
      g.onRealtime((payload) => bus.emit('net:snapshot', payload));
      g.on('joined', (p) => {
        bus.emit('net:joined', p);
        // Introduce our display name — platform RS256 tokens carry no name
        // claim, so the server would otherwise label us by raw user id.
        // Rides the realtime channel as action_type 'hello' (PROTOCOL.md).
        try {
          const n = Usion.user && Usion.user.getName && Usion.user.getName();
          if (n) g.realtime('hello', { name: String(n).slice(0, 24) });
        } catch { /* cosmetic — never block joining on it */ }
      });
      g.on('playerJoined', (p) => bus.emit('net:playerJoined', p));
      g.on('playerLeft', (p) => bus.emit('net:playerLeft', p));
      g.on('finished', (p) => bus.emit('net:matchEnd', p));
      g.on('error', (p) => bus.emit('net:error', p || {}));
      // pong frames are dispatched as 'sync' by the SDK's direct transport.
      g.on('sync', (p) => bus.emit('net:pong', p || {}));
      g.on('disconnect', () => bus.emit('net:status', { state: 'reconnecting' }));
      g.on('reconnect', () => {
        // SDK has already re-joined + requestSync()ed; receiver re-arms on the
        // fresh unicast joined/keyframe.
        bus.emit('net:status', { state: 'connected' });
        bus.emit('net:reconnected', {});
      });

      // Solo → multiplayer promotion (SDK ≥ 2.20): if the user opened the
      // game without a room and later taps the host's Share button, the host
      // assigns a room — connect then. Idempotent if already connected.
      g.onRoomAssigned(() => {
        g.connectDirect({ roomId: Usion.config.roomId, serviceId: Usion.config.serviceId || SERVICE_ID })
          .then(() => bus.emit('net:status', { state: 'connected' }))
          .catch((e) => bus.emit('net:error', { code: 'CONNECT_FAILED', message: String(e && e.message) }));
      });

      if (!Usion.config.roomId) {
        // Solo launch with no auto-room: stay idle in the lobby; the
        // onRoomAssigned hook above completes the connection after Share.
        bus.emit('net:status', { state: 'idle' });
        return;
      }
      // connectDirect fetches room access (via the host when embedded), opens
      // the WS, sends `join` on open, and heartbeats — nothing else to do.
      await g.connectDirect({ roomId: Usion.config.roomId, serviceId: Usion.config.serviceId || SERVICE_ID });
      bus.emit('net:status', { state: 'connected' });
    },

    send(type, payload) {
      // Direct mode wire shape of realtime(): {type:'input', payload:
      // {action_type, action_data}} — exactly the PROTOCOL `input` frame.
      Usion.game.realtime(type, payload);
    },

    requestKeyframe(lastS) { Usion.game.requestSync(lastS || 0); },
    ping() { return Usion.game.ping(); },
    setNetworkSim(simOpts) { Usion.game.simulateNetwork(simOpts); },
    isConnected() { return Usion.game.isConnected(); },
  };
}

/* ------------------------------------------------------------ local dev -- */

function localConnection({ bus, roomId, playerName }) {
  // Dev tokens must match the server's /^dev:[\w-]+:[\w-]+$/ — sanitize free-
  // text names (spaces, Cyrillic, emoji) instead of failing auth.
  const safeName = (playerName || 'player').replace(/[^\w-]/g, '-').slice(0, 24) || 'player';
  const identity = { userId: safeName, userName: playerName || safeName };
  const token = 'dev:' + safeName + ':' + roomId;
  const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const url = scheme + location.host + '/ws?token=' + encodeURIComponent(token);

  let ws = null;
  let seq = 0;                 // transport-monotonic per connection (envelope.seq)
  let closedByUs = false;
  let attempt = 0;
  let heartbeatTimer = null;
  let pongWaiters = [];        // {t, resolve, timer} matched by echoed `t`
  let sim = null;              // NetworkSim instance from the SDK (debug panel)

  function envelope(type, payload) {
    seq += 1;
    return JSON.stringify({
      type,
      room_id: roomId,
      ts: Date.now(),
      seq,
      session_id: null,          // dev tokens carry no platform session
      protocol_version: '2',
      payload: payload || {},
    });
  }

  function rawSend(type, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(envelope(type, payload));
  }
  let sendFn = rawSend;

  function dispatch(data) {
    const p = data.payload || {};
    switch (data.type) {
      case 'joined':
        bus.emit('net:joined', p);
        // Same hello as platform mode (identical server path).
        rawSend('input', { action_type: 'hello', action_data: { name: identity.userName.slice(0, 24) } });
        break;
      case 'player_joined': bus.emit('net:playerJoined', p); break;
      case 'player_left': bus.emit('net:playerLeft', p); break;
      case 'phase': bus.emit('net:phase', p); break;
      case 'state_snapshot':
      case 'state_delta': bus.emit('net:snapshot', p); break;
      case 'match_end': bus.emit('net:matchEnd', p); break;
      case 'error': bus.emit('net:error', p); break;
      case 'pong': {
        if (p.t !== undefined) {
          const i = pongWaiters.findIndex((w) => w.t === p.t);
          if (i >= 0) { const w = pongWaiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(Date.now() - w.t); }
        }
        bus.emit('net:pong', p);
        break;
      }
      default: break; // unknown server frames are ignored, like the SDK does
    }
  }
  let dispatchFn = dispatch;

  function open() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      seq = 0; // seq is per-connection, like the SDK's _directSeq
      sendFn('join', {});
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => sendFn('heartbeat', {}), HEARTBEAT_MS);
      bus.emit('net:status', { state: 'connected' });
      if (attemptWasReconnect) bus.emit('net:reconnected', {});
      attemptWasReconnect = true; // every subsequent open is a reconnect
    };
    ws.onmessage = (evt) => {
      let data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      if (data && data.type) dispatchFn(data);
    };
    ws.onclose = () => {
      clearInterval(heartbeatTimer);
      if (closedByUs) return;
      bus.emit('net:status', { state: 'reconnecting' });
      // Capped exponential backoff, mirroring the SDK's direct reconnect.
      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
      setTimeout(() => { if (!closedByUs) open(); }, delay);
    };
    ws.onerror = () => { /* onclose handles recovery */ };
  }
  let attemptWasReconnect = false;

  return {
    mode: 'local',
    identity,

    start() {
      bus.emit('net:status', { state: 'connecting' });
      return new Promise((resolve) => {
        const off = bus.on('net:status', (s) => { if (s.state === 'connected') { off(); resolve(); } });
        open();
      });
    },

    send(type, payload) { sendFn(type, payload); },

    // Server contract: ping{last_sequence} → pong + unicast fresh keyframe.
    requestKeyframe(lastS) { sendFn('ping', { last_sequence: lastS || 0 }); },

    /** Manual RTT probe (the SDK PingMeter path needs directMode). */
    ping() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
      return new Promise((resolve) => {
        const t = Date.now();
        const timer = setTimeout(() => {
          pongWaiters = pongWaiters.filter((w) => w.t !== t);
          resolve(null);
        }, PING_TIMEOUT_MS);
        pongWaiters.push({ t, resolve, timer });
        sendFn('ping', { t });
      });
    },

    /**
     * Chaos testing in local mode: we reuse the SDK's NetworkSim (returned by
     * game.simulateNetwork) and wrap OUR send/dispatch with it, so the debug
     * sliders behave identically in both modes. (The side effect on the SDK's
     * unused realtime() is harmless here.)
     */
    setNetworkSim(simOpts) {
      if (!simOpts) {
        Usion.game.simulateNetwork(null);
        sim = null; sendFn = rawSend; dispatchFn = dispatch;
        return;
      }
      sim = Usion.game.simulateNetwork(simOpts);
      sendFn = sim.wrap(rawSend);
      dispatchFn = sim.wrap(dispatch);
    },

    isConnected() { return !!ws && ws.readyState === WebSocket.OPEN; },
  };
}
