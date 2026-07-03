// HTTP + WebSocket entry point.
//
// - Static: client/ at /, shared/ at /shared (the client imports the shared
//   sim modules directly — same bytes the server runs).
// - GET /health for the Railway healthcheck.
// - WS upgrades ONLY on /ws. A connection is authenticated BEFORE any game
//   message is processed: messages arriving during async JWT verification
//   are buffered and replayed (space-craft pattern) so the SDK's eager
//   `join` on open is never lost.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import {
  PORT, NODE_ENV, SERVICE_ID, JWKS_URL, DEV_ALLOW_UNSIGNED, BOT_FILL,
  INPUT_RATE_LIMIT_PER_S,
} from './config.js';
import { validateAccessToken } from './auth.js';
import { Room } from './room.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT_DIR = path.join(ROOT, 'client');
const SHARED_DIR = path.join(ROOT, 'shared');

const RATE_BURST = 10; // token bucket: capacity 10, refill INPUT_RATE_LIMIT_PER_S/s

const rooms = new Map();

process.on('unhandledRejection', (reason) => console.error('[PROCESS] unhandledRejection', reason));
process.on('uncaughtException', (err) => console.error('[PROCESS] uncaughtException', err));

// ------------------------------------------------------------------ http ----

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', // correct type or module imports fail
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

/**
 * Serve one file from `rootDir`, refusing anything that resolves outside it
 * (directory-traversal guard: resolve first, compare prefixes after).
 */
async function serveStatic(res, rootDir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(rootDir, '.' + path.posix.normalize(rel));
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // small game, always-fresh beats stale bugs
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      uptime_s: Math.floor(process.uptime()),
      // Which physical region this replica runs in — the point of a
      // geo-distributed game server is being close to players, so surface it.
      region: process.env.RAILWAY_REPLICA_REGION || process.env.RAILWAY_REGION || 'local',
    }));
    return;
  }
  if (url.pathname === '/shared' || url.pathname.startsWith('/shared/')) {
    serveStatic(res, SHARED_DIR, url.pathname.slice('/shared'.length) || '/');
    return;
  }
  serveStatic(res, CLIENT_DIR, url.pathname);
});

// -------------------------------------------------------------- websocket ---

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://localhost:${PORT}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

const sendError = (ws, code, message) => {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ type: 'error', payload: { code, message } })); } catch { /* noop */ }
};

/** Token bucket: capacity RATE_BURST, refills at INPUT_RATE_LIMIT_PER_S/s. */
function takeToken(conn) {
  const now = Date.now();
  conn.tokens = Math.min(
    RATE_BURST,
    conn.tokens + ((now - conn.tokensRefilledAt) / 1000) * INPUT_RATE_LIMIT_PER_S
  );
  conn.tokensRefilledAt = now;
  if (conn.tokens < 1) return false;
  conn.tokens -= 1;
  return true;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  const conn = {
    ws,
    userId: null, name: null, sessionId: null,
    spectator: false,
    lastSeenMs: Date.now(),
    lastSeq: 0,
    tokens: RATE_BURST, tokensRefilledAt: Date.now(),
    rateWarned: false,
    ewmaOneWayMs: null,
    room: null,
  };

  let authComplete = false;
  const buffered = [];

  const routeMessage = (msg) => {
    // Envelope seq guard: transport-monotonic per connection; stale or
    // duplicate frames (WS reorder can't happen, but SDK resends can) drop.
    const seq = Number(msg?.seq);
    if (Number.isFinite(seq) && seq > 0) {
      if (seq <= conn.lastSeq) return;
      conn.lastSeq = seq;
    }
    conn.room?.handleMessage(conn, msg);
  };

  ws.on('message', (data) => {
    conn.lastSeenMs = Date.now();
    if (!takeToken(conn)) {
      // First strike warns; a client still flooding after the warning is
      // hostile or broken — cut it off.
      if (conn.rateWarned) { try { ws.close(); } catch { /* noop */ } return; }
      conn.rateWarned = true;
      sendError(ws, 'RATE_LIMITED', `Max ${INPUT_RATE_LIMIT_PER_S} msg/s (burst ${RATE_BURST})`);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      sendError(ws, 'BAD_MESSAGE', 'Frames must be JSON');
      return;
    }
    if (!authComplete) { buffered.push(msg); return; }
    routeMessage(msg);
  });

  ws.on('close', () => { conn.room?.detachConn(conn); });
  ws.on('error', (err) => console.error('[WS] socket_error', err?.message || err));

  if (!token) {
    sendError(ws, 'INVALID_TOKEN', 'Missing access token');
    try { ws.close(); } catch { /* noop */ }
    return;
  }

  validateAccessToken(token, { jwksUrl: JWKS_URL, serviceId: SERVICE_ID })
    .then((identity) => {
      if (ws.readyState !== 1) return;
      conn.userId = identity.sub;
      conn.name = identity.name;
      conn.sessionId = identity.session_id;

      let room = rooms.get(identity.room_id);
      if (!room) {
        room = new Room(identity.room_id, { onDestroy: (id) => rooms.delete(id) });
        rooms.set(identity.room_id, room);
        console.log(`[ROOM ${identity.room_id}] created (rooms=${rooms.size})`);
      }
      conn.room = room;

      authComplete = true;
      for (const msg of buffered) routeMessage(msg);
      buffered.length = 0;
    })
    .catch((err) => {
      console.error('[WS] auth_failed', err?.message || err);
      sendError(ws, 'INVALID_TOKEN', err?.message || 'Invalid token');
      try { ws.close(); } catch { /* noop */ }
    });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[TILT-ROYALE] listening on 0.0.0.0:${PORT} env=${NODE_ENV} service=${SERVICE_ID}`);
  console.log(`[TILT-ROYALE] dev_unsigned=${DEV_ALLOW_UNSIGNED} bot_fill=${BOT_FILL} jwks=${JWKS_URL}`);
});
