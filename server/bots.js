// Server-side bot fill — one dev (or one lonely player) can start a round.
//
// The bot is an ordinary roster player (a slot in the sim, always
// `connected`), driven by a 10 Hz think function instead of a socket. Any
// match a bot touched is NEVER submitted to the platform (webhook.js skips
// on hadBot) — bots must not mint leaderboard entries.
import { ARENA, MAX_PLAYERS, WEAPON_NONE } from '../shared/constants.js';
import { BOT_FILL } from './config.js';
import { clamp, dist } from './game/util.js';

export const BOT_USER_ID = 'bot-1';
export const BOT_NAME = 'Bot';
/** Lone human waits this long before a bot fills the room. */
export const BOT_FILL_AFTER_MS = 5_000;
/** Bot decisions run at 10 Hz (every 6th sim tick at 60 Hz). */
export const BOT_THINK_EVERY_SIM_TICKS = 6;
const BOT_MIN_FIRE_GAP_MS = 800;
const FLEE_RADIUS = 25;      // dots inside this repel the bot
const SAFE_RADIUS = 12;      // no dot this close → safe to chase orbs
const FIRE_RANGE = 30;       // rival/cluster distance worth a shot
const WALL_MARGIN = 18;      // start steering off walls here — corners kill

export const isBot = (p) => !!p?.bot;
export const roomHasBot = (room) => room.state.players.some(isBot);
const humanCount = (room) => room.state.players.filter((p) => !p.bot).length;

/**
 * (Re)evaluate the fill timer. Called by the room on every roster change:
 * arms a 5 s timer when exactly one human is waiting alone, cancels it the
 * moment the condition breaks (second human joined, or the human left).
 * @param {import('./room.js').Room} room
 */
export function evaluateFill(room) {
  // Gated on BOT_FILL — dev convenience ONLY. With the flag off (production)
  // a lone player waits for their real opponent. A bot that fills a prod
  // room starts the round before the invited player arrives, turning them
  // into a spectator (this shipped once: "we are not seeing the other
  // player" — the flag existed but this check was missing).
  const eligible =
    BOT_FILL && room.phase === 'waiting' && humanCount(room) === 1 && !roomHasBot(room);
  if (!eligible && room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
  if (eligible && !room.botTimer) {
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      // Conditions may have changed while the timer ran — recheck.
      if (room.phase === 'waiting' && humanCount(room) === 1 &&
          !roomHasBot(room) && room.state.players.length < MAX_PLAYERS) {
        room.addBotPlayer();
      }
    }, BOT_FILL_AFTER_MS);
    room.botTimer.unref?.();
  }
}

/**
 * A bot never blocks a paying 4th human: if the roster is full and a bot
 * holds a slot pre-round, the room evicts it before seating the human.
 * @returns {number|null} the freed bot slot, or null
 */
export function botSlotToEvict(room) {
  if (room.state.players.length < MAX_PLAYERS) return null;
  const bot = room.state.players.find(isBot);
  return bot ? bot.slot : null;
}

/**
 * Compute one bot decision. Pure — reads sim state, returns intent.
 * Priorities: survive (flee the local dot field with linear-falloff weights
 * — inverse-square collapses to noise at mid range, which is exactly where
 * dodging decisions are made), avoid walls (a cornered arrow has no escape
 * vector), then arm up (drift to the nearest orb when no dot is close),
 * then shoot (rival or dot clump in range, ≥ 800 ms between taps).
 * @returns {{mx:number,my:number,fire:boolean}}
 */
export function think(state, bot) {
  let mx = 0;
  let my = 0;

  let nearestDotD = Infinity;
  for (const d of state.dots) {
    const dd = dist(bot.x, bot.y, d.x, d.y);
    if (dd < nearestDotD) nearestDotD = dd;
    if (dd < FLEE_RADIUS && dd > 0.001) {
      const w = (FLEE_RADIUS - dd) / FLEE_RADIUS; // 1 at contact → 0 at edge
      mx += ((bot.x - d.x) / dd) * w * w * 3;     // quadratic urgency
      my += ((bot.y - d.y) / dd) * w * w * 3;
    }
  }

  // Wall repulsion, scaled by how threatened we are — hugging a wall halves
  // the escape directions, and fleeing INTO a wall is the classic bot death.
  const urgency = nearestDotD < FLEE_RADIUS ? 1.5 : 0.4;
  if (bot.x < WALL_MARGIN) mx += ((WALL_MARGIN - bot.x) / WALL_MARGIN) * urgency;
  if (bot.x > ARENA - WALL_MARGIN) mx -= ((bot.x - (ARENA - WALL_MARGIN)) / WALL_MARGIN) * urgency;
  if (bot.y < WALL_MARGIN) my += ((WALL_MARGIN - bot.y) / WALL_MARGIN) * urgency;
  if (bot.y > ARENA - WALL_MARGIN) my -= ((bot.y - (ARENA - WALL_MARGIN)) / WALL_MARGIN) * urgency;

  if (nearestDotD > SAFE_RADIUS && state.orbs.length && bot.weapon === WEAPON_NONE) {
    const orb = state.orbs.reduce((a, b) =>
      (dist(bot.x, bot.y, b.x, b.y) < dist(bot.x, bot.y, a.x, a.y) ? b : a));
    const dd = dist(bot.x, bot.y, orb.x, orb.y) || 1;
    mx += ((orb.x - bot.x) / dd) * 0.6;
    my += ((orb.y - bot.y) / dd) * 0.6;
  }

  // Gentle centering (60,60 is arena center for ARENA=120).
  mx += (60 - bot.x) * 0.004;
  my += (60 - bot.y) * 0.004;

  // Never press into a wall we are already touching — a pinned flee vector
  // wastes its whole magnitude on an impossible direction; convert it into
  // a slide toward open ground instead.
  if (bot.x < 6 && mx < 0) mx = 0.3;
  if (bot.x > ARENA - 6 && mx > 0) mx = -0.3;
  if (bot.y < 6 && my < 0) my = 0.3;
  if (bot.y > ARENA - 6 && my > 0) my = -0.3;

  let fire = false;
  if (bot.weapon !== WEAPON_NONE) {
    const rival = state.players.find((p) => p.alive && p.slot !== bot.slot &&
      dist(bot.x, bot.y, p.x, p.y) < FIRE_RANGE);
    const clump = state.dots.length >= 3 && nearestDotD < FIRE_RANGE * 0.7;
    fire = !!rival || clump;
  }

  return { mx: clamp(mx, -1, 1), my: clamp(my, -1, 1), fire };
}

/**
 * Drive all bot players for one think tick: write latest input, queue a fire
 * tap when armed and the min gap has passed. Called by the room at 10 Hz.
 */
export function tickBots(room) {
  for (const p of room.state.players) {
    if (!p.bot || !p.alive) continue;
    const mem = room.botMem;
    const intent = think(room.state, p);
    p.input = { mx: intent.mx, my: intent.my };
    if (intent.fire && room.state.timeMs - mem.lastFireMs >= BOT_MIN_FIRE_GAP_MS) {
      mem.lastFireMs = room.state.timeMs;
      p.fires.push({ fs: mem.fireSeq++ });
    }
  }
}
