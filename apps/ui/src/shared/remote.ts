/**
 * The LAN gateway's WIRE contract — route paths, security headers, and the
 * request/response shapes BOTH processes read: Electron main (which owns the
 * gateway itself, in `main/remote/`) and the renderer (which calls it from a
 * browser tab — real Electron or a paired phone). Everything here is safe
 * for the renderer bundle to carry.
 *
 * `main/remote/remote.types.ts` holds the other half — the main-only
 * operational tuning (rate limits, TTLs, the preferred port) the renderer
 * never needs and this file must stay free of, since a `node:` import here
 * would break the renderer build with no rule to catch it.
 */

/** How many digits a pairing code carries. */
export const PAIRING_CODE_LENGTH = 6;

/** The cookie a paired device presents on every later request. */
export const REMOTE_SESSION_COOKIE = 'geniro_remote';

/**
 * The header a bridge call must carry. See `remote-routes.ts`'s `bridge()`
 * for why (the CSRF rationale lives there, beside the check).
 */
export const REMOTE_CSRF_HEADER = 'x-geniro-remote';

/**
 * Routes the gateway answers itself rather than proxying or serving.
 *
 * Prefixed so it can never collide with a daemon route (`/v1/…`, `/ws`) or a
 * file in the renderer bundle, which is what makes "proxy everything I do not
 * recognise" a safe default instead of a guess.
 */
export const REMOTE_ROUTE_PREFIX = '/__geniro';
export const REMOTE_ROUTE_SESSION = `${REMOTE_ROUTE_PREFIX}/session`;
export const REMOTE_ROUTE_PAIR = `${REMOTE_ROUTE_PREFIX}/pair`;
export const REMOTE_ROUTE_BRIDGE = `${REMOTE_ROUTE_PREFIX}/bridge`;
export const REMOTE_ROUTE_EVENTS = `${REMOTE_ROUTE_PREFIX}/events`;

/** One device that has paired, as the registry stores it. */
export interface RemoteDevice {
  /** Opaque id, minted with the device's session token. */
  id: string;
  /**
   * The session token's hash, never the token. The file sits in userData
   * beside `daemon.json`, and a readable token is a standing key to the whole
   * daemon; a hash cannot be replayed.
   */
  tokenHash: string;
  /** What the device called itself — its user agent, trimmed. */
  label: string;
  pairedAt: string;
  lastSeenAt: string;
}

/** What Settings draws, and what the "open in browser" action builds a link from. */
export interface RemoteAccessState {
  /** The user's switch (`Settings.remoteAccessEnabled`). */
  enabled: boolean;
  /** Whether the listener is actually up — a bind can fail with the switch on. */
  listening: boolean;
  /** The bound port, or null when nothing is listening. */
  port: number | null;
  /**
   * `http://<hostname>.local:<port>` — the primary link. macOS publishes the
   * machine's own `.local` name over Bonjour with no help from this app, so
   * there is no responder to run and nothing to register.
   */
  hostUrl: string | null;
  /**
   * `http://<lan-ipv4>:<port>` — the fallback, for a network where `.local`
   * does not resolve (some Android builds, some guest networks). Both are
   * shown, because neither works everywhere.
   */
  addressUrl: string | null;
  /** The code a new device must type, and when it rotates. */
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  /** Devices that have paired, newest first. */
  devices: RemoteDevice[];
  /** Why nothing is listening, when that is the case. */
  unavailableReason: string | null;
}

/** What a paired browser is told about itself. */
export interface RemoteSessionState {
  paired: boolean;
  deviceId: string | null;
}

/**
 * A pairing attempt that did NOT succeed — the one shape `remote-routes.ts`
 * writes and `remote-session.ts` reads, imported by both so a route's wording
 * and the screen's parse of it cannot drift into two different fields again.
 * `retryAfterMs` is set only for a lockout refusal.
 */
export interface PairingRefusal {
  message: string;
  retryAfterMs?: number;
}

/**
 * A bridge call refused because the channel is native-only.
 *
 * It is a SHAPE rather than a message so the renderer can tell it from a
 * transport failure: a refusal is permanent and the UI disables the control,
 * while a failure is worth retrying. `code` is what the shim matches on.
 */
export interface RemoteRefusal {
  code: 'REMOTE_CHANNEL_DENIED';
  channel: string;
  reason: string;
}

/** One bridge call, as the browser sends it. */
export interface RemoteBridgeRequest {
  channel: string;
  args: unknown[];
}

/** One bridge reply. Exactly one of `value` / `error` / `refusal` is set. */
export interface RemoteBridgeResponse {
  value?: unknown;
  error?: string;
  refusal?: RemoteRefusal;
}
