// Environment surface for the server. ALL process.env access lives here so
// every other module is env-free (and therefore unit-testable). Shared
// gameplay constants are re-exported for convenience — server modules import
// numbers from here OR from ../shared/constants.js, never hardcode them.
export * from '../shared/constants.js';

const env = process.env;

const bool = (v) => v === '1' || v === 'true' || v === 'yes';

export const PORT = Number(env.PORT || 3009);
export const NODE_ENV = env.NODE_ENV || 'development';
export const IS_PROD = NODE_ENV === 'production';

/** Dev-only auth bypass: accept `dev:<user_id>:<room_id>` tokens. */
export const DEV_ALLOW_UNSIGNED = bool(env.DEV_ALLOW_UNSIGNED || '');
/** Fill a lonely waiting room with a server-side bot after 5 s. */
export const BOT_FILL = bool(env.BOT_FILL || '');

export const SERVICE_ID = env.SERVICE_ID || 'tilt-royale';
export const API_URL = (env.API_URL || 'https://mobile.mongolai.mn').replace(/\/$/, '');
export const JWKS_URL = env.JWKS_URL || `${API_URL}/.well-known/jwks.json`;
export const SIGNING_KEY_ID = env.SIGNING_KEY_ID || 'tilt-royale-key-1';
export const SIGNING_SECRET = env.SIGNING_SECRET || 'change-me';

// A production box with the unsigned bypass enabled would let anyone join as
// anyone. Refuse to boot rather than log-and-continue: fail loud, fail early.
if (DEV_ALLOW_UNSIGNED && IS_PROD) {
  console.error(
    '[CONFIG] FATAL: DEV_ALLOW_UNSIGNED is set while NODE_ENV=production. ' +
    'This would disable authentication for real users. Unset DEV_ALLOW_UNSIGNED ' +
    '(or run with NODE_ENV=development for local work). Exiting.'
  );
  process.exit(1);
}
