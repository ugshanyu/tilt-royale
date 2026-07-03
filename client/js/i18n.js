/**
 * Tilt Royale — i18n. EVERY user-facing string flows through t().
 * Language pick order: ?lang= override → Usion host language → navigator.
 * English is the fallback for missing keys (never show raw keys to users).
 */

const STRINGS = {
  en: {
    'app.title': 'Tilt Royale',
    'lobby.subtitle': 'Tilt to dodge. Tap to fire. Last arrow standing wins.',
    'lobby.ready': 'Ready',
    'lobby.waiting': 'Waiting for players…',
    'lobby.players': '{n}/{max} players',
    'lobby.inviteHint': 'Invite friends from the chat to fill the room.',
    'lobby.you': 'you',
    'lobby.openSeat': 'open seat',
    'lobby.starting': 'Starting soon…',
    'calib.hold': 'Hold your phone still…',
    'calib.done': 'Calibrated',
    'tilt.denied': 'Motion access denied — drag on screen or use WASD/arrows instead.',
    'tilt.insecure': 'Tilt needs HTTPS — falling back to touch/keyboard.',
    'countdown.go': 'GO!',
    'hud.left': '{n} left',
    'hud.rtt': '{ms} ms',
    'hud.mute': 'Toggle sound',
    'weapon.none': 'Unarmed',
    'weapon.wave': 'Shockwave',
    'weapon.scatter': 'Scatter',
    'weapon.seeker': 'Seeker',
    'spectate.banner': 'You’re out — spectating',
    'spectate.watching': 'Round in progress — watching',
    'death.you': 'You’re out!',
    'results.title': 'Results',
    'results.winner': 'Winner',
    'results.draw': 'Draw',
    'results.player': 'Player',
    'results.score': 'Score',
    'results.kos': 'KOs',
    'results.dots': 'Dots',
    'results.combo': 'Combo',
    'results.survival': 'Survived',
    'results.playAgain': 'Play again',
    'results.close': 'Back to chat',
    'results.reason.elimination': 'Last one standing',
    'results.reason.timeout': 'Time’s up — highest score wins',
    'results.reason.opponents_left': 'Opponents left the match',
    'results.reason.error': 'Match ended unexpectedly',
    'conn.connecting': 'Connecting…',
    'conn.reconnecting': 'Reconnecting…',
    'conn.lost': 'Connection lost',
    'conn.roomFull': 'Room is full — watching as a spectator.',
    'error.generic': 'Something went wrong: {msg}',
    'error.noPhaser': 'Failed to load the game engine. Check your connection and reload.',
    'error.noSdk': 'Failed to load the Usion SDK. Check your connection and reload.',
    'local.enterName': 'Enter a player name',
    'sec.left': '{s}s',
  },
  mn: {
    'app.title': 'Tilt Royale',
    'lobby.subtitle': 'Хазайлгаж зайлсхий, товшиж бууд. Сүүлчийн амьд үлдсэн нь ялна.',
    'lobby.ready': 'Бэлэн',
    'lobby.waiting': 'Тоглогчдыг хүлээж байна…',
    'lobby.players': 'Тоглогч {n}/{max}',
    'lobby.inviteHint': 'Чатаас найзуудаа урьж өрөөгөө дүүргээрэй.',
    'lobby.you': 'та',
    'lobby.openSeat': 'сул суудал',
    'lobby.starting': 'Удахгүй эхэлнэ…',
    'calib.hold': 'Утсаа хөдөлгөлгүй барина уу…',
    'calib.done': 'Тохирууллаа',
    'tilt.denied': 'Хөдөлгөөний мэдрэгчийн зөвшөөрөл өгөгдсөнгүй — дэлгэцээр чирэх эсвэл гар ашиглана уу.',
    'tilt.insecure': 'Хазайлтын мэдрэгчид HTTPS шаардлагатай — дэлгэц/гар руу шилжлээ.',
    'countdown.go': 'Гараа!',
    'hud.left': '{n} үлдлээ',
    'hud.rtt': '{ms} мс',
    'hud.mute': 'Дуу асаах/хаах',
    'weapon.none': 'Зэвсэггүй',
    'weapon.wave': 'Цохилтын долгион',
    'weapon.scatter': 'Сацрал',
    'weapon.seeker': 'Мөрдөгч пуужин',
    'spectate.banner': 'Та хасагдлаа — үзэж байна',
    'spectate.watching': 'Тоглолт үргэлжилж байна — үзэж байна',
    'death.you': 'Та хасагдлаа!',
    'results.title': 'Үр дүн',
    'results.winner': 'Ялагч',
    'results.draw': 'Тэнцээ',
    'results.player': 'Тоглогч',
    'results.score': 'Оноо',
    'results.kos': 'Устгал',
    'results.dots': 'Цэг',
    'results.combo': 'Цуврал',
    'results.survival': 'Амьд үлдсэн',
    'results.playAgain': 'Дахин тоглох',
    'results.close': 'Чат руу буцах',
    'results.reason.elimination': 'Сүүлчийн амьд үлдэгч',
    'results.reason.timeout': 'Хугацаа дуусав — өндөр оноотой нь ялна',
    'results.reason.opponents_left': 'Өрсөлдөгчид гарсан',
    'results.reason.error': 'Тоглолт гэнэт дууслаа',
    'conn.connecting': 'Холбогдож байна…',
    'conn.reconnecting': 'Дахин холбогдож байна…',
    'conn.lost': 'Холболт тасарлаа',
    'conn.roomFull': 'Өрөө дүүрсэн тул үзэгчээр нэгдлээ.',
    'error.generic': 'Алдаа гарлаа: {msg}',
    'error.noPhaser': 'Тоглоомын хөдөлгүүр ачааллагдсангүй. Сүлжээгээ шалгаад дахин ачаална уу.',
    'error.noSdk': 'Usion SDK ачааллагдсангүй. Сүлжээгээ шалгаад дахин ачаална уу.',
    'local.enterName': 'Тоглогчийн нэрээ оруулна уу',
    'sec.left': '{s}с',
  },
};

let lang = 'en';

/**
 * Pick the active language. Call once at boot, before any t() renders.
 * @param {{ urlLang?: string|null, hostLang?: string|null }} [opts]
 * @returns {string} the resolved language code
 */
export function initI18n(opts = {}) {
  const candidates = [
    opts.urlLang,
    opts.hostLang,
    typeof navigator !== 'undefined' ? navigator.language : null,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const code = String(c).toLowerCase().slice(0, 2);
    if (STRINGS[code]) { lang = code; break; }
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return lang;
}

/** @returns {string} active language code ('en' | 'mn'). */
export function getLang() { return lang; }

/**
 * Translate a key with {var} interpolation.
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  let s = STRINGS[lang][key];
  if (s === undefined) s = STRINGS.en[key];
  if (s === undefined) return key; // last resort — better than a blank UI
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      (vars[name] !== undefined ? String(vars[name]) : m));
  }
  return s;
}

/** Locale-aware number (scores). */
export function fmtNum(n) {
  try { return new Intl.NumberFormat(lang === 'mn' ? 'mn-MN' : undefined).format(n); }
  catch (e) { return String(n); }
}

/** mm:ss from milliseconds (round timers are locale-neutral). */
export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}
