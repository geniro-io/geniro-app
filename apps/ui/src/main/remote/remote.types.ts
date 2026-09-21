/**
 * The LAN gateway's MAIN-ONLY operational tuning — rate limits, TTLs, the
 * preferred port. Nothing here reaches the renderer bundle; the wire
 * contract both processes read (route paths, headers, the request/response
 * shapes) lives in `shared/remote.ts` instead.
 *
 * WHY THIS LIVES IN MAIN AND NOT IN THE DAEMON. The daemon binds `127.0.0.1`
 * only, and that is a hard project constraint (root `CLAUDE.md` →
 * *Constraints*). Nothing here changes it: the gateway is a SECOND listener,
 * owned by the Electron main process, that serves the renderer bundle and
 * reverse-proxies to the daemon over loopback. So the whole of this app's
 * LAN-facing surface is this directory, and the daemon's own rule stays
 * literally true.
 *
 * Main also owns the two things a phone needs that the daemon cannot give it:
 * the renderer bundle (`out/renderer`, an artifact of THIS app) and the
 * `window.geniro` bridge, which is main-process IPC and has no daemon side at
 * all.
 */

/**
 * The port the gateway prefers, one above the daemon's own `47615`.
 *
 * Deterministic rather than negotiated, because the user TYPES this into a
 * phone: a port that moved every launch would make the link unmemorable and
 * every printed QR stale. A busy port still falls back to a free one — the
 * bound value is what every link is built from.
 */
export const REMOTE_PREFERRED_PORT = 47616;

/**
 * Wrong codes a device may offer before it is locked out, and for how long.
 *
 * A six-digit code is a million values, which is plenty against a human and
 * nothing against a script — so the bound that matters is the RATE, not the
 * length. The lockout is per remote address, since that is the only stable
 * thing about an unpaired caller.
 */
export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_LOCKOUT_MS = 5 * 60_000;

/**
 * Wrong codes across ALL addresses before pairing is shut for everyone.
 *
 * The per-address bound above is the one that reads naturally, and on its own
 * it is not a bound at all: an attacker on the same network picks a new source
 * address whenever they run out of attempts, which on IPv6 costs nothing, so
 * five tries per address is five tries per TRY. This is the ceiling that
 * actually holds a six-digit secret — and tripping it ROTATES the code, so the
 * value being guessed at stops existing rather than merely becoming
 * temporarily unguessable.
 */
export const PAIRING_MAX_GLOBAL_ATTEMPTS = 20;

/**
 * How many addresses the attempt table remembers.
 *
 * Same reasoning from the other side: the table is keyed by something the
 * caller chooses, so without a cap an unauthenticated stranger can grow it for
 * as long as the app runs. The oldest entry goes first, which is the safe
 * direction — an evicted attacker is still held by the global ceiling, while
 * an evicted innocent merely gets their attempts back.
 */
export const PAIRING_MAX_TRACKED_ADDRESSES = 256;

/**
 * How long a pairing code stands before it is replaced.
 *
 * It rotates rather than living for the session because it is shown on screen:
 * a code that never changed would be readable by anyone who ever glanced at
 * that settings page, for as long as the app runs.
 */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
