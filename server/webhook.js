// Signed match-result submission (server → platform, not the socket).
//
// The platform trusts this POST because it is HMAC-signed with the shared
// secret from the service's registry `realtime.signing` config. Canonical
// string (see PROTOCOL.md): `timestamp\nPOST\n/games/direct/results\nsha256hex(body)`.
// Idempotency-Key makes retries safe on the platform side.
import crypto from 'crypto';
import { API_URL, SERVICE_ID, SIGNING_KEY_ID, SIGNING_SECRET } from './config.js';

const RESULT_PATH = '/games/direct/results';
const RETRY_BACKOFF_MS = [1_000, 3_000, 9_000];

function signCanonical(secret, timestamp, bodyBytes) {
  const bodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  const canonical = `${timestamp}\nPOST\n${RESULT_PATH}\n${bodyHash}`;
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * POST the finished match to the platform. Retries transient failures with
 * backoff; logs the outcome either way (a lost result is a support ticket).
 *
 * Skipped entirely (log only) when a bot played — bot matches must never
 * touch real leaderboards/wallets — or when SIGNING_SECRET is still the
 * placeholder, which means this deploy is not registry-paired yet.
 *
 * @param {{
 *   roomId: string, sessionId: string, winnerIds: string[],
 *   participants: string[], reason: string, finalStats: object,
 *   hadBot: boolean,
 * }} args
 * @returns {Promise<object|null>} platform response JSON, or null when skipped/failed
 */
export async function submitMatchResult({
  roomId, sessionId, winnerIds, participants, reason, finalStats, hadBot,
}) {
  if (hadBot) {
    console.log(`[WEBHOOK] skip (bot participated) room=${roomId} reason=${reason}`);
    return null;
  }
  if (!SIGNING_SECRET || SIGNING_SECRET === 'change-me') {
    console.log(`[WEBHOOK] skip (SIGNING_SECRET unset) room=${roomId} reason=${reason}`);
    return null;
  }

  const body = {
    room_id: roomId,
    session_id: sessionId,
    service_id: SERVICE_ID,
    winner_ids: winnerIds,
    participants,
    reason,
    final_stats: finalStats,
    ended_at: new Date().toISOString(),
  };
  const bodyBytes = Buffer.from(JSON.stringify(body), 'utf-8');
  // One idempotency key across all retry attempts — retries must dedupe.
  const idempotencyKey = crypto.randomUUID();

  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    // Timestamp + signature are re-minted per attempt so a slow retry does
    // not fall outside the platform's timestamp-freshness window.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'X-Usion-Service-Id': SERVICE_ID,
      'X-Usion-Key-Id': SIGNING_KEY_ID,
      'X-Usion-Signature': signCanonical(SIGNING_SECRET, timestamp, bodyBytes),
      'X-Usion-Timestamp': timestamp,
      'X-Idempotency-Key': idempotencyKey,
    };
    try {
      const response = await fetch(`${API_URL}${RESULT_PATH}`, {
        method: 'POST', headers, body: bodyBytes,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      const result = await response.json();
      console.log(
        `[WEBHOOK] result submitted room=${roomId} match=${result.match_id} duplicate=${!!result.duplicate}`
      );
      return result;
    } catch (err) {
      lastErr = err;
      const backoff = RETRY_BACKOFF_MS[attempt];
      if (backoff === undefined) break;
      console.warn(`[WEBHOOK] attempt ${attempt + 1} failed room=${roomId}: ${err.message} — retry in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  console.error(`[WEBHOOK] FAILED after retries room=${roomId}: ${lastErr?.message || lastErr}`);
  return null;
}
